import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function cacheFixture() {
  const source = process.env.CACHE_TEST_SOURCE || fs.readFileSync(new URL('../mobileOfflineCache.ts', import.meta.url), 'utf8');
  const ready = deferred();
  const entered = deferred();
  const rows = new Map();
  const db = {
    execAsync: async () => {},
    getAllAsync: async () => [{ name: 'last_seen_at' }],
    withTransactionAsync: async (operation) => operation(),
    runAsync: async (sql, ...args) => {
      if (sql.includes('INSERT INTO mobile_offline_snapshots')) {
        entered.resolve();
        await ready.promise;
        rows.set(args[0], args[1]);
      }
      if (sql.includes('DELETE FROM mobile_offline_snapshots WHERE host_device_id')) rows.delete(args[0]);
    },
  };
  const context = vm.createContext({
    SQLite: { openDatabaseAsync: async () => db },
    reportNonFatal: () => {},
    activeMobileProgressPaths: () => new Set(),
    sameMobileCatalogIdentity: () => false,
  });
  const executable = stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${executable}\nglobalThis.cache = { saveMobileOfflineSnapshot, clearMobileOfflineSnapshot };`, context);
  return { ...context.cache, rows, entered, release: () => ready.resolve(db) };
}

const snapshot = {
  hostDeviceId: 'host-a', activeProfile: null, automaticProfileSignIn: true,
  profiles: [], library: {}, libraryEtag: '', progress: {}, profileLists: [],
};

test('clear waits behind an active snapshot save and leaves no resurrected data', async () => {
  const cache = cacheFixture();
  const save = cache.saveMobileOfflineSnapshot(snapshot);
  await cache.entered.promise;
  const clear = cache.clearMobileOfflineSnapshot('host-a');
  await new Promise((resolve) => setImmediate(resolve));
  cache.release();
  await Promise.all([save, clear]);
  assert.equal(cache.rows.has('host-a'), false);
});

test('clear invalidates delayed snapshots captured before the lock', async () => {
  const cache = cacheFixture();
  cache.release();
  await cache.clearMobileOfflineSnapshot('host-a');
  await cache.saveMobileOfflineSnapshot(snapshot, 0);
  assert.equal(cache.rows.has('host-a'), false);
});
