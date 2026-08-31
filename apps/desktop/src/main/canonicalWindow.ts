import { app, BrowserWindow, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { registerDefaultSessionRequestHeaderRule } from './requestHeaderPolicy.ts';

const DESKTOP_SETUP_HEADER = 'x-loomtv-desktop-setup';

let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let canonicalOrigin = '';
let desktopSetupToken = '';
let setupChannelInstalled = false;

const SETUP_EXTERNAL_HOSTS = new Set([
  'www.themoviedb.org',
  'fanart.tv',
  'www.omdbapi.com',
  'www.opensubtitles.com',
]);

function allowedSetupExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SETUP_EXTERNAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function iconPath(): string | undefined {
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return [
    path.join(process.resourcesPath, name),
    path.join(app.getAppPath(), 'resources', name),
    path.join(__dirname, '../resources', name),
  ].find((candidate) => fs.existsSync(candidate));
}

function allowedHostedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === canonicalOrigin
      && (url.pathname === '/app' || url.pathname.startsWith('/app/') || url.pathname === '/admin'
        || url.pathname === '/admin/' || url.pathname === '/setup' || url.pathname === '/setup/');
  } catch {
    return false;
  }
}

/**
 * Attach this run's setup token to setup calls made by the desktop's own
 * window, at the network layer. The page never receives the value, so it stays
 * out of forms, URLs, logs, and browser storage, and the server accepts it only
 * over loopback — which is what lets desktop setup skip the copied secret.
 */
function installDesktopSetupChannel(): void {
  if (setupChannelInstalled || !desktopSetupToken || !canonicalOrigin) return;
  setupChannelInstalled = true;
  registerDefaultSessionRequestHeaderRule((details, headers) => {
    const sameOrigin = (() => {
      try { return new URL(details.url).origin === canonicalOrigin; } catch { return false; }
    })();
    if (sameOrigin && new URL(details.url).pathname.startsWith('/api/v1/setup/')) {
      headers[DESKTOP_SETUP_HEADER] = desktopSetupToken;
    }
  });
}

export function configureDesktopSetupChannel(token: string): void {
  desktopSetupToken = String(token || '');
  installDesktopSetupChannel();
}

function present(window: BrowserWindow): void {
  if (process.platform === 'darwin') {
    void app.dock?.show();
    app.focus({ steal: true });
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function configureCanonicalWindow(origin: string): void {
  canonicalOrigin = new URL(origin).origin;
  installDesktopSetupChannel();
}

export function getCanonicalWindow(): BrowserWindow | null {
  return mainWindow;
}

export function closeCanonicalSetupWindow(): void {
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.destroy();
  setupWindow = null;
}

/**
 * Show the shared setup page, then hand control back to the existing desktop
 * renderer when setup redirects to Home. The hosted web library is not used as
 * the desktop Home screen, so the user's current browsing and player UI stay
 * unchanged.
 */
export function openCanonicalSetupWindow(onComplete: () => void): void {
  if (!canonicalOrigin) throw new Error('The canonical desktop origin is not configured.');
  const target = new URL('/setup/?return=app', canonicalOrigin).toString();

  if (setupWindow && !setupWindow.isDestroyed()) {
    present(setupWindow);
    return;
  }

  setupWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    title: 'Set up LoomTV',
    show: false,
    backgroundColor: '#090909',
    ...(iconPath() ? { icon: iconPath() } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  let completed = false;
  const finish = (): void => {
    if (completed) return;
    completed = true;
    closeCanonicalSetupWindow();
    onComplete();
  };
  const handleNavigation = (event: Electron.Event, value: string): void => {
    let url: URL;
    try { url = new URL(value); } catch { event.preventDefault(); return; }
    if (url.origin !== canonicalOrigin) {
      event.preventDefault();
      return;
    }
    if (url.pathname === '/app' || url.pathname === '/app/') {
      event.preventDefault();
      finish();
      return;
    }
    if (url.pathname !== '/setup' && url.pathname !== '/setup/') event.preventDefault();
  };

  setupWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedSetupExternalUrl(url)) {
      void shell.openExternal(url).catch((error) => {
        console.warn('[setup] Could not open the metadata provider link:', error);
      });
    }
    return { action: 'deny' };
  });
  setupWindow.webContents.on('will-navigate', handleNavigation);
  setupWindow.webContents.on('will-redirect', handleNavigation);
  setupWindow.webContents.on('did-navigate', (_event, value) => {
    try {
      const url = new URL(value);
      if (url.origin === canonicalOrigin && (url.pathname === '/app' || url.pathname === '/app/')) finish();
    } catch { /* Navigation filtering already rejects malformed URLs. */ }
  });
  setupWindow.once('ready-to-show', () => {
    if (setupWindow && !setupWindow.isDestroyed()) present(setupWindow);
  });
  setupWindow.webContents.once('did-finish-load', () => {
    if (setupWindow && !setupWindow.isDestroyed()) present(setupWindow);
  });
  const created = setupWindow;
  setupWindow.once('closed', () => {
    if (setupWindow === created) setupWindow = null;
  });
  void setupWindow.loadURL(target);
}

export function openCanonicalWindow(pathname = '/app/'): void {
  if (!canonicalOrigin) throw new Error('The canonical desktop origin is not configured.');
  const target = new URL(pathname, canonicalOrigin).toString();
  if (!allowedHostedUrl(target)) throw new Error('The requested desktop route is not allowed.');

  if (mainWindow && !mainWindow.isDestroyed()) {
    const current = mainWindow.webContents.getURL();
    if (current !== target) void mainWindow.loadURL(target);
    present(mainWindow);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    title: 'LoomTV',
    show: false,
    backgroundColor: '#090909',
    ...(iconPath() ? { icon: iconPath() } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const rejectUnexpectedNavigation = (event: Electron.Event, url: string): void => {
    if (!allowedHostedUrl(url)) event.preventDefault();
  };
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', rejectUnexpectedNavigation);
  mainWindow.webContents.on('will-redirect', rejectUnexpectedNavigation);
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) present(mainWindow);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) present(mainWindow);
  });
  const created = mainWindow;
  mainWindow.once('closed', () => {
    if (mainWindow === created) mainWindow = null;
  });
  void mainWindow.loadURL(target);
}
