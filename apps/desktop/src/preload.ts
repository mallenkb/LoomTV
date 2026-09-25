import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { createDesktopBridge } from './shared/createDesktopBridge';

// The bridge lives in one module so tests exercise the exact object the
// renderer receives.
contextBridge.exposeInMainWorld('desktopApi', createDesktopBridge(ipcRenderer));

// Main sends this once after entering playback, or while the app is inactive.
// Wait for renderer idle time and only trim a meaningful amount of unused
// image data. Visible artwork, the current video and the disk cache stay warm.
let memoryTrimPending = false;
ipcRenderer.on('app:trim-memory', () => {
  if (memoryTrimPending) return;
  memoryTrimPending = true;
  window.requestIdleCallback(() => {
    memoryTrimPending = false;
    const { images } = webFrame.getResourceUsage();
    if (images.size - images.liveSize >= 16 * 1024 * 1024) webFrame.clearCache();
  }, { timeout: 5_000 });
});
