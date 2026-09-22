import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { createDesktopBridge } from './shared/createDesktopBridge';

// The bridge lives in one module so tests exercise the exact object the
// renderer receives.
contextBridge.exposeInMainWorld('desktopApi', createDesktopBridge(ipcRenderer));

// Main sends this only while the window is hidden or the user is idle and
// nothing plays. Posters decode again from the local cache on return.
ipcRenderer.on('app:trim-memory', () => {
  webFrame.clearCache();
});
