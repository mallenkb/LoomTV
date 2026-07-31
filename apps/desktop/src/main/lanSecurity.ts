import os from 'node:os';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLanShareCode } from './settings';
import {
  hasValidLocalAccessToken,
  isLoopbackAddress,
  normalizeRemoteAddress,
  requestLanToken,
  timingSafeStringEqual,
} from './serverSecurity';
import {
  getLanCertificateFingerprint,
  getLanMediaServerPort,
} from './mediaServer';
import { getPrimaryLocalNetworkAddress } from './networkInfo';
import { checkPairRateLimit, recordPairFailure, recordPairSuccess, resetPairRateLimits } from './pairRateLimit';
import { HttpBodyError, readJsonBody, writeJson } from './httpResponses';
import { advertiseLanService, unadvertiseLanService } from './lanDiscovery';
import type { AppSettings, LanPairedDevice } from './appContracts.ts';

const MAX_SIGNED_LAN_URL_TTL_SECONDS = 15 * 60;
const IMAGE_CACHE_BUST_QUERY_PARAM = 'loomtvImageBust';
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAIRING_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRED_DEVICES = 64;
const DEVICE_SCOPES: LanPairedDevice['scopes'] = ['catalog:read', 'media:stream', 'playback:write'];

type SignedLanUrlOptions = {
  stable?: boolean;
};

export interface LanSecurityDeps {
  loadSettings: () => AppSettings;
  saveSettings: (settings: AppSettings) => void;
  localAccessToken: string;
  libraryForLocalNetwork: (profileId?: string, deviceId?: string) => unknown;
}

export function createLanSecurity(deps: LanSecurityDeps) {
  const { loadSettings, saveSettings, localAccessToken, libraryForLocalNetwork } = deps;
  let pairingSecretExpiresAt = 0;
  const requestAuthorizations = new WeakMap<IncomingMessage, { ok: boolean; device?: LanPairedDevice }>();

  function getRequestRemoteAddress(req: IncomingMessage): string {
    return normalizeRemoteAddress(req.socket.remoteAddress);
  }

  function isLoopbackRequest(req: IncomingMessage): boolean {
    return isLoopbackAddress(getRequestRemoteAddress(req));
  }

  function getLanServerBase(): string | null {
    const address = getPrimaryLocalNetworkAddress();
    const port = getLanMediaServerPort();
    return address && port ? `https://${address}:${port}` : null;
  }

  function isLanSharingEnabled(): boolean {
    return Boolean(loadSettings().localNetworkSharingEnabled);
  }

  function getLanShareToken(): string {
    const settings = loadSettings();
    if (
      settings.localNetworkShareToken
      && /^\d{6}$/.test(settings.localNetworkShareToken)
      && pairingSecretExpiresAt > Date.now()
    ) {
      return settings.localNetworkShareToken;
    }

    const token = createLanShareCode();
    pairingSecretExpiresAt = Date.now() + PAIRING_SESSION_TTL_MS;
    resetPairRateLimits();
    saveSettings({ ...settings, localNetworkShareToken: token });
    return token;
  }

  function tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  function getLanHmacSecret(): string {
    return loadSettings().localNetworkHmacSecret || '';
  }

  function requestToken(reqUrl: URL, req: IncomingMessage): string {
    return requestLanToken(reqUrl, req.headers);
  }

  function findPairedDeviceByToken(token: string): LanPairedDevice | null {
    if (!token) return null;
    const settings = loadSettings();
    const devices = settings.localNetworkPairedDevices || [];
    for (const device of devices) {
      if (
        device.securityEpoch === 2
        && device.accessTokenExpiresAt > Date.now()
        && timingSafeStringEqual(device.accessTokenHash, tokenHash(token))
      ) return device;
    }
    return null;
  }

  function touchPairedDevice(deviceId: string, address: string): void {
    const settings = loadSettings();
    const devices = settings.localNetworkPairedDevices || [];
    let changed = false;
    const updated = devices.map((device) => {
      if (device.id !== deviceId) return device;
      changed = true;
      return { ...device, lastSeenAt: Date.now(), lastAddress: address };
    });
    if (changed) saveSettings({ ...settings, localNetworkPairedDevices: updated });
  }

  function signLanPayload(payload: string): string {
    return createHmac('sha256', getLanHmacSecret()).update(payload).digest('hex');
  }

  function signedUrlStableNonce(pathname: string, params: URLSearchParams): string {
    return createHash('sha1').update(`${pathname}?${params.toString()}`).digest('hex').slice(0, 16);
  }

  function buildSignedLanUrl(
    base: string,
    pathname: string,
    params: URLSearchParams,
    ttlSeconds = 24 * 60 * 60,
    options: SignedLanUrlOptions = {},
  ): string {
    const boundedTtl = Math.max(1, Math.min(ttlSeconds, MAX_SIGNED_LAN_URL_TTL_SECONDS));
    const expires = Math.floor(Date.now() / 1000) + boundedTtl;
    const nonce = options.stable
      ? signedUrlStableNonce(pathname, new URLSearchParams(`${params.toString()}&exp=${expires}`))
      : randomBytes(8).toString('hex');
    const signingInput = `${pathname}?${params.toString()}|exp=${expires}|nonce=${nonce}`;
    const sig = signLanPayload(signingInput);
    params.set('exp', String(expires));
    params.set('nonce', nonce);
    params.set('sig', sig);
    return `${base}${pathname}?${params.toString()}`;
  }

  function isSignedLanRequestValid(reqUrl: URL): boolean {
    const sig = reqUrl.searchParams.get('sig');
    const exp = reqUrl.searchParams.get('exp');
    const nonce = reqUrl.searchParams.get('nonce');
    if (!sig || !exp || !nonce) return false;

    const expSeconds = Number(exp);
    if (!Number.isFinite(expSeconds) || expSeconds < Math.floor(Date.now() / 1000)) return false;

    const params = new URLSearchParams(reqUrl.searchParams);
    params.delete('sig');
    params.delete('exp');
    params.delete('nonce');
    params.delete(IMAGE_CACHE_BUST_QUERY_PARAM);
    const signingInput = `${reqUrl.pathname}?${params.toString()}|exp=${expSeconds}|nonce=${nonce}`;
    return timingSafeStringEqual(sig, signLanPayload(signingInput));
  }

  function authorizeLanRequest(reqUrl: URL, req: IncomingMessage): { ok: boolean; device?: LanPairedDevice } {
    const cached = requestAuthorizations.get(req);
    if (cached) return cached;
    if (!isLanSharingEnabled()) return { ok: false };
    const token = requestToken(reqUrl, req);
    if (!token) return { ok: false };

    const device = findPairedDeviceByToken(token);
    if (device) {
      touchPairedDevice(device.id, getRequestRemoteAddress(req));
      const result = { ok: true, device };
      requestAuthorizations.set(req, result);
      return result;
    }

    const result = { ok: false };
    requestAuthorizations.set(req, result);
    return result;
  }

  function authorizeLocalRequest(reqUrl: URL, req: IncomingMessage): boolean {
    return isLoopbackRequest(req) && hasValidLocalAccessToken(reqUrl, req.headers, localAccessToken);
  }

  function requireLocalOrLanAccess(reqUrl: URL, req: IncomingMessage, res: ServerResponse): boolean {
    if (authorizeLocalRequest(reqUrl, req)) return true;
    if (isLoopbackRequest(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Local access token is required.');
      return false;
    }
    if (authorizeLanRequest(reqUrl, req).ok) return true;

    res.writeHead(isLanSharingEnabled() ? 401 : 403, { 'Content-Type': 'text/plain' });
    res.end(isLanSharingEnabled() ? 'Local network pairing is required.' : 'Local network sharing is disabled.');
    return false;
  }

  function requireStreamAccess(reqUrl: URL, req: IncomingMessage, res: ServerResponse): boolean {
    if (authorizeLocalRequest(reqUrl, req)) return true;
    if (isLoopbackRequest(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Local access token is required.');
      return false;
    }
    if (isLanSharingEnabled() && isSignedLanRequestValid(reqUrl)) return true;
    if (authorizeLanRequest(reqUrl, req).ok) return true;

    res.writeHead(isLanSharingEnabled() ? 401 : 403, { 'Content-Type': 'text/plain' });
    res.end(isLanSharingEnabled() ? 'Local network pairing is required.' : 'Local network sharing is disabled.');
    return false;
  }

  async function handleLanPairRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLanSharingEnabled()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Local network sharing is disabled.');
      return;
    }

    const address = getRequestRemoteAddress(req);
    // Refresh an expired PIN session before applying its attempt limits. A new
    // PIN invalidates every previous guess, so old lockouts can safely reset.
    const expectedCode = getLanShareToken();
    const limit = checkPairRateLimit(address);
    if (!limit.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(Math.ceil((limit.retryAfterMs || 0) / 1000)),
      });
      res.end(JSON.stringify({ error: 'Too many failed pairing attempts. Try again later.' }));
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, { maxBytes: 16 * 1024, timeoutMs: 10_000 });
    } catch (error) {
      if (error instanceof HttpBodyError) {
        writeJson(res, error.statusCode, { error: error.message });
        return;
      }
      throw error;
    }
    const code = String(body.code || '').trim().slice(0, 128);
    const deviceName = String(body.deviceName || '').trim().slice(0, 80) || 'Paired device';

    if (!timingSafeStringEqual(code, expectedCode)) {
      recordPairFailure(address);
      writeJson(res, 401, { error: 'The sharing code was not accepted.' });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'deviceId')) {
      writeJson(res, 409, {
        error: 'client_device_identity_not_supported',
        message: 'This client chooses its own device identity. Update LoomTV and pair again.',
      });
      return;
    }

    recordPairSuccess(address);
    const settings = loadSettings();
    const pairedDevices = settings.localNetworkPairedDevices || [];
    if (pairedDevices.length >= MAX_PAIRED_DEVICES) {
      writeJson(res, 409, {
        error: 'paired_device_limit_reached',
        message: 'Revoke an existing paired device in Settings before pairing another one.',
      });
      return;
    }
    const deviceId = randomUUID();
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    const updated: LanPairedDevice = {
      id: deviceId,
      name: deviceName,
      accessTokenHash: tokenHash(accessToken),
      accessTokenExpiresAt: now + ACCESS_TOKEN_TTL_MS,
      refreshTokenHash: tokenHash(refreshToken),
      refreshTokenExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      scopes: DEVICE_SCOPES,
      securityEpoch: 2,
      createdAt: now,
      lastSeenAt: now,
      lastAddress: address,
    };
    saveSettings({
      ...settings,
      localNetworkShareToken: createLanShareCode(),
      localNetworkPairedDevices: [...pairedDevices, updated],
      localNetworkSecurityEpoch: 2,
    });
    pairingSecretExpiresAt = 0;

    const supportsProfiles = req.headers['x-loom-profile-api-version'] === '1';
    const payload = supportsProfiles
      ? { movies: [], tvShows: [], animeShows: [], libraryFolders: [], libraryFolderGroups: { movies: [], tvShows: [], anime: [], others: [] } }
      : libraryForLocalNetwork(undefined, deviceId);
    writeJson(res, 200, {
      ok: true,
      deviceId,
      accessToken,
      accessTokenExpiresAt: updated.accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt: updated.refreshTokenExpiresAt,
      scopes: updated.scopes,
      hostDeviceId: settings.localNetworkDeviceId,
      hostDeviceName: settings.localNetworkDeviceName || os.hostname(),
      certFingerprint: getLanCertificateFingerprint(),
      library: payload,
      libraryEtag: libraryEtagFor(payload),
    });
  }

  async function handleLanRefreshRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLanSharingEnabled()) {
      writeJson(res, 403, { error: 'Local network sharing is disabled.' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, { maxBytes: 16 * 1024, timeoutMs: 10_000 });
    } catch (error) {
      if (error instanceof HttpBodyError) {
        writeJson(res, error.statusCode, { error: error.message });
        return;
      }
      throw error;
    }
    const refreshToken = String(body.refreshToken || '').trim();
    const refreshedDeviceName = String(body.deviceName || '').trim().slice(0, 80);
    if (!refreshToken) {
      writeJson(res, 400, { error: 'refreshToken is required.' });
      return;
    }
    const settings = loadSettings();
    const devices = settings.localNetworkPairedDevices || [];
    const hash = tokenHash(refreshToken);
    const device = devices.find((candidate) => candidate.securityEpoch === 2
      && candidate.refreshTokenExpiresAt > Date.now()
      && timingSafeStringEqual(candidate.refreshTokenHash, hash));
    if (!device) {
      writeJson(res, 401, { error: 'Refresh credential is invalid or expired.' });
      return;
    }
    const now = Date.now();
    const nextAccessToken = randomBytes(32).toString('base64url');
    const nextRefreshToken = randomBytes(32).toString('base64url');
    const updated: LanPairedDevice = {
      ...device,
      name: refreshedDeviceName || device.name,
      accessTokenHash: tokenHash(nextAccessToken),
      accessTokenExpiresAt: now + ACCESS_TOKEN_TTL_MS,
      refreshTokenHash: tokenHash(nextRefreshToken),
      refreshTokenExpiresAt: now + REFRESH_TOKEN_TTL_MS,
      lastSeenAt: now,
      lastAddress: getRequestRemoteAddress(req),
    };
    saveSettings({
      ...settings,
      localNetworkPairedDevices: devices.map((candidate) => candidate.id === device.id ? updated : candidate),
    });
    writeJson(res, 200, {
      accessToken: nextAccessToken,
      accessTokenExpiresAt: updated.accessTokenExpiresAt,
      refreshToken: nextRefreshToken,
      refreshTokenExpiresAt: updated.refreshTokenExpiresAt,
      scopes: updated.scopes,
    });
  }

  function libraryEtagFor(payload: unknown): string {
    return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  }

  function syncLanAdvertisement(): void {
    const settings = loadSettings();
    const port = getLanMediaServerPort();
    const certFingerprint = getLanCertificateFingerprint();
    if (!settings.localNetworkSharingEnabled || !port || !certFingerprint) {
      unadvertiseLanService();
      return;
    }
    advertiseLanService({
      port,
      instanceId: settings.localNetworkDeviceId || randomUUID(),
      deviceName: settings.localNetworkDeviceName || os.hostname(),
      protocolVersion: '2',
      certFingerprint,
    });
  }

  return {
    getRequestRemoteAddress,
    isLoopbackRequest,
    getLanServerBase,
    isLanSharingEnabled,
    getLanShareToken,
    getLanHmacSecret,
    requestToken,
    findPairedDeviceByToken,
    touchPairedDevice,
    signLanPayload,
    buildSignedLanUrl,
    isSignedLanRequestValid,
    authorizeLanRequest,
    authorizeLocalRequest,
    requireLocalOrLanAccess,
    requireStreamAccess,
    handleLanPairRequest,
    handleLanRefreshRequest,
    libraryEtagFor,
    syncLanAdvertisement,
  };
}
