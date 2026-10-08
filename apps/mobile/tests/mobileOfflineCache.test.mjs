import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { serializeMobileDatabaseMutation } from '../mobileDatabaseMutations.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function cacheFixture({ snapshotRead, progressRead } = {}) {
  const source = process.env.CACHE_TEST_SOURCE || fs.readFileSync(new URL('../mobileOfflineCache.ts', import.meta.url), 'utf8');
  const ready = deferred();
  const entered = deferred();
  const rows = new Map();
  const pendingRows = new Map();
  const db = {
    execAsync: async () => {},
    getFirstAsync: async () => snapshotRead ? snapshotRead.promise : null,
    getAllAsync: async (sql, host, profile) => sql.startsWith('PRAGMA') ? [{ name: 'last_seen_at' }]
      : sql.includes('mobile_offline_progress') && progressRead ? progressRead.promise
      : sql.includes('mobile_pending_progress') ? [...pendingRows.values()].filter((row) => row.host === host && row.profile === profile) : [],
    withTransactionAsync: async (operation) => operation(),
    runAsync: async (sql, ...args) => {
      if (sql.includes('INSERT INTO mobile_pending_progress')) {
        pendingRows.set(`${args[0]}:${args[1]}:${args[2]}`, { host: args[0], profile: args[1], media_id: args[2], media_path: args[3], payload: args[4] });
      }
      if (sql.startsWith('DELETE FROM mobile_pending_progress')) {
        const key = `${args[0]}:${args[1]}:${args[2]}`;
        if (pendingRows.get(key)?.payload === args[3]) pendingRows.delete(key);
      }
      if (sql.includes('INSERT INTO mobile_offline_snapshots')) {
        entered.resolve();
        await ready.promise;
        rows.set(args[0], args[1]);
      }
      if (sql.includes('DELETE FROM mobile_offline_snapshots WHERE host_device_id')) rows.delete(args[0]);
    },
  };
  const context = vm.createContext({
    serializeMobileDatabaseMutation,
    SQLite: { openDatabaseAsync: async () => db },
    reportNonFatal: () => {},
    activeMobileProgressPaths: () => new Set(),
    sameMobileCatalogIdentity: () => false,
  });
  const executable = stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${executable}\nglobalThis.cache = { saveMobileOfflineSnapshot, clearMobileOfflineSnapshot, loadMobileOfflineSnapshot, saveMobilePendingProgress: typeof saveMobilePendingProgress === 'function' ? saveMobilePendingProgress : undefined, loadMobilePendingProgress: typeof loadMobilePendingProgress === 'function' ? loadMobilePendingProgress : undefined, removeMobilePendingProgress: typeof removeMobilePendingProgress === 'function' ? removeMobilePendingProgress : undefined };`, context);
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

test('snapshot deletion invalidates a pending database read', async () => {
  const snapshotRead = deferred();
  const cache = cacheFixture({ snapshotRead });
  const restoring = cache.loadMobileOfflineSnapshot('host-a');
  await new Promise((resolve) => setImmediate(resolve));
  const clearing = cache.clearMobileOfflineSnapshot('host-a');
  snapshotRead.resolve({ payload: JSON.stringify({ ...snapshot, version: 1, savedAt: Date.now() }), saved_at: Date.now() });
  await clearing;
  assert.equal(await restoring, null);
});

test('local progress persists by profile and an old acknowledgement cannot erase a newer update', async () => {
  const cache = cacheFixture();
  const first = { mediaId: 'episode', mediaPath: 'episode', progress: { position: 200, duration: 1000, updatedAt: 10, watched: false } };
  await cache.saveMobilePendingProgress('host-a', 'profile-a', first);
  assert.equal((await cache.loadMobilePendingProgress('host-a', 'profile-a'))[0].progress.position, 200);
  assert.equal((await cache.loadMobilePendingProgress('host-a', 'profile-b')).length, 0);
  const newer = { ...first, progress: { ...first.progress, position: 300, updatedAt: 20 } };
  await cache.saveMobilePendingProgress('host-a', 'profile-a', newer);
  await cache.removeMobilePendingProgress('host-a', 'profile-a', first);
  assert.equal((await cache.loadMobilePendingProgress('host-a', 'profile-a'))[0].progress.position, 300);
  const { reconcileMobileProgress } = await import('../mobileProgressSync.ts');
  const sent = [];
  const merged = await reconcileMobileProgress({
    remote: { episode: first.progress }, pending: await cache.loadMobilePendingProgress('host-a', 'profile-a'),
    isCurrent: () => true,
    save: async (entry) => { sent.push(entry.progress.position); return entry.progress; },
    remove: (entry) => cache.removeMobilePendingProgress('host-a', 'profile-a', entry),
  });
  assert.deepEqual(sent, [300]);
  assert.equal(merged.episode.position, 300);
  assert.equal((await cache.loadMobilePendingProgress('host-a', 'profile-a')).length, 0);
});

test('snapshot deletion also invalidates a pending progress-row read', async () => {
  const snapshotRead = deferred();
  const progressRead = deferred();
  snapshotRead.resolve({ payload: JSON.stringify({ ...snapshot, version: 1, savedAt: Date.now() }), saved_at: Date.now() });
  const cache = cacheFixture({ snapshotRead, progressRead });
  const restoring = cache.loadMobileOfflineSnapshot('host-a');
  await new Promise((resolve) => setImmediate(resolve));
  const clearing = cache.clearMobileOfflineSnapshot('host-a');
  progressRead.resolve([]);
  await clearing;
  assert.equal(await restoring, null);
});
