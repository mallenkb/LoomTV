import { BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PACKAGED_RENDERER_URL } from './rendererProtocol.ts';

// Preserve renderer preferences when moving from file:// to the cache-enabled
// origin. Both documents have scripts disabled and no IPC preload. Never copy
// sessionStorage, which can contain short-lived browser access credentials.
export async function migrateRendererStorage(legacyFile: string, userData: string): Promise<void> {
  const marker = path.join(userData, 'renderer-origin-migrated.json');
  try { await fs.access(marker); return; } catch { /* first launch on this origin */ }
  const window = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  try {
    await window.loadFile(legacyFile);
    // Chromium permits explicit isolated-world execution while page scripts
    // are disabled. Main-world executeJavaScript honors javascript: false.
    const values: unknown = await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{
      code: `Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('loom')))`,
    }]);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid stored preferences.');
    const entries = Object.entries(values).filter(([key, value]) => key.startsWith('loom') && typeof value === 'string');
    if (entries.length > 256 || JSON.stringify(entries).length > 1024 * 1024) throw new Error('Stored preferences exceed migration limit.');
    if (entries.length) {
      await window.loadURL(PACKAGED_RENDERER_URL);
      await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `
        for (const [key, value] of ${JSON.stringify(entries)}) {
          if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
        }
      ` }]);
    }
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(marker, '{}', { mode: 0o600 });
  } catch {
    console.warn('Renderer preferences could not be migrated; the next launch will retry.');
  } finally { window.destroy(); }
}
