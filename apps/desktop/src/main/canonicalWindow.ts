import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

let mainWindow: BrowserWindow | null = null;
let canonicalOrigin = '';

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
      && (url.pathname === '/app' || url.pathname.startsWith('/app/') || url.pathname === '/admin');
  } catch {
    return false;
  }
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
}

export function getCanonicalWindow(): BrowserWindow | null {
  return mainWindow;
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
