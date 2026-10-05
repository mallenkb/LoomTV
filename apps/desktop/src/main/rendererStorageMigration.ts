import { BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PACKAGED_RENDERER_URL } from './rendererProtocol.ts';

// Preserve renderer preferences when moving from file:// to the cache-enabled
// origin. Both documents have scripts disabled and no IPC preload. Never copy
// sessionStorage, which can contain short-lived browser access credentials.
// Most keys start with "loom"; these older ones predate that convention.
const UNPREFIXED_KEYS = ['subtitlesDefaultEnabled', 'videoProgress'];
// Generous enough for a full localStorage origin (custom artwork is stored as
// data URLs), so a large profile is migrated instead of retrying forever.
const MAX_ENTRIES = 50_000;
const MAX_JSON_LENGTH = 32 * 1024 * 1024;

export function isMigratedStorageKey(key: string): boolean {
  return key.startsWith('loom') || UNPREFIXED_KEYS.includes(key);
}

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
      code: `Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('loom') || ${JSON.stringify(UNPREFIXED_KEYS)}.includes(key)))`,
    }]);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid stored preferences.');
    const entries = Object.entries(values).filter(([key, value]) => isMigratedStorageKey(key) && typeof value === 'string');
    if (entries.length > MAX_ENTRIES || JSON.stringify(entries).length > MAX_JSON_LENGTH) throw new Error('Stored preferences exceed migration limit.');
    if (entries.length) {
      await window.loadURL(PACKAGED_RENDERER_URL);
      await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `
        for (const [key, value] of ${JSON.stringify(entries)}) {
          try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch {}
        }
      ` }]);
    }
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(marker, '{}', { mode: 0o600 });
  } catch {
    console.warn('Renderer preferences could not be migrated; the next launch will retry.');
  } finally { window.destroy(); }
}
