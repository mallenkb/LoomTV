import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import vm from 'node:vm';
import test, { afterEach } from 'node:test';

const state = { legacy: {} as Record<string, string>, target: {} as Record<string, string>, windows: 0, destroyed: 0, targetLoads: 0, quotaExceeded: false };
class MigrationWindow {
  storage = state.legacy;
  constructor(options: { show: boolean; webPreferences: Record<string, unknown> }) {
    state.windows++;
    assert.equal(options.show, false);
    assert.equal(options.webPreferences.javascript, false);
    assert.equal(options.webPreferences.sandbox, true);
    assert.equal(options.webPreferences.nodeIntegration, false);
    assert.equal(options.webPreferences.preload, undefined);
  }
  webContents = {
    setWindowOpenHandler(handler: () => unknown) { assert.deepEqual(handler(), { action: 'deny' }); },
    on(_event: string, handler: (event: { preventDefault: () => void }) => void) {
      let prevented = false;
      handler({ preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true);
    },
    executeJavaScriptInIsolatedWorld: async (worldId: number, scripts: Array<{ code: string }>) => {
      assert.equal(worldId, 1001);
      assert.equal(scripts.length, 1);
      const storage = this.storage;
      const localStorage = { ...storage };
      Object.defineProperties(localStorage, {
        getItem: { value: (key: string) => storage[key] ?? null },
        setItem: { value: (key: string, value: string) => {
          if (state.quotaExceeded && storage === state.target) throw new Error('QuotaExceededError');
          storage[key] = value;
        } },
      });
      return vm.runInNewContext(scripts[0].code, { localStorage });
    },
  };
  async loadFile() { this.storage = state.legacy; }
  async loadURL(url: string) {
    assert.equal(url, 'loomtv://app/index.html');
    state.targetLoads++;
    this.storage = state.target;
  }
  destroy() { state.destroyed++; }
}
const stubKey = Symbol.for('loomtv.storage-migration-test.window');
Object.defineProperty(globalThis, stubKey, { value: MigrationWindow, configurable: true });
const moduleUrl = new URL('../src/main/rendererStorageMigration.ts', import.meta.url).href;
const stubUrl = `data:text/javascript,${encodeURIComponent("export const BrowserWindow = globalThis[Symbol.for('loomtv.storage-migration-test.window')]")}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron' && context.parentURL === moduleUrl) return { url: stubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { migrateRendererStorage } = await import('../src/main/rendererStorageMigration.ts');
hooks.deregister();

afterEach(() => Object.assign(state, { legacy: {}, target: {}, windows: 0, destroyed: 0, targetLoads: 0, quotaExceeded: false }));

test('origin migration copies Loom preferences once and keeps newer target preferences', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-storage-'));
  try {
    state.legacy = { 'loomtv:mode': 'host', 'loom:theme': 'blue', subtitlesDefaultEnabled: 'false', videoProgress: '{}', unrelated: 'omit' };
    state.target = { 'loom:theme': 'red' };
    await migrateRendererStorage('/renderer/index.html', directory);
    assert.deepEqual(state.target, { 'loomtv:mode': 'host', 'loom:theme': 'red', subtitlesDefaultEnabled: 'false', videoProgress: '{}' });
    assert.equal(state.destroyed, 1);
    await migrateRendererStorage('/renderer/index.html', directory);
    assert.equal(state.windows, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('empty legacy storage skips the target document and marks migration complete', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-storage-'));
  try {
    await migrateRendererStorage('/renderer/index.html', directory);
    assert.equal(state.targetLoads, 0);
    assert.equal(state.destroyed, 1);
    await fs.access(path.join(directory, 'renderer-origin-migrated.json'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a full profile with many cached items and artwork data URLs is migrated', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-storage-'));
  try {
    const artwork = `data:image/jpeg;base64,${'A'.repeat(3 * 1024 * 1024)}`;
    state.legacy = {
      ...Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`loomtv:watched-discover-item-v1:${index}`, '{}'])),
      loomtvCustomMovieArtwork: JSON.stringify({ movie: { poster: artwork } }),
    };
    await migrateRendererStorage('/renderer/index.html', directory);
    assert.equal(Object.keys(state.target).length, 2_001);
    assert.equal(state.target.loomtvCustomMovieArtwork, state.legacy.loomtvCustomMovieArtwork);
    await fs.access(path.join(directory, 'renderer-origin-migrated.json'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('oversized legacy preferences leave migration retryable and close the hidden window', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-storage-'));
  try {
    state.legacy = Object.fromEntries(Array.from({ length: 50_001 }, (_, index) => [`loom:${index}`, 'value']));
    await migrateRendererStorage('/renderer/index.html', directory);
    assert.equal(state.targetLoads, 0);
    assert.equal(state.destroyed, 1);
    await assert.rejects(fs.access(path.join(directory, 'renderer-origin-migrated.json')));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a quota failure leaves migration retryable and a later launch copies the key', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-storage-'));
  try {
    state.legacy = { 'loom:theme': 'blue', 'loom:volume': '0.5' };
    state.target = { 'loom:volume': '0.8' };
    state.quotaExceeded = true;
    await migrateRendererStorage('/renderer/index.html', directory);
    await assert.rejects(fs.access(path.join(directory, 'renderer-origin-migrated.json')));
    assert.deepEqual(state.target, { 'loom:volume': '0.8' });

    state.quotaExceeded = false;
    await migrateRendererStorage('/renderer/index.html', directory);
    assert.deepEqual(state.target, { 'loom:theme': 'blue', 'loom:volume': '0.8' });
    await fs.access(path.join(directory, 'renderer-origin-migrated.json'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
