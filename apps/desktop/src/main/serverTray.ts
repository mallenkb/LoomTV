import { Menu, nativeImage, Tray } from 'electron';

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
  onQuit: () => void;
  port: number;
};

let serverTray: Tray | null = null;

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
  serverTray.setContextMenu(Menu.buildFromTemplate([
    {
      label: `Server running on port ${options.port}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open LoomTV',
      click: options.onOpen,
    },
    {
      label: 'Open from Web',
      click: options.onOpenWeb,
    },
    { type: 'separator' },
    {
      label: 'Quit LoomTV',
      click: options.onQuit,
    },
  ]));

  if (process.platform !== 'darwin') {
    serverTray.on('click', options.onOpen);
  }
  serverTray.on('double-click', options.onOpen);
  return serverTray;
}

export function destroyServerTray(): void {
  if (!serverTray || serverTray.isDestroyed()) return;
  serverTray.destroy();
  serverTray = null;
}
