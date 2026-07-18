import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

const MAIN_WINDOW_DEV_SERVER_URL =
  typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;
const MAIN_WINDOW_NAME =
  typeof MAIN_WINDOW_VITE_NAME === 'string' && MAIN_WINDOW_VITE_NAME ? MAIN_WINDOW_VITE_NAME : 'main_window';

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getWindowIconPath(): string | null {
  const iconFileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const candidates = [
    path.join(process.resourcesPath, iconFileName),
    path.join(process.resourcesPath, 'icon', iconFileName),
    path.join(app.getAppPath(), 'resources', iconFileName),
    path.join(__dirname, '../resources', iconFileName),
    path.join(process.resourcesPath, 'icon.png'),
    path.join(app.getAppPath(), 'resources', 'icon.png'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function getTrayIconPath(): string | null {
  const fileName = 'lmtv-icon-nobg.svg.png';
  const candidates = [
    path.join(process.resourcesPath, fileName),
    path.join(app.getAppPath(), 'resources', fileName),
    path.join(__dirname, '../resources', fileName),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function createWindow(): void {
  if (process.platform === 'darwin') void app.dock?.show();

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const windowOptions: ConstructorParameters<typeof BrowserWindow>[0] = {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 540,
    title: 'LoomTV',
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      sandbox: true,
    },
  };
  const iconPath = getWindowIconPath();
  if (iconPath) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const expectedUrl = MAIN_WINDOW_DEV_SERVER_URL
      || new URL(`file://${path.join(__dirname, `../renderer/${MAIN_WINDOW_NAME}/index.html`)}`).toString();
    if (targetUrl !== expectedUrl) event.preventDefault();
  });

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });

  if (MAIN_WINDOW_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_NAME}/index.html`));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const platformClass = `platform-${process.platform}`;
    void mainWindow.webContents.executeJavaScript(
      `document.body.classList.add(${JSON.stringify(platformClass)})`,
    );
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}
