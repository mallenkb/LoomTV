import type { BrowserWindow, PowerMonitor, WebContents } from 'electron';

type RepaintWindow = Pick<BrowserWindow, 'on' | 'once' | 'removeListener' | 'isDestroyed' | 'isVisible' | 'isMinimized'> & {
  webContents: Pick<WebContents, 'isDestroyed' | 'invalidate'>;
};
type WakeMonitor = Pick<PowerMonitor, 'on' | 'removeListener'>;

/** Refresh transparent-window contents after macOS discards their backing pixels. */
export function installWindowRepaint(window: RepaintWindow, powerMonitor: WakeMonitor): void {
  const repaint = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()
      || !window.isVisible() || window.isMinimized()) return;
    window.webContents.invalidate();
  };
  window.on('focus', repaint);
  window.on('show', repaint);
  window.on('restore', repaint);
  powerMonitor.on('resume', repaint);
  powerMonitor.on('unlock-screen', repaint);
  powerMonitor.on('user-did-become-active', repaint);

  window.once('closed', () => {
    window.removeListener('focus', repaint);
    window.removeListener('show', repaint);
    window.removeListener('restore', repaint);
    powerMonitor.removeListener('resume', repaint);
    powerMonitor.removeListener('unlock-screen', repaint);
    powerMonitor.removeListener('user-did-become-active', repaint);
  });
}
