import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranscodeCacheQuota } from '../src/transcode-cache-quota.js';

function fakeCache(files) {
  let walks = 0;
  const entry = (name, kind) => ({ name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => false });
  const fileSystem = {
    readdir: async (directory) => {
      if (directory.endsWith('/cache')) { walks += 1; return [entry('session-1', 'dir')]; }
      return Object.keys(files).map((name) => entry(name, 'file'));
    },
    stat: async (candidate) => ({ size: files[candidate.split('/').pop()] ?? 0 }),
    statfs: async () => ({ bavail: 1_000_000, bsize: 4096 }),
  };
  return { fileSystem, walks: () => walks };
}

test('HLS requests reuse a recent cache walk and walk again once it is stale', async () => {
  let clock = 1_000;
  const cache = fakeCache({ 'segment-00001.ts': 1000, 'segment-00002.ts': 2000 });
  const quota = createTranscodeCacheQuota({ rootPath: '/cache', fileSystem: cache.fileSystem, now: () => clock, minFreeBytes: 0 });

  const first = await quota.recentStatus(5_000);
  assert.equal(first.sessionBytes.get('session-1'), 3000);
  for (let index = 0; index < 20; index += 1) await quota.recentStatus(5_000);
  assert.equal(cache.walks(), 1, 'requests inside the window share one walk');

  clock += 5_001;
  await quota.recentStatus(5_000);
  assert.equal(cache.walks(), 2, 'a stale status triggers a new walk');

  // Admission always walks, so new sessions see the current cache.
  await quota.checkAdmission();
  assert.equal(cache.walks(), 3);
});

test('recent status still reports reservations made since the last walk', async () => {
  const cache = fakeCache({ 'segment-00001.ts': 1000 });
  const quota = createTranscodeCacheQuota({ rootPath: '/cache', fileSystem: cache.fileSystem, now: () => 1_000, minFreeBytes: 0, maxSessionBytes: 5000 });
  await quota.recentStatus(5_000);
  await quota.reserve('session-2', 'account-1', 4000);
  const status = await quota.recentStatus(5_000);
  assert.equal(status.reservedBytes, 4000);
});
