import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopBridge } from './shared/createDesktopBridge';

// The bridge lives in one module so tests exercise the exact object the
// renderer receives.
contextBridge.exposeInMainWorld('desktopApi', createDesktopBridge(ipcRenderer));
