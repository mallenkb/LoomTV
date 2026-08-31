import { app, type BrowserWindow } from 'electron';

export function openSettingsInWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;

  if (process.platform === 'darwin') {
    void app.dock?.show();
    app.focus({ steal: true });
  }

  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  void window.webContents.executeJavaScript("window.location.hash = '/settings';");
}

export function installSettingsShortcut(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    const modifierPressed = process.platform === 'darwin' ? input.meta : input.control;
    const isSettingsShortcut = input.type === 'keyDown'
      && input.key === ','
      && modifierPressed
      && !input.alt
      && !input.shift
      && !input.isAutoRepeat;

    if (!isSettingsShortcut) return;

    event.preventDefault();
    openSettingsInWindow(window);
  });
}
