import os from 'node:os';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from 'electron';
import { createLanShareCode } from './settings';
import {
  hasValidLocalAccessToken,
  isLoopbackAddress,
  normalizeRemoteAddress,
  requestLanToken,
  timingSafeStringEqual,
} from './serverSecurity';
import { getMediaServerPort } from './mediaServer';
import { getPrimaryLocalNetworkAddress } from './networkInfo';
import { checkPairRateLimit, recordPairFailure, recordPairSuccess } from './pairRateLimit';
import { readJsonBody, writeJson } from './httpResponses';
import { advertiseLanService, unadvertiseLanService } from './lanDiscovery';
import type { AppSettings, LanPairedDevice } from '../main';

export interface LanSecurityDeps {
  loadSettings: () => AppSettings;
  saveSettings: (settings: AppSettings) => void;
  localAccessToken: string;
  libraryForLocalNetwork: () => unknown;
}

export function createLanSecurity(deps: LanSecurityDeps) {
  const { loadSettings, saveSettings, localAccessToken, libraryForLocalNetwork } = deps;

  function getRequestRemoteAddress(req: IncomingMessage): string {
    return normalizeRemoteAddress(req.socket.remoteAddress);
  }

  function isLoopbackRequest(req: IncomingMessage): boolean {
    return isLoopbackAddress(getRequestRemoteAddress(req));
  }

  function getLanServerBase(): string | null {
    const address = getPrimaryLocalNetworkAddress();
    return address ? `http://${address}:${getMediaServerPort()}` : null;
  }

  function isLanSharingEnabled(): boolean {
    return Boolean(loadSettings().localNetworkSharingEnabled);
  }

  function getLanShareToken(): string {
    const settings = loadSettings();
    if (settings.localNetworkShareToken && /^\d{6}$/.test(settings.localNetworkShareToken)) {
      return settings.localNetworkShareToken;
    }

    const token = createLanShareCode();
    saveSettings({ ...settings, localNetworkShareToken: token });
    return token;
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
      if (timingSafeStringEqual(device.token, token)) return device;
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

  function buildSignedLanUrl(base: string, pathname: string, params: URLSearchParams, ttlSeconds = 24 * 60 * 60): string {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const nonce = randomBytes(8).toString('hex');
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
    const signingInput = `${reqUrl.pathname}?${params.toString()}|exp=${expSeconds}|nonce=${nonce}`;
    return timingSafeStringEqual(sig, signLanPayload(signingInput));
  }

  function authorizeLanRequest(reqUrl: URL, req: IncomingMessage): { ok: boolean; device?: LanPairedDevice } {
    if (!isLanSharingEnabled()) return { ok: false };
    const token = requestToken(reqUrl, req);
    if (!token) return { ok: false };

    if (timingSafeStringEqual(token, getLanShareToken())) {
      return { ok: true };
    }

    const device = findPairedDeviceByToken(token);
    if (device) {
      touchPairedDevice(device.id, getRequestRemoteAddress(req));
      return { ok: true, device };
    }

    return { ok: false };
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
    const limit = checkPairRateLimit(address);
    if (!limit.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(Math.ceil((limit.retryAfterMs || 0) / 1000)),
      });
      res.end(JSON.stringify({ error: 'Too many failed pairing attempts. Try again later.' }));
      return;
    }

    const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
    const code = String(body.code || '').replace(/\D/g, '').slice(0, 6);
    const deviceName = String(body.deviceName || '').trim().slice(0, 80) || 'Paired device';
    const requestedDeviceId = String(body.deviceId || '').trim().slice(0, 64);

    if (!timingSafeStringEqual(code, getLanShareToken())) {
      recordPairFailure(address);
      writeJson(res, 401, { error: 'The sharing code was not accepted.' });
      return;
    }

    recordPairSuccess(address);
    const settings = loadSettings();
    const existing = (settings.localNetworkPairedDevices || []).find((device) => requestedDeviceId && device.id === requestedDeviceId);
    const deviceId = existing?.id || requestedDeviceId || randomUUID();
    const deviceToken = randomBytes(32).toString('hex');
    const now = Date.now();
    const updated: LanPairedDevice = {
      id: deviceId,
      name: deviceName,
      token: deviceToken,
      createdAt: existing?.createdAt || now,
      lastSeenAt: now,
      lastAddress: address,
    };
    const others = (settings.localNetworkPairedDevices || []).filter((device) => device.id !== deviceId);
    saveSettings({ ...settings, localNetworkPairedDevices: [...others, updated] });

    const payload = libraryForLocalNetwork();
    writeJson(res, 200, {
      ok: true,
      deviceId,
      deviceToken,
      hostDeviceId: settings.localNetworkDeviceId,
      hostDeviceName: settings.localNetworkDeviceName || os.hostname(),
      library: payload,
      libraryEtag: libraryEtagFor(payload),
    });
  }

  function libraryEtagFor(payload: unknown): string {
    return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  }

  function syncLanAdvertisement(): void {
    const settings = loadSettings();
    if (!settings.localNetworkSharingEnabled || !getMediaServerPort()) {
      unadvertiseLanService();
      return;
    }
    advertiseLanService({
      port: getMediaServerPort(),
      deviceId: settings.localNetworkDeviceId || randomUUID(),
      deviceName: settings.localNetworkDeviceName || os.hostname(),
      appVersion: app.getVersion(),
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
    libraryEtagFor,
    syncLanAdvertisement,
  };
}
