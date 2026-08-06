import { app, safeStorage } from 'electron';
import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import { promises as dns } from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import type {
  LibraryPayload,
  RemoteLibraryConnection,
  RemoteLibraryRequest,
  RemoteLibraryResponse,
  RemoteLibrarySessionState,
} from '../shared/desktopProtocol.ts';

const SESSION_VERSION = 2;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_API_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_AUTH_RESPONSE_BYTES = 256 * 1024;
const PROFILE_API_HEADER = 'X-Loom-Profile-Api-Version';

type RemoteSecretSession = {
  baseUrl: string;
  certFingerprint: string;
  certificatePem: string;
  deviceId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  hostDeviceId?: string;
  hostDeviceName?: string;
  clientDeviceName: string;
};

type RemotePairPayload = {
  deviceId: string;
  certFingerprint: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  hostDeviceId?: string;
  hostDeviceName?: string;
  library?: LibraryPayload;
  libraryEtag?: string;
};

const REMOTE_ROUTE_POLICY = new Map<string, ReadonlySet<string>>([
  ['/api/v2/library', new Set(['GET'])],
  ['/api/v2/library/index', new Set(['GET'])],
  ['/api/v2/profiles', new Set(['GET', 'POST'])],
  ['/api/v2/profiles/active', new Set(['GET'])],
  ['/api/v2/profiles/select', new Set(['POST'])],
  ['/api/v2/profiles/lock', new Set(['POST'])],
  ['/api/v2/profiles/auto-sign-in', new Set(['POST'])],
  ['/api/v2/profile-preferences', new Set(['GET', 'PATCH'])],
  ['/api/v2/profile-lists', new Set(['GET', 'PUT', 'DELETE'])],
  ['/api/v2/progress', new Set(['GET', 'POST'])],
  ['/api/v2/playback-track-preferences', new Set(['GET', 'POST'])],
  ['/api/v2/playback/segments', new Set(['GET'])],
  ['/api/v2/start-hls', new Set(['POST'])],
  ['/api/v2/playback-plan', new Set(['POST'])],
]);

function isAllowedRemoteApiRoute(pathname: string, method: string): boolean {
  if (REMOTE_ROUTE_POLICY.get(pathname)?.has(method)) return true;
  return method === 'GET' && pathname.startsWith('/api/v2/library/items/');
}

function isAllowedRemoteMediaPath(pathname: string): boolean {
  return pathname === '/stream'
    || pathname === '/subtitle'
    || pathname === '/api/thumbnail'
    || pathname === '/api/embedded-thumbnail'
    || pathname === '/api/local-image'
    || pathname === '/api/cached-artwork'
    || pathname === '/api/custom-artwork'
    || pathname.startsWith('/hls/');
}

function sessionFilePath(): string {
  return path.join(app.getPath('userData'), 'remote-library-session.secure.json');
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd');
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPrivateIpv4(address) : family === 6 ? isPrivateIpv6(address) : false;
}

async function assertPrivateLanHost(hostname: string): Promise<void> {
  if (isPrivateAddress(hostname)) return;
  if (hostname.toLowerCase() === 'localhost') return;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('The LoomTV host name could not be resolved.');
  }
  if (!addresses.length || addresses.some(({ address }) => !isPrivateAddress(address))) {
    throw new Error('Remote libraries must use a private local-network address.');
  }
}

async function normalizeLanBaseUrl(value: string): Promise<string> {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Select a LoomTV host or enter its IP address.');
  const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (parsed.protocol !== 'https:') throw new Error('Enter a secure HTTPS host address.');
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Enter only the LoomTV host address and port.');
  }
  if (!parsed.port) throw new Error('Enter the secure host address including its advertised port.');
  await assertPrivateLanHost(parsed.hostname);
  return parsed.origin;
}

type RemoteCertificate = { certFingerprint: string; certificatePem: string };

function normalizedFingerprint(value: string): string {
  const normalized = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error('The LoomTV host certificate fingerprint is invalid.');
  return normalized;
}

function certificatePem(raw: Buffer): string {
  const lines = raw.toString('base64').match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

async function probeRemoteCertificate(baseUrl: string): Promise<RemoteCertificate> {
  const parsed = new URL(baseUrl);
  await assertPrivateLanHost(parsed.hostname);
  const port = Number(parsed.port || 443);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: parsed.hostname,
      port,
      rejectUnauthorized: false,
      servername: isIP(parsed.hostname) ? undefined : parsed.hostname,
    });
    const timeout = setTimeout(() => socket.destroy(new Error('The LoomTV host TLS handshake timed out.')), 10_000);
    socket.once('secureConnect', () => {
      clearTimeout(timeout);
      const peer = socket.getPeerCertificate(true);
      const raw = peer?.raw;
      if (!raw?.length) {
        socket.destroy();
        reject(new Error('The LoomTV host did not present a TLS certificate.'));
        return;
      }
      try {
        const certificate = new X509Certificate(raw);
        if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
          throw new Error('The LoomTV host TLS certificate is not currently valid.');
        }
        resolve({
          certFingerprint: createHash('sha256').update(raw).digest('hex'),
          certificatePem: certificatePem(raw),
        });
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

const pinnedAgents = new Map<string, https.Agent>();

function destroyPinnedAgents(): void {
  for (const agent of pinnedAgents.values()) agent.destroy();
  pinnedAgents.clear();
}

function pinnedAgent(identity: RemoteCertificate): https.Agent {
  const fingerprint = normalizedFingerprint(identity.certFingerprint);
  const key = `${fingerprint}\u0000${identity.certificatePem}`;
  const existing = pinnedAgents.get(key);
  if (existing) return existing;
  const expected = Buffer.from(fingerprint, 'hex');
  const agent = new https.Agent({
    ca: identity.certificatePem,
    keepAlive: true,
    maxSockets: 8,
    maxFreeSockets: 4,
    scheduling: 'lifo',
    checkServerIdentity: (_hostname, certificate) => {
      const actual = certificate.raw ? createHash('sha256').update(certificate.raw).digest() : Buffer.alloc(0);
      return actual.length === expected.length && timingSafeEqual(actual, expected)
        ? undefined
        : new Error('The LoomTV host TLS certificate changed. Pair again before sending credentials.');
    },
  });
  pinnedAgents.set(key, agent);
  return agent;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
  identity?: RemoteCertificate,
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !identity) throw new Error('A pinned TLS identity is required for remote-library requests.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await new Promise<Response>((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const body = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : null;
      if (body && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) {
        headers['content-length'] = String(body.length);
      }
      const request = https.request(parsed, {
        method: init.method || 'GET',
        headers,
        agent: pinnedAgent(identity),
        signal: controller.signal,
      }, (incoming) => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        const status = incoming.statusCode || 502;
        const noBody = init.method === 'HEAD' || status === 204 || status === 205 || status === 304;
        resolve(new Response(
          noBody ? null : Readable.toWeb(incoming) as unknown as BodyInit,
          { status, statusText: incoming.statusMessage, headers: responseHeaders },
        ));
      });
      request.once('error', reject);
      if (body) request.write(body);
      request.end();
    });
  } finally {
    clearTimeout(timer);
  }
}

function emptyLibrary(): LibraryPayload {
  return { movies: [], tvShows: [], animeShows: [], libraryFolders: [] };
}

function publicConnection(session: RemoteSecretSession, library: LibraryPayload = emptyLibrary(), libraryEtag = ''): RemoteLibraryConnection {
  return {
    baseUrl: session.baseUrl,
    deviceId: session.deviceId,
    deviceToken: '',
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshToken: '',
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    hostDeviceId: session.hostDeviceId,
    hostDeviceName: session.hostDeviceName,
    library,
    libraryEtag,
  };
}

function responseHeaders(response: Response): Record<string, string> {
  const allowed = ['cache-control', 'content-type', 'etag', 'retry-after'];
  return Object.fromEntries(allowed.flatMap((name) => {
    const value = response.headers.get(name);
    return value ? [[name, value]] : [];
  }));
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('The LoomTV host response is too large.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('The LoomTV host response is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function errorMessage(payload: string, fallback: string): string {
  try {
    const parsed = JSON.parse(payload) as { error?: string };
    return parsed.error || fallback;
  } catch {
    return payload.trim() || fallback;
  }
}

export function createRemoteLibraryClient() {
  let session: RemoteSecretSession | null | undefined;
  let sessionLoadFailure = '';
  let refreshPromise: Promise<RemoteSecretSession> | null = null;

  const loadSession = (): RemoteSecretSession | null => {
    if (session !== undefined) return session;
    session = null;
    sessionLoadFailure = '';
    const target = sessionFilePath();
    if (!fs.existsSync(target)) return session;
    if (!safeStorage.isEncryptionAvailable()) {
      sessionLoadFailure = 'Secure credential storage is unavailable. Pair this laptop again after enabling the system keychain.';
      return session;
    }
    try {
      const envelope = JSON.parse(fs.readFileSync(target, 'utf8')) as { version?: number; encrypted?: string };
      if (envelope.version !== SESSION_VERSION || !envelope.encrypted) {
        sessionLoadFailure = 'The saved pairing uses an unsupported security format. Pair this laptop again.';
        return session;
      }
      const decrypted = safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64'));
      const parsed = JSON.parse(decrypted) as RemoteSecretSession;
      if (
        !parsed.baseUrl
        || !parsed.certFingerprint
        || !parsed.certificatePem
        || !parsed.deviceId
        || !parsed.accessToken
        || !parsed.refreshToken
      ) {
        sessionLoadFailure = 'The saved pairing is incomplete. Pair this laptop again.';
        return session;
      }
      session = parsed;
    } catch {
      session = null;
      sessionLoadFailure = 'The saved pairing could not be unlocked. Pair this laptop again.';
    }
    return session;
  };

  const persistSession = (next: RemoteSecretSession): void => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this computer.');
    }
    const target = sessionFilePath();
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const backup = `${target}.bak`;
    const encrypted = safeStorage.encryptString(JSON.stringify(next)).toString('base64');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ version: SESSION_VERSION, encrypted }), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temporary, target);
    } catch (atomicReplaceError) {
      try {
        try { fs.unlinkSync(backup); } catch { /* No stale backup. */ }
        if (fs.existsSync(target)) fs.renameSync(target, backup);
        fs.renameSync(temporary, target);
        try { fs.unlinkSync(backup); } catch { /* Replacement already succeeded. */ }
      } catch (fallbackError) {
        try { fs.unlinkSync(temporary); } catch { /* Best effort cleanup. */ }
        if (!fs.existsSync(target) && fs.existsSync(backup)) {
          try { fs.renameSync(backup, target); } catch { /* Preserve the replacement error. */ }
        }
        throw fallbackError instanceof Error ? fallbackError : atomicReplaceError;
      }
    }
    session = next;
    sessionLoadFailure = '';
  };

  const clearSession = (): void => {
    session = null;
    sessionLoadFailure = '';
    destroyPinnedAgents();
    try { fs.unlinkSync(sessionFilePath()); } catch { /* Already cleared. */ }
    try { fs.unlinkSync(`${sessionFilePath()}.bak`); } catch { /* Already cleared. */ }
  };

  const refresh = async (): Promise<RemoteSecretSession> => {
    if (refreshPromise) return refreshPromise;
    const current = loadSession();
    if (!current?.refreshToken || current.refreshTokenExpiresAt <= Date.now()) {
      clearSession();
      throw new Error('The host pairing expired. Pair this laptop again.');
    }
    refreshPromise = (async () => {
      const response = await fetchWithTimeout(`${current.baseUrl}/api/v2/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [PROFILE_API_HEADER]: '1' },
        body: JSON.stringify({ refreshToken: current.refreshToken, deviceName: current.clientDeviceName }),
      }, REQUEST_TIMEOUT_MS, current);
      const text = await readResponseText(response, MAX_AUTH_RESPONSE_BYTES);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) clearSession();
        throw new Error(errorMessage(text, 'The secure pairing session could not be refreshed.'));
      }
      const payload = JSON.parse(text) as Pick<RemotePairPayload,
        'accessToken' | 'accessTokenExpiresAt' | 'refreshToken' | 'refreshTokenExpiresAt'>;
      const updated = {
        ...current,
        accessToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
        refreshToken: payload.refreshToken,
        refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
      };
      persistSession(updated);
      return updated;
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };

  const authorizedFetch = async (pathname: string, request: RemoteLibraryRequest = {}, retry = true): Promise<Response> => {
    const parsedPath = new URL(pathname, 'http://loomtv.local');
    if (parsedPath.origin !== 'http://loomtv.local') throw new Error('Invalid remote-library route.');
    const method = request.method || 'GET';
    if (!isAllowedRemoteApiRoute(parsedPath.pathname, method)) throw new Error('That remote-library operation is not allowed.');
    if (request.body && Buffer.byteLength(request.body, 'utf8') > MAX_REQUEST_BODY_BYTES) throw new Error('The remote-library request is too large.');

    let current = loadSession();
    if (!current) throw new Error('This laptop is not paired with a LoomTV host.');
    await assertPrivateLanHost(new URL(current.baseUrl).hostname);
    if (current.accessTokenExpiresAt <= Date.now() + 60_000) current = await refresh();

    const forwardedHeaders: Record<string, string> = {
      Authorization: `Bearer ${current.accessToken}`,
      [PROFILE_API_HEADER]: '1',
    };
    const contentType = request.headers?.['Content-Type'] || request.headers?.['content-type'];
    const etag = request.headers?.['If-None-Match'] || request.headers?.['if-none-match'];
    if (contentType) forwardedHeaders['Content-Type'] = contentType;
    if (etag) forwardedHeaders['If-None-Match'] = etag;

    const response = await fetchWithTimeout(`${current.baseUrl}${parsedPath.pathname}${parsedPath.search}`, {
      method,
      headers: forwardedHeaders,
      body: method === 'GET' ? undefined : request.body,
    }, REQUEST_TIMEOUT_MS, current);
    if (response.status === 401 && retry) {
      await refresh();
      return authorizedFetch(pathname, request, false);
    }
    return response;
  };

  return {
    async connect(
      baseUrl: string,
      code: string,
      device: { name: string },
      expectedFingerprint?: string,
    ): Promise<RemoteLibraryConnection> {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer.');
      const normalizedBaseUrl = await normalizeLanBaseUrl(baseUrl);
      const normalizedCode = String(code || '').trim();
      if (!/^\d{6}$/.test(normalizedCode)) throw new Error('Enter the 6-digit pairing PIN.');
      const observedCertificate = await probeRemoteCertificate(normalizedBaseUrl);
      if (
        expectedFingerprint
        && normalizedFingerprint(expectedFingerprint) !== observedCertificate.certFingerprint
      ) throw new Error('The discovered LoomTV host certificate changed before pairing. Rescan and try again.');
      const response = await fetchWithTimeout(`${normalizedBaseUrl}/api/v2/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [PROFILE_API_HEADER]: '1' },
        body: JSON.stringify({ code: normalizedCode, deviceName: device.name }),
      }, 10_000, observedCertificate);
      const text = await readResponseText(response, MAX_API_RESPONSE_BYTES);
      if (!response.ok) {
        if (response.status === 401) throw new Error('The pairing PIN was not accepted.');
        if (response.status === 429) throw new Error('Too many failed pairing attempts. Try again in a few minutes.');
        throw new Error(errorMessage(text, `The host returned ${response.status}.`));
      }
      const payload = JSON.parse(text) as RemotePairPayload;
      if (normalizedFingerprint(payload.certFingerprint) !== observedCertificate.certFingerprint) {
        throw new Error('The LoomTV host TLS identity changed during pairing. Refresh discovery and try again.');
      }
      const next: RemoteSecretSession = {
        baseUrl: normalizedBaseUrl,
        certFingerprint: observedCertificate.certFingerprint,
        certificatePem: observedCertificate.certificatePem,
        deviceId: payload.deviceId,
        accessToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
        refreshToken: payload.refreshToken,
        refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
        hostDeviceId: payload.hostDeviceId,
        hostDeviceName: payload.hostDeviceName,
        clientDeviceName: device.name,
      };
      persistSession(next);
      return publicConnection(next, payload.library || emptyLibrary(), payload.libraryEtag || '');
    },

    async request(pathname: string, request?: RemoteLibraryRequest): Promise<RemoteLibraryResponse> {
      const response = await authorizedFetch(pathname, request);
      return { status: response.status, headers: responseHeaders(response), body: await readResponseText(response, MAX_API_RESPONSE_BYTES) };
    },

    getSession(): RemoteLibrarySessionState {
      const current = loadSession();
      if (current) return { status: 'connected', connection: publicConnection(current) };
      if (sessionLoadFailure) return { status: 'pairing-required', reason: sessionLoadFailure };
      return { status: 'none' };
    },

    resolveMediaUrl(pathname: string): string {
      const current = loadSession();
      if (!current) throw new Error('This laptop is not paired with a LoomTV host.');
      const parsed = new URL(pathname, 'http://loomtv.local');
      if (parsed.origin !== 'http://loomtv.local' || !isAllowedRemoteMediaPath(parsed.pathname)) {
        throw new Error('That remote media route is not allowed.');
      }
      return `${current.baseUrl}${parsed.pathname}${parsed.search}`;
    },

    async fetchMedia(pathname: string, headers: Record<string, string> = {}): Promise<Response> {
      const current = loadSession();
      if (!current) throw new Error('This laptop is not paired with a LoomTV host.');
      const parsed = new URL(pathname, 'http://loomtv.local');
      if (parsed.origin !== 'http://loomtv.local' || !isAllowedRemoteMediaPath(parsed.pathname)) {
        throw new Error('That remote media route is not allowed.');
      }
      await assertPrivateLanHost(new URL(current.baseUrl).hostname);
      return fetchWithTimeout(
        `${current.baseUrl}${parsed.pathname}${parsed.search}`,
        { method: 'GET', headers },
        REQUEST_TIMEOUT_MS,
        current,
      );
    },

    async disconnect(revoke = false): Promise<boolean> {
      const current = loadSession();
      clearSession();
      if (revoke && current) {
        void fetchWithTimeout(`${current.baseUrl}/api/v2/unpair`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${current.accessToken}`,
            [PROFILE_API_HEADER]: '1',
          },
        }, 10_000, current).catch(() => undefined);
      }
      return true;
    },
  };
}
