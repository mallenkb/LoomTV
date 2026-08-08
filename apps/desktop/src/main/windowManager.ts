import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { windowChromeOptions } from './windowChrome';
import { pathToFileURL } from 'node:url';
import { isExpectedAppUrl } from './trustedIpcSender';

const MAIN_WINDOW_DEV_SERVER_URL =
  typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;
const MAIN_WINDOW_NAME =
  typeof MAIN_WINDOW_VITE_NAME === 'string' && MAIN_WINDOW_VITE_NAME ? MAIN_WINDOW_VITE_NAME : 'main_window';

let mainWindow: BrowserWindow | null = null;
export type MainWindowIpcIdentity = Readonly<{
  webContentsId: number;
  expectedAppUrl: string;
}>;
let mainWindowIpcIdentity: MainWindowIpcIdentity | null = null;

function packagedRendererFilePath(): string {
  return path.join(__dirname, `../renderer/${MAIN_WINDOW_NAME}/index.html`);
}

function expectedRendererAppUrl(): string {
  if (MAIN_WINDOW_DEV_SERVER_URL) return new URL(MAIN_WINDOW_DEV_SERVER_URL).origin;
  return pathToFileURL(path.resolve(packagedRendererFilePath())).toString();
}

function presentMainWindow(window: BrowserWindow): void {
  if (process.platform === 'darwin') {
    void app.dock?.show();
    // A hidden/background Electron process can otherwise keep the window on a
    // different Space even after the second-instance event reaches it.
    app.focus({ steal: true });
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getMainWindowIpcIdentity(): MainWindowIpcIdentity | null {
  return mainWindowIpcIdentity;
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

// The tray asset is the bare logo glyph on transparency, sized for the menu bar.
// `trayIcon@2x.png` sits beside it and Electron picks it up automatically on
// Retina displays, so only the 1x path is resolved here.
export function getTrayIconPath(): string | null {
  const candidates = ['trayIcon.png', 'lmtv-icon-nobg.svg.png'].flatMap((fileName) => [
    path.join(process.resourcesPath, fileName),
    path.join(app.getAppPath(), 'resources', fileName),
    path.join(__dirname, '../resources', fileName),
  ]);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    presentMainWindow(mainWindow);
    return;
  }

  const windowOptions: ConstructorParameters<typeof BrowserWindow>[0] = {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 540,
    title: 'LoomTV',
    show: false,
    ...windowChromeOptions(process.platform),
    // Native mpv renders in a borderless window behind LoomTV. Normal app
    // screens remain opaque; only the player becomes transparent while the
    // existing React controls remain above the video.
    transparent: true,
    // Keep the BrowserWindow backing transparent so the viewport-sized native
    // LibVLC child can be seen beneath the renderer's transparent player
    // chrome. The native host supplies the opaque player backdrop.
    backgroundColor: '#00000000',
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
  const expectedAppUrl = expectedRendererAppUrl();
  mainWindowIpcIdentity = Object.freeze({
    webContentsId: mainWindow.webContents.id,
    expectedAppUrl,
  });

  // `ready-to-show` is not guaranteed for every transparent/accelerated
  // renderer startup (especially after a Vite reload). Keep it as the fast
  // path, but also reveal on the first completed document load and via a short
  // timeout so the app cannot remain as an invisible process with a live
  // renderer.
  const revealWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    presentMainWindow(mainWindow);
  };

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const rejectUnexpectedNavigation = (details: { preventDefault: () => void; url: string; isMainFrame: boolean }): void => {
    if (!details.isMainFrame || !isExpectedAppUrl(details.url, expectedAppUrl)) details.preventDefault();
  };
  mainWindow.webContents.on('will-navigate', rejectUnexpectedNavigation);
  mainWindow.webContents.on('will-redirect', rejectUnexpectedNavigation);
  mainWindow.webContents.on('will-frame-navigate', rejectUnexpectedNavigation);

  mainWindow.on('ready-to-show', () => {
    revealWindow();
  });

  mainWindow.webContents.once('did-finish-load', revealWindow);
  setTimeout(revealWindow, 1500).unref();

  if (MAIN_WINDOW_DEV_SERVER_URL) {
    const rendererUrl = new URL(MAIN_WINDOW_DEV_SERVER_URL);
    if (process.env.LOOMTV_ONBOARDING_PREVIEW === 'connect') {
      rendererUrl.searchParams.set('onboarding', 'connect');
    }
    mainWindow.loadURL(rendererUrl.toString());
  } else {
    mainWindow.loadFile(packagedRendererFilePath());
  }

  mainWindow.webContents.on('did-finish-load', () => {
    revealWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const platformClass = `platform-${process.platform}`;
    void mainWindow.webContents.executeJavaScript(
      `document.body.classList.add(${JSON.stringify(platformClass)})`,
    );
  });

  const createdWindow = mainWindow;
  mainWindow.on('closed', () => {
    if (mainWindow !== createdWindow) return;
    mainWindow = null;
    mainWindowIpcIdentity = null;
  });
}
