import { clipboard, Menu, nativeImage, Tray } from 'electron';

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
  onOpenAdmin?: () => void;
  onQuit: () => void;
  port: number;
  getServerInfo?: () => { port: number; ipAddress: string | null; adminUrl: string | null };
};

let serverTray: Tray | null = null;
let trayRefreshTimer: ReturnType<typeof setInterval> | null = null;

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
  serverTray.setToolTip('LoomTV');
  let previousServerInfo = '';
  const refreshMenu = () => {
    if (!serverTray || serverTray.isDestroyed()) return;
    const info = options.getServerInfo?.() ?? { port: options.port, ipAddress: null, adminUrl: null };
    const signature = JSON.stringify(info);
    if (signature === previousServerInfo) return;
    previousServerInfo = signature;
    serverTray.setContextMenu(Menu.buildFromTemplate([
    {
      label: `Server running on port ${info.port}`,
      enabled: false,
    },
    { label: info.ipAddress ? `IP address: ${info.ipAddress}` : 'IP address: 127.0.0.1 (no LAN address)', enabled: false },
    { label: info.adminUrl ? `Admin URL: ${info.adminUrl}` : 'Admin URL: not configured', enabled: false },
    ...(info.adminUrl ? [{
      label: 'Copy admin URL',
      click: () => { if (info.adminUrl) clipboard.writeText(info.adminUrl); },
    }] : []),
    { type: 'separator' },
    {
      label: 'Open LoomTV',
      click: options.onOpen,
    },
    {
      label: 'Open from Web',
      click: options.onOpenWeb,
    },
    ...(options.onOpenAdmin ? [{
      label: 'Open Loom admin',
      click: options.onOpenAdmin,
    }] : []),
    { type: 'separator' },
    {
      label: 'Quit LoomTV',
      click: options.onQuit,
    },
    ]));
  };
  refreshMenu();
  // Server readiness and network interfaces can change after tray creation.
  trayRefreshTimer = setInterval(refreshMenu, 3000);
  trayRefreshTimer.unref();

  if (process.platform !== 'darwin') {
    serverTray.on('click', options.onOpen);
  }
  serverTray.on('double-click', options.onOpen);
  return serverTray;
}

export function destroyServerTray(): void {
  if (trayRefreshTimer) clearInterval(trayRefreshTimer);
  trayRefreshTimer = null;
  if (!serverTray || serverTray.isDestroyed()) return;
  serverTray.destroy();
  serverTray = null;
}
