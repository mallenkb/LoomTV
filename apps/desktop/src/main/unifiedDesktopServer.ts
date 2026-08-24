import { app, dialog, safeStorage, shell } from 'electron';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { canonicalStatePath } from '@loom-media-server/video-migration';
import type { UnifiedDesktopServerState } from '../shared/desktopProtocol.ts';
import { createCanonicalServerHost } from './canonicalServerHost.ts';
import {
  closeCanonicalSetupWindow,
  configureCanonicalWindow,
  configureDesktopSetupChannel,
  openCanonicalSetupWindow,
} from './canonicalWindow.ts';
import { findFFmpeg, findFFprobe } from './mediaBinaries.ts';
import { getLocalNetworkAddresses } from './networkInfo.ts';
import { loadOrCreateLanTlsIdentity, type LanTlsIdentity } from './lanTlsIdentity.ts';

type ProtectedSecret = { version: 1; encrypted: string };
type ApiEnvelope<T> = { ok?: boolean; data?: T; error?: { message?: string } };

const TEST_FLAG = 'LOOMTV_UNIFIED_DESKTOP';
const BOOTSTRAP_SECRET_NAME = 'canonical-bootstrap.secure.json';

let host: ReturnType<typeof createCanonicalServerHost> | null = null;
let identity: LanTlsIdentity | null = null;
let origin = '';
let bootstrapSecret: string | null = null;
let desktopSetupToken = '';
let adminToken: string | null = null;
let certificatePinInstalled = false;
let setupRequired = false;
let state: UnifiedDesktopServerState = {
  enabled: false,
  ready: false,
  ownerConfigured: false,
};

function enabledByEnvironment(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[TEST_FLAG] || '').trim().toLowerCase());
}

function configuredDataDir(): string | null {
  const value = String(process.env.LOOMTV_DATA_DIR || '').trim();
  return value ? path.resolve(value) : null;
}

export type UnifiedDesktopSetupHooks = {
  testMetadata?: (input: { provider: string; apiKey: string }) => Promise<{ ok: boolean; code?: string; message?: string }> | { ok: boolean; code?: string; message?: string };
  saveMetadata?: (input: { keys: Record<string, string>; skipped: boolean }) => Promise<void> | void;
  complete?: (input: {
    roots: Array<{ id: string; path: string; kind: 'movies' | 'tvShows' | 'anime' | 'others'; state?: string }>;
    ownerName: string;
    serverName: string;
    language: string;
  }) => Promise<void> | void;
};

function bootstrapSecretPath(dataDir: string): string {
  return path.join(dataDir, BOOTSTRAP_SECRET_NAME);
}

function readProtectedBootstrapSecret(dataDir: string): string | null {
  const target = bootstrapSecretPath(dataDir);
  if (!fs.existsSync(target)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-protected credential storage is unavailable. LoomTV cannot read its private server setup credential.');
  }
  const value = JSON.parse(fs.readFileSync(target, 'utf8')) as ProtectedSecret;
  if (value.version !== 1 || typeof value.encrypted !== 'string' || !value.encrypted) {
    throw new Error('The protected LoomTV server setup credential is malformed.');
  }
  return safeStorage.decryptString(Buffer.from(value.encrypted, 'base64'));
}

function writeProtectedBootstrapSecret(dataDir: string, secret: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-protected credential storage is required for the unified desktop test.');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const target = bootstrapSecretPath(dataDir);
  const temporary = `${target}.${process.pid}.tmp`;
  const value: ProtectedSecret = {
    version: 1,
    encrypted: safeStorage.encryptString(secret).toString('base64'),
  };
  fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch { /* Windows protects the file with ACLs. */ }
}

function loadOrCreateBootstrapSecret(dataDir: string): string {
  const existing = readProtectedBootstrapSecret(dataDir);
  if (existing) return existing;
  const created = randomBytes(32).toString('base64url');
  writeProtectedBootstrapSecret(dataDir, created);
  return created;
}

function removeBootstrapSecret(dataDir: string): void {
  try { fs.unlinkSync(bootstrapSecretPath(dataDir)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  bootstrapSecret = null;
}

function requestJson<T>(pathname: string, requestIdentity: LanTlsIdentity, options: {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: Record<string, unknown>;
  token?: string;
  trustedSetup?: boolean;
} = {}): Promise<T> {
  if (!origin) return Promise.reject(new Error('The unified LoomTV server is not running.'));
  const url = new URL(pathname, origin);
  const body = options.body ? JSON.stringify(options.body) : undefined;
  const expectedFingerprint = Buffer.from(requestIdentity.certFingerprint, 'hex');
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method || 'GET',
      ca: requestIdentity.certificatePem,
      headers: {
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.trustedSetup && desktopSetupToken ? { 'x-loomtv-desktop-setup': desktopSetupToken } : {}),
      },
      checkServerIdentity: (_host, certificate) => {
        const actual = certificate.raw
          ? createHash('sha256').update(certificate.raw).digest()
          : Buffer.alloc(0);
        return actual.length === expectedFingerprint.length && actual.equals(expectedFingerprint)
          ? undefined
          : new Error('The local LoomTV server certificate did not match its saved identity.');
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 512 * 1024) request.destroy(new Error('The local LoomTV server response was too large.'));
        else chunks.push(chunk);
      });
      response.once('end', () => {
        try {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          if ((response.statusCode || 500) === 204) {
            resolve(undefined as T);
            return;
          }
          const payload = JSON.parse(responseBody) as ApiEnvelope<T>;
          if ((response.statusCode || 500) >= 400 || payload.ok === false) {
            reject(new Error(payload.error?.message || `The local LoomTV server rejected the request (${response.statusCode || 500}).`));
            return;
          }
          resolve((payload.data ?? payload) as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error('The local LoomTV server did not respond.')));
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function installCanonicalCertificatePin(): void {
  if (certificatePinInstalled || !identity || !origin) return;
  certificatePinInstalled = true;
  const expectedOrigin = new URL(origin).origin;
  const expectedFingerprint = identity.certFingerprint.replace(/[^0-9a-f]/gi, '').toLowerCase();
  app.on('certificate-error', (event, _webContents, value, _error, certificate, callback) => {
    let matches: boolean;
    try {
      matches = new URL(value).origin === expectedOrigin
        && new X509Certificate(certificate.data).fingerprint256.replace(/[^0-9a-f]/gi, '').toLowerCase() === expectedFingerprint;
    } catch {
      matches = false;
    }
    if (matches) event.preventDefault();
    callback(matches);
  });
}

export function getUnifiedDesktopServerState(): UnifiedDesktopServerState {
  return { ...state };
}

export function getUnifiedDesktopLanAdvertisement(): { port: number; certFingerprint: string } | null {
  const address = host?.address();
  if (!state.enabled || !state.ready || !address || !identity?.certFingerprint) return null;
  return { port: address.port, certFingerprint: identity.certFingerprint };
}

async function ensureCanonicalProfile(name: string): Promise<void> {
  if (!identity || !adminToken) return;
  const listed = await requestJson<{ profiles: Array<{ name?: string }> }>('/api/v1/profiles', identity, {
    token: adminToken,
  });
  if (listed.profiles.some((profile) => profile.name === name)) return;
  await requestJson('/api/v1/profiles', identity, {
    method: 'POST',
    token: adminToken,
    body: { name },
  });
}

export async function startUnifiedDesktopServer(setupHooks: UnifiedDesktopSetupHooks = {}): Promise<UnifiedDesktopServerState> {
  if (!enabledByEnvironment()) {
    state = { enabled: false, ready: false, ownerConfigured: false };
    return getUnifiedDesktopServerState();
  }

  const dataDir = configuredDataDir();
  if (!dataDir) {
    state = {
      enabled: true,
      ready: false,
      ownerConfigured: false,
      error: `${TEST_FLAG}=1 requires LOOMTV_DATA_DIR so the test cannot touch the live LoomTV database.`,
    };
    return getUnifiedDesktopServerState();
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    identity = loadOrCreateLanTlsIdentity(dataDir, getLocalNetworkAddresses());
    const protectedSecretExists = fs.existsSync(bootstrapSecretPath(dataDir));
    bootstrapSecret = !fs.existsSync(canonicalStatePath(dataDir)) || protectedSecretExists
      ? loadOrCreateBootstrapSecret(dataDir)
      : null;
    desktopSetupToken = randomBytes(48).toString('base64url');
    const sourceAssets = path.resolve(app.getAppPath(), '../server/src');
    const desktopAssets = path.resolve(app.getAppPath(), 'src/headless');
    const packagedAsset = (name: string, developmentPath: string) => (
      app.isPackaged ? path.join(process.resourcesPath, name) : developmentPath
    );
    const configuredPort = Number.parseInt(String(process.env.LOOMTV_CANONICAL_PORT || ''), 10);

    host = createCanonicalServerHost({
      migrationReady: true,
      host: '0.0.0.0',
      // The desktop LAN media server already owns 3848. Keep the unified
      // administration server on its own default port so enabling the test
      // cannot silently hide the admin entry after an EADDRINUSE failure.
      port: Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3948,
      paths: {
        dataDir,
        cacheDir: path.join(dataDir, 'canonical-cache'),
        mediaDir: null,
      },
      version: app.getVersion(),
      ffmpegPath: findFFmpeg() || undefined,
      ffprobePath: findFFprobe() || undefined,
      requireSecureTransport: true,
      requireBootstrapSecret: false,
      tls: { cert: identity.certificatePem, key: identity.privateKeyPem },
      certificateFingerprint: identity.certFingerprint,
      bootstrapSecret: bootstrapSecret || undefined,
      desktopSetupToken,
      pickFolder: async () => {
        const result = await dialog.showOpenDialog({
          title: 'Choose a library folder',
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? null : result.filePaths[0] || null;
      },
      setupHooks: {
        ...setupHooks,
        ownerCreated: ({ adminToken: createdToken }) => {
          adminToken = createdToken;
        },
      },
      adminHtmlPath: packagedAsset('admin.html', path.join(desktopAssets, 'admin.html')),
      adminIconsPath: packagedAsset('lucide-icons.svg', path.join(desktopAssets, 'lucide-icons.svg')),
      webAppHtmlPath: packagedAsset('web-app.html', path.join(sourceAssets, 'web-app.html')),
      setupHtmlPath: packagedAsset('setup.html', path.join(sourceAssets, 'setup.html')),
      compatibilityHandler: async () => false,
    });
    const address = await host.start();
    origin = `https://127.0.0.1:${address.port}`;
    configureDesktopSetupChannel(desktopSetupToken);
    configureCanonicalWindow(origin);
    installCanonicalCertificatePin();
    const setup = await requestJson<{ ownerConfigured: boolean; required: boolean }>('/api/v1/setup/state', identity, {
      trustedSetup: true,
    });
    setupRequired = setup.required;
    if (setup.ownerConfigured) removeBootstrapSecret(dataDir);
    state = {
      enabled: true,
      ready: true,
      ownerConfigured: setup.ownerConfigured,
      adminUrl: `${origin}/admin/`,
      appUrl: `${origin}/app/`,
    };
  } catch (error) {
    state = {
      enabled: true,
      ready: false,
      ownerConfigured: false,
      error: error instanceof Error ? error.message : 'The unified LoomTV server could not start.',
    };
  }
  return getUnifiedDesktopServerState();
}

export async function configureUnifiedDesktopOwner(input: { name: string; password: string }): Promise<UnifiedDesktopServerState> {
  if (!state.enabled) return getUnifiedDesktopServerState();
  if (!state.ready || !identity) throw new Error(state.error || 'The unified LoomTV server is not ready.');
  const name = String(input.name || '').trim();
  const password = String(input.password || '');
  if (!name) throw new Error('Enter an administrator name.');
  if (password.length < 8 || password.length > 256) throw new Error('The administrator password must contain between 8 and 256 characters.');
  if (state.ownerConfigured) {
    await ensureCanonicalProfile(name);
    return getUnifiedDesktopServerState();
  }
  const created = await requestJson<{ adminToken: string }>('/api/v1/setup/owner', identity, {
    method: 'POST',
    trustedSetup: true,
    body: { name, password, serverName: `${name}'s LoomTV`, language: 'en', sessionMode: 'bearer' },
  });
  adminToken = created.adminToken;
  const dataDir = configuredDataDir();
  if (dataDir) removeBootstrapSecret(dataDir);
  state = { ...state, ownerConfigured: true };
  await ensureCanonicalProfile(name);
  return getUnifiedDesktopServerState();
}

function canonicalRootId(folderPath: string): string {
  return createHash('sha256').update(path.resolve(folderPath)).digest('hex').slice(0, 24);
}

export async function addUnifiedDesktopLibraryRoot(folderPath: string, kind: 'movies' | 'tvShows' | 'anime' | 'others'): Promise<boolean> {
  if (!state.ready || !identity || !adminToken) return false;
  const added = await requestJson<{ root?: { id?: string } }>('/api/v1/library/roots', identity, {
    method: 'POST',
    token: adminToken,
    body: { path: path.resolve(folderPath), kind: kind === 'tvShows' ? 'tv' : kind },
  });
  await requestJson('/api/v1/library/scan', identity, {
    method: 'POST',
    token: adminToken,
    body: { mode: 'quick', rootId: added.root?.id || canonicalRootId(folderPath) },
  });
  return true;
}

export async function removeUnifiedDesktopLibraryRoot(folderPath: string): Promise<boolean> {
  if (!state.ready || !identity || !adminToken) return false;
  await requestJson(`/api/v1/library/roots/${canonicalRootId(folderPath)}`, identity, {
    method: 'DELETE',
    token: adminToken,
  });
  return true;
}

export async function openUnifiedDesktopAdmin(): Promise<boolean> {
  if (!state.ready || !state.adminUrl) return false;
  await shell.openExternal(state.adminUrl);
  return true;
}

export function openUnifiedDesktopSetup(onComplete: () => void): boolean {
  if (!state.enabled || !state.ready || !setupRequired) return false;
  openCanonicalSetupWindow(() => {
    const dataDir = configuredDataDir();
    if (dataDir) removeBootstrapSecret(dataDir);
    state = { ...state, ownerConfigured: true };
    setupRequired = false;
    onComplete();
  });
  return true;
}

export async function stopUnifiedDesktopServer(): Promise<void> {
  closeCanonicalSetupWindow();
  const current = host;
  host = null;
  origin = '';
  identity = null;
  adminToken = null;
  desktopSetupToken = '';
  setupRequired = false;
  state = { ...state, ready: false };
  await current?.stop();
}
