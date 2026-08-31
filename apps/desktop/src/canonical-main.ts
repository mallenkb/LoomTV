import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  safeStorage,
  shell,
} from 'electron';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import squirrelStartup from 'electron-squirrel-startup';
import {
  canonicalStatePath,
  inspectCanonicalMigration,
  runCanonicalMigration,
} from '@loom-media-server/video-migration';
import { createCanonicalServerHost } from './main/canonicalServerHost';
import { findFFmpeg, findFFprobe } from './main/mediaBinaries';
import { getLocalNetworkAddresses } from './main/networkInfo';
import { advertiseLanService, unadvertiseLanService } from './main/lanDiscovery';
import { loadOrCreateLanTlsIdentity, type LanTlsIdentity } from './main/lanTlsIdentity';
import { createServerTray, destroyServerTray } from './main/serverTray';
import { getTrayIconPath, getWindowIconPath } from './main/windowManager';
import {
  buildUpdateMenu,
  clearUpdateQuitFallback,
  initAutoUpdater,
  startUpdateAdapter,
  stopUpdateCheckTimer,
} from './main/autoUpdater';
import {
  configureCanonicalWindow,
  configureDesktopSetupChannel,
  getCanonicalWindow,
  openCanonicalWindow,
} from './main/canonicalWindow';

if (squirrelStartup) app.quit();

app.setName('LoomTV');
const configuredUserDataDir = String(process.env.LOOMTV_DATA_DIR || '').trim();
const USER_DATA_DIR = configuredUserDataDir
  ? path.resolve(configuredUserDataDir)
  : path.join(app.getPath('appData'), 'LoomTV');
app.setPath('userData', USER_DATA_DIR);

if (!app.requestSingleInstanceLock()) app.exit(0);

type ProtectedSecret = { version: 1; encrypted: string };
type StartupCredential = { label: string; secret: string; path: string; removeAfterCopy: boolean };

let canonicalHost: ReturnType<typeof createCanonicalServerHost> | null = null;
let canonicalOrigin = '';
let startupWindow: BrowserWindow | null = null;
let shutdownStarted = false;
let shutdownComplete = false;

function startupDocument(message: string): string {
  const escaped = message
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Starting LoomTV</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #090909; color: #f5f5f5; }
    main { width: min(390px, calc(100vw - 48px)); }
    h1 { margin: 0 0 12px; font-size: 28px; letter-spacing: -0.03em; }
    p { margin: 0; color: #b8b8b8; font-size: 15px; line-height: 1.5; }
    .bar { height: 3px; margin-top: 28px; overflow: hidden; border-radius: 999px; background: #282828; }
    .bar::after { content: ""; display: block; width: 42%; height: 100%; border-radius: inherit; background: #f4c430; animation: move 1.1s ease-in-out infinite alternate; }
    @keyframes move { from { transform: translateX(-35%); } to { transform: translateX(175%); } }
  </style>
</head>
<body><main><h1>Starting LoomTV</h1><p>${escaped}</p><div class="bar"></div></main></body>
</html>`;
}

function showStartupProgress(message: string): void {
  if (!startupWindow || startupWindow.isDestroyed()) {
    startupWindow = new BrowserWindow({
      width: 480,
      height: 280,
      minWidth: 480,
      minHeight: 280,
      maxWidth: 480,
      maxHeight: 280,
      title: 'Starting LoomTV',
      backgroundColor: '#090909',
      resizable: false,
      maximizable: false,
      closable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    startupWindow.removeMenu();
    const created = startupWindow;
    startupWindow.once('closed', () => {
      if (startupWindow === created) startupWindow = null;
    });
  }
  void startupWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(startupDocument(message))}`);
  startupWindow.show();
}

function closeStartupProgress(): void {
  if (startupWindow && !startupWindow.isDestroyed()) startupWindow.destroy();
  startupWindow = null;
}

function protectedSecretPath(name: string): string {
  return path.join(USER_DATA_DIR, `${name}.secure.json`);
}

function readProtectedSecret(name: string): string | null {
  const target = protectedSecretPath(name);
  if (!fs.existsSync(target)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-protected credential storage is unavailable. LoomTV will not expose or replace the saved startup credential.');
  }
  const value = JSON.parse(fs.readFileSync(target, 'utf8')) as ProtectedSecret;
  if (value.version !== 1 || typeof value.encrypted !== 'string' || !value.encrypted) {
    throw new Error('The protected LoomTV startup credential is malformed.');
  }
  return safeStorage.decryptString(Buffer.from(value.encrypted, 'base64'));
}

function writeProtectedSecret(name: string, secret: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-protected credential storage is required before LoomTV can migrate this installation safely.');
  }
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const target = protectedSecretPath(name);
  const temporary = `${target}.${process.pid}.tmp`;
  const envelope: ProtectedSecret = {
    version: 1,
    encrypted: safeStorage.encryptString(secret).toString('base64'),
  };
  fs.writeFileSync(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch { /* Windows uses ACLs instead of POSIX modes. */ }
  return target;
}

function loadOrCreateProtectedSecret(name: string): { secret: string; path: string; created: boolean } {
  const existing = readProtectedSecret(name);
  if (existing) return { secret: existing, path: protectedSecretPath(name), created: false };
  const secret = randomBytes(24).toString('base64url');
  return { secret, path: writeProtectedSecret(name, secret), created: true };
}

function removeProtectedSecret(target: string): void {
  try { fs.unlinkSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function showCredential(credential: StartupCredential): Promise<void> {
  const result = await dialog.showMessageBox({
    type: 'info',
    title: credential.label,
    message: credential.label,
    detail: `${credential.secret}\n\nCopy this now. LoomTV will not put the secret in logs or the browser address.`,
    buttons: ['Copy and continue', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response !== 0) {
    app.quit();
    throw Object.assign(new Error('Startup stopped before the credential was copied.'), { code: 'startup_cancelled' });
  }
  clipboard.writeText(credential.secret);
  if (credential.removeAfterCopy) removeProtectedSecret(credential.path);
}

async function migrateLegacyDesktopIfNeeded(): Promise<StartupCredential | null> {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const canonicalDatabase = canonicalStatePath(USER_DATA_DIR);
  const legacyDatabase = path.join(USER_DATA_DIR, 'loomtv.sqlite');
  if (fs.existsSync(canonicalDatabase) || !fs.existsSync(legacyDatabase)) return null;

  showStartupProgress('Preparing your existing library. This first launch may take a few minutes, but it will not read every byte of every video.');
  const inspection = await inspectCanonicalMigration({ dataDir: USER_DATA_DIR });
  if (inspection.committed) return null;
  const credential = loadOrCreateProtectedSecret('canonical-migration-owner');
  const settingsPath = path.join(USER_DATA_DIR, 'settings.json');
  await runCanonicalMigration({
    dataDir: USER_DATA_DIR,
    desktopDatabase: legacyDatabase,
    ...(fs.existsSync(settingsPath) ? { desktopSettingsPath: settingsPath } : {}),
    owner: { password: credential.secret },
    allowContentHash: false,
    allowQuickHash: true,
  });
  return {
    label: 'Canonical migration complete',
    secret: credential.secret,
    path: credential.path,
    removeAfterCopy: true,
  };
}

function normalizedFingerprint(value: string): string {
  return String(value || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
}

function installCertificatePin(origin: string, expectedFingerprint: string): void {
  const expectedOrigin = new URL(origin).origin;
  app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
    let matches: boolean;
    try {
      matches = new URL(url).origin === expectedOrigin
        && normalizedFingerprint(new X509Certificate(certificate.data).fingerprint256) === expectedFingerprint;
    } catch {
      matches = false;
    }
    if (matches) event.preventDefault();
    callback(matches);
  });
}

function getJson<T>(url: string, identity: LanTlsIdentity): Promise<T> {
  const expected = Buffer.from(identity.certFingerprint, 'hex');
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      ca: identity.certificatePem,
      checkServerIdentity: (_host, certificate) => {
        const actual = certificate.raw ? createHash('sha256').update(certificate.raw).digest() : Buffer.alloc(0);
        return actual.length === expected.length && actual.equals(expected)
          ? undefined
          : new Error('The local LoomTV server certificate did not match its pinned identity.');
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 256 * 1024) request.destroy(new Error('The local server response was too large.'));
        else chunks.push(chunk);
      });
      response.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error('The local server did not respond.')));
    request.once('error', reject);
  });
}

/** Native folder chooser for setup, offered only through the trusted desktop channel. */
async function pickLibraryFolder(): Promise<string | null> {
  const window = getCanonicalWindow();
  const result = await (window
    ? dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a library folder' })
    : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Choose a library folder' }));
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

async function requestLegacyPairingApproval(request: { deviceName: string; address: string }): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'LoomTV device request',
    message: `${request.deviceName} wants to connect`,
    detail: `Network address: ${request.address}\n\nAllow this prior-generation client to browse and stream your library?`,
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

async function startCanonicalDesktop(): Promise<void> {
  showStartupProgress('Checking your library and server data.');
  const migrationCredential = await migrateLegacyDesktopIfNeeded();
  showStartupProgress('Starting the private LoomTV server.');
  const identity = loadOrCreateLanTlsIdentity(USER_DATA_DIR, getLocalNetworkAddresses());
  const bootstrap = fs.existsSync(canonicalStatePath(USER_DATA_DIR))
    ? readProtectedSecret('canonical-bootstrap')
    : loadOrCreateProtectedSecret('canonical-bootstrap').secret;
  const sourceAssets = path.resolve(app.getAppPath(), '../server/src');
  const desktopAssets = path.resolve(app.getAppPath(), 'src/headless');
  const packagedAsset = (name: string, developmentPath: string) => (
    app.isPackaged ? path.join(process.resourcesPath, name) : developmentPath
  );
  // Kept in memory for this run only. It authorizes setup from this app's own
  // window, so nobody has to copy a secret on the machine that owns the server.
  const desktopSetupToken = randomBytes(32).toString('base64url');
  configureDesktopSetupChannel(desktopSetupToken);

  canonicalHost = createCanonicalServerHost({
    migrationReady: true,
    host: '0.0.0.0',
    port: 3848,
    paths: {
      dataDir: USER_DATA_DIR,
      cacheDir: path.join(USER_DATA_DIR, 'canonical-cache'),
      mediaDir: null,
    },
    version: app.getVersion(),
    ffmpegPath: findFFmpeg() || undefined,
    ffprobePath: findFFprobe() || undefined,
    requireSecureTransport: true,
    requireBootstrapSecret: false,
    tls: { cert: identity.certificatePem, key: identity.privateKeyPem },
    certificateFingerprint: identity.certFingerprint,
    bootstrapSecret: bootstrap || undefined,
    adminHtmlPath: packagedAsset('admin.html', path.join(desktopAssets, 'admin.html')),
    adminIconsPath: packagedAsset('lucide-icons.svg', path.join(desktopAssets, 'lucide-icons.svg')),
    webAppHtmlPath: packagedAsset('web-app.html', path.join(sourceAssets, 'web-app.html')),
    setupHtmlPath: packagedAsset('setup.html', path.join(sourceAssets, 'setup.html')),
    desktopSetupToken,
    pickFolder: pickLibraryFolder,
    compatibilityHandler: async () => false,
    authorizeLegacyPairing: requestLegacyPairingApproval,
  });
  const address = await canonicalHost.start();
  canonicalOrigin = `https://127.0.0.1:${address.port}`;
  installCertificatePin(canonicalOrigin, identity.certFingerprint);
  configureCanonicalWindow(canonicalOrigin);

  const instanceId = createHash('sha256').update(`loomtv-desktop:${identity.certFingerprint}`).digest('hex').slice(0, 32);
  advertiseLanService({
    port: address.port,
    instanceId,
    deviceName: os.hostname(),
    protocolVersion: '2',
    certFingerprint: identity.certFingerprint,
  });

  if (migrationCredential) await showCredential(migrationCredential);
  // Setup itself decides where this launch lands. The desktop window carries
  // the trusted setup token, so an unclaimed server asks for a name and a
  // password here — never for the bootstrap secret, which stays on disk for
  // browser clients and is invalidated the moment an owner exists.
  const setup = await getJson<{ data?: { required?: boolean; ownerConfigured?: boolean } }>(
    `${canonicalOrigin}/api/v1/setup/state`, identity,
  );
  if (setup.data?.ownerConfigured) removeProtectedSecret(protectedSecretPath('canonical-bootstrap'));
  const firstRoute = setup.data?.required ? '/setup/' : '/app/';

  const trayGlyph = getTrayIconPath();
  const trayIcon = trayGlyph || getWindowIconPath();
  if (trayIcon) createServerTray({
    iconPath: trayIcon,
    iconIsTemplate: Boolean(trayGlyph),
    onOpen: () => openCanonicalWindow('/app/'),
    onOpenWeb: () => { void shell.openExternal(`${canonicalOrigin}/app/`); },
    onOpenAdmin: () => openCanonicalWindow('/admin/'),
    onQuit: () => app.quit(),
    port: address.port,
  });
  showStartupProgress(setup.data?.required ? 'Opening setup.' : 'Opening your library.');
  openCanonicalWindow(firstRoute);
  closeStartupProgress();
  initAutoUpdater({
    getMainWindow: getCanonicalWindow,
    stopNativePlayback: () => undefined,
    closeMediaServer: async () => {
      unadvertiseLanService();
      await canonicalHost?.stop();
    },
  });
  buildUpdateMenu();
  startUpdateAdapter();
}

app.whenReady().then(startCanonicalDesktop).catch(async (error) => {
  if ((error as { code?: string })?.code === 'startup_cancelled') return;
  closeStartupProgress();
  console.error('Failed to start LoomTV canonical desktop host:', error);
  await dialog.showMessageBox({
    type: 'error',
    title: 'LoomTV could not start',
    message: 'The canonical LoomTV server could not start.',
    detail: error instanceof Error ? error.message : String(error),
  }).catch(() => undefined);
  app.exit(1);
});

app.on('second-instance', () => {
  if (app.isReady() && canonicalOrigin) openCanonicalWindow('/app/');
});

app.on('activate', () => {
  if (canonicalOrigin) openCanonicalWindow('/app/');
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') app.dock?.hide();
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  clearUpdateQuitFallback();
  stopUpdateCheckTimer();
  destroyServerTray();
  unadvertiseLanService();
  closeStartupProgress();
  const window = getCanonicalWindow();
  if (window && !window.isDestroyed()) window.destroy();
  void canonicalHost?.stop().catch((error) => {
    console.error('Canonical server shutdown failed:', error);
  }).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
