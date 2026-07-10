import { Menu, nativeImage, Tray } from 'electron';

type ServerTrayOptions = {
  iconPath: string;
  onOpen: () => void;
  onQuit: () => void;
  port: number;
};

let serverTray: Tray | null = null;

export function createServerTray(options: ServerTrayOptions): Tray | null {
  if (serverTray && !serverTray.isDestroyed()) return serverTray;

  const sourceIcon = nativeImage.createFromPath(options.iconPath);
  if (sourceIcon.isEmpty()) {
    console.warn('[tray] Could not load the Loom Media Server tray icon.');
    return null;
  }

  const trayIcon = sourceIcon.resize({
    width: process.platform === 'darwin' ? 18 : 20,
    height: process.platform === 'darwin' ? 18 : 20,
  });
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);

  serverTray = new Tray(trayIcon);
  serverTray.setToolTip('Loom Media Server');
  serverTray.setContextMenu(Menu.buildFromTemplate([
    {
      label: `Server running on port ${options.port}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open Loom Media Server',
      click: options.onOpen,
    },
    { type: 'separator' },
    {
      label: 'Quit Loom Media Server',
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
