import { BrowserWindow, clipboard, Menu, nativeImage, screen, session, Tray } from 'electron';
import { randomUUID } from 'node:crypto';
import { serverTrayMenuHeight, serverTrayMenuHtml, TRAY_MENU_ACTION_ORIGIN, type ServerTrayMenuInfo } from './serverTrayMenu';

type ServerTrayOptions = {
  iconPath: string;
  /**
   * True when `iconPath` is the dedicated glyph-on-transparency tray asset.
   * A macOS template image is drawn from the alpha channel alone, so marking
   * the full-colour app icon as a template renders it as a solid rounded
   * square — the shape of its opaque background, not the logo.
   */
  iconIsTemplate: boolean;
  onOpen: () => void;
  onOpenWeb: () => void;
  getWebCopyUrl?: () => string;
  onOpenAdmin?: () => void | Promise<void>;
  onQuit: () => void;
  port: number;
  getServerInfo?: () => { port: number; adminUrl: string | null; webUrl?: string };
};

let serverTray: Tray | null = null;
let trayMenuWindow: BrowserWindow | null = null;
let trayMenuSession: ReturnType<typeof session.fromPartition> | null = null;
let trayRefreshTimer: ReturnType<typeof setInterval> | null = null;
const TRAY_MENU_PARTITION = 'loom-tray-menu';

// Electron 44 writes the clipboard asynchronously; log a failed copy instead of
// leaving an unhandled rejection in the main process.
function copyText(text: string): void {
  Promise.resolve(clipboard.writeText(text)).catch((error: unknown) => {
    console.warn('[tray] Could not copy to the clipboard:', error);
  });
}

function runTrayHandler(handler: (() => void | Promise<void>) | undefined): void {
  if (!handler) return;
  Promise.resolve(handler()).catch((error: unknown) => {
    console.warn('[tray] A tray action failed:', error);
  });
}

export function isServerTrayMenuWindow(window: BrowserWindow): boolean {
  return trayMenuSession !== null && window.webContents.session === trayMenuSession;
}

export function createServerTray(options: ServerTrayOptions): Tray | null {
  if (serverTray && !serverTray.isDestroyed()) return serverTray;

  const sourceIcon = nativeImage.createFromPath(options.iconPath);
  if (sourceIcon.isEmpty()) {
    console.warn('[tray] Could not load the LoomTV tray icon.');
    return null;
  }

  // The tray asset already ships at menu-bar size with an @2x variant, and
  // resizing it would collapse those representations into a single blurry one.
  // Only the oversized app-icon fallback needs scaling down.
  const trayIcon = options.iconIsTemplate
    ? sourceIcon
    : sourceIcon.resize({ width: process.platform === 'darwin' ? 18 : 20, height: process.platform === 'darwin' ? 18 : 20 });
  if (process.platform === 'darwin' && options.iconIsTemplate) trayIcon.setTemplateImage(true);

  serverTray = new Tray(trayIcon);
  serverTray.setToolTip('Loom');
  const hasAdminAction = Boolean(options.onOpenAdmin);
  let previousServerInfo = '';
  let displayedInfo: ServerTrayMenuInfo | null = null;
  let pendingLoad = Promise.resolve();
  let opening = false;
  const readInfo = (): ServerTrayMenuInfo => {
    const info = options.getServerInfo?.() ?? { port: options.port, adminUrl: null, webUrl: undefined };
    return { ...info, webUrl: info.webUrl ?? `http://127.0.0.1:${options.port}/app/` };
  };
  // Keep a native fallback for platforms whose tray implementation requires
  // a context menu, and for a failed popover load.
  const nativeMenu = (info: ServerTrayMenuInfo) => Menu.buildFromTemplate([
    { label: 'Open Loom', click: options.onOpen },
    { label: 'Open Web', click: options.onOpenWeb },
    ...(options.onOpenAdmin ? [{ label: 'Open Loom admin', click: () => runTrayHandler(options.onOpenAdmin) }] : []),
    { type: 'separator' },
    { label: `Port: ${info.port}`, click: () => copyText(String(info.port)) },
    { label: `Web URL: ${info.webUrl}`, click: () => copyText(options.getWebCopyUrl?.() ?? info.webUrl) },
    { label: `Admin URL: ${info.adminUrl ?? 'Not configured'}`, enabled: Boolean(info.adminUrl), click: () => { if (info.adminUrl) copyText(info.adminUrl); } },
    { type: 'separator' },
    { label: 'Quit Loom', click: options.onQuit },
  ]);
  const runAction = (action: string) => {
    const info = displayedInfo;
    trayMenuWindow?.destroy();
    switch (action) {
      case 'open': options.onOpen(); break;
      case 'open-web': options.onOpenWeb(); break;
      case 'open-admin': runTrayHandler(options.onOpenAdmin); break;
      case 'copy-port': if (info) copyText(String(info.port)); break;
      case 'copy-web': if (info) copyText(options.getWebCopyUrl?.() ?? info.webUrl); break;
      case 'copy-admin': if (info?.adminUrl) copyText(info.adminUrl); break;
      case 'quit': options.onQuit(); break;
    }
  };
  const ensureMenuWindow = () => {
    if (trayMenuWindow && !trayMenuWindow.isDestroyed()) return trayMenuWindow;
    trayMenuSession ??= session.fromPartition(TRAY_MENU_PARTITION);
    const window = new BrowserWindow({
      width: 480,
      height: serverTrayMenuHeight(hasAdminAction),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      autoHideMenuBar: true,
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      webPreferences: {
        session: trayMenuSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: false,
      },
    });
    trayMenuWindow = window;
    previousServerInfo = '';
    window.setMenu(null);
    window.setAlwaysOnTop(true, 'pop-up-menu');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (!window.isVisible()) return;
      try {
        const target = new URL(url);
        if (target.origin === TRAY_MENU_ACTION_ORIGIN && !target.search && !target.hash) {
          runAction(target.pathname.slice(1));
        }
      } catch { /* All other navigation stays blocked. */ }
    });
    window.on('blur', () => window.destroy());
    window.on('closed', () => { if (trayMenuWindow === window) trayMenuWindow = null; });
    return window;
  };
  const refreshMenu = () => {
    if (!serverTray || serverTray.isDestroyed()) return;
    const info = readInfo();
    const signature = JSON.stringify(info);
    if (signature === previousServerInfo) return;
    if (process.platform === 'linux') serverTray.setContextMenu(nativeMenu(info));
    previousServerInfo = signature;
    if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
    const window = trayMenuWindow;
    const html = serverTrayMenuHtml(info, hasAdminAction, randomUUID());
    pendingLoad = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
      if (trayMenuWindow === window) displayedInfo = info;
    }).catch(() => {
      previousServerInfo = '';
      throw new Error('The tray menu could not load.');
    });
    // Refreshes may run while the menu is hidden; avoid unhandled rejections.
    void pendingLoad.catch(() => undefined);
  };
  const toggleMenu = async () => {
    if (!serverTray || serverTray.isDestroyed() || opening) return;
    if (trayMenuWindow?.isVisible()) { trayMenuWindow.destroy(); return; }
    opening = true;
    try {
      const window = ensureMenuWindow();
      refreshMenu();
      await pendingLoad;
      if (!serverTray || serverTray.isDestroyed() || window.isDestroyed()) return;
      const anchor = serverTray.getBounds();
      const area = screen.getDisplayMatching(anchor).workArea;
      const width = Math.min(480, area.width - 16);
      const height = Math.min(serverTrayMenuHeight(hasAdminAction), area.height - 16);
      const x = Math.max(area.x + 8, Math.min(Math.round(anchor.x + anchor.width / 2 - width / 2), area.x + area.width - width - 8));
      const preferredY = anchor.y > area.y + area.height / 2 ? anchor.y - height - 4 : anchor.y + anchor.height + 4;
      const y = Math.max(area.y + 8, Math.min(preferredY, area.y + area.height - height - 8));
      window.setBounds({ x, y, width, height });
      window.show();
      window.focus();
    } catch {
      if (serverTray && !serverTray.isDestroyed()) serverTray.popUpContextMenu(nativeMenu(readInfo()));
    } finally {
      opening = false;
    }
  };
  refreshMenu();
  // Server readiness and network interfaces can change after tray creation.
  trayRefreshTimer = setInterval(refreshMenu, 3000);
  trayRefreshTimer.unref();

  serverTray.on('click', process.platform === 'darwin' ? () => { void toggleMenu(); } : options.onOpen);
  if (process.platform !== 'linux') serverTray.on('right-click', () => { void toggleMenu(); });
  serverTray.on('double-click', () => { trayMenuWindow?.destroy(); options.onOpen(); });
  return serverTray;
}

export function destroyServerTray(): void {
  if (trayRefreshTimer) clearInterval(trayRefreshTimer);
  trayRefreshTimer = null;
  trayMenuWindow?.destroy();
  trayMenuWindow = null;
  if (!serverTray || serverTray.isDestroyed()) return;
  serverTray.destroy();
  serverTray = null;
}
