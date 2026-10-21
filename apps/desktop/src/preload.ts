import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { createDesktopBridge } from './shared/createDesktopBridge';
import type { IdleTrimReason } from './main/idleMemoryTrim';

// The bridge lives in one module so tests exercise the exact object the
// renderer receives.
contextBridge.exposeInMainWorld('desktopApi', createDesktopBridge(ipcRenderer));

// Main sends this once after entering playback, or while the app is inactive.
// Wait for renderer idle time and only trim a meaningful amount of unused
// image data. Visible artwork, the current video and the disk cache stay warm.
// An inactivity trim is dropped if the user comes back during that wait, so it
// cannot evict artwork they are about to scroll back to.
const RETURN_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;
let memoryTrimPending = false;
let userReturned = false;
const markReturned = () => { userReturned = true; };
const markVisible = () => { if (document.visibilityState === 'visible') userReturned = true; };
function watchForReturn(watch: boolean): void {
  const method = watch ? 'addEventListener' : 'removeEventListener';
  for (const type of RETURN_EVENTS) window[method](type, markReturned, { capture: true });
  document[method]('visibilitychange', markVisible);
}
ipcRenderer.on('app:trim-memory', (_event, reason: IdleTrimReason) => {
  if (memoryTrimPending) return;
  memoryTrimPending = true;
  userReturned = false;
  // Playback trims run while the user watches; input then is expected.
  const inactivityTrim = reason !== 'playback';
  if (inactivityTrim) watchForReturn(true);
  window.requestIdleCallback(() => {
    memoryTrimPending = false;
    if (inactivityTrim) watchForReturn(false);
    if (userReturned) return;
    const { images } = webFrame.getResourceUsage();
    if (images.size - images.liveSize >= 16 * 1024 * 1024) webFrame.clearCache();
  }, { timeout: 5_000 });
});
