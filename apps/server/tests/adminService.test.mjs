import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createHeadlessAdminService,
  headlessAdminStateFilename,
  loginThrottleDelayMs,
} from '../src/admin-service.js';
import { createBootstrapSecurity } from '../src/secure-bootstrap.js';
import { createHeadlessMediaService } from '../src/media-service.js';
import { createPlaybackSessionRegistry } from '../src/playback-session-registry.js';
import { createCanonicalStateStore } from '../src/canonical-state-store.js';
import { createHeadlessClientState } from '../src/client-state.js';
import { createMediaItemId } from '@loom-media-server/media-core';
import { hasPermission } from '../src/auth-policy.js';

const OWNER_PASSWORD = 'correct-horse-battery';
const BOOTSTRAP_SECRET = 'test-bootstrap-secret-32-bytes-minimum';

async function makeService(overrides = {}) {
  const dataDir = overrides.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-admin-'));
  const bootstrapSecurity = createBootstrapSecurity({ dataDir, secret: BOOTSTRAP_SECRET });
  await bootstrapSecurity.initialize({ ownerConfigured: false });
  const service = createHeadlessAdminService({
    dataDir,
    version: '0.0.0-test',
    getRuntimeHealth: async () => ({ media: { state: 'online' } }),
    getSessions: async () => [],
    bootstrapSecurity,
    ...overrides.options,
  });
  return { service, dataDir };
}

function bearer(token) {
  return { headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: '127.0.0.1' } };
}

async function onboardedService(overrides = {}) {
  const { service, dataDir } = await makeService(overrides);
  const session = await service.createOwner({ name: 'Owner', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });
  const principal = await service.authenticateRequest(bearer(session.adminToken));
  return { service, dataDir, token: session.adminToken, principal };
}

async function waitForScan(service, principal, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const scan = await service.getScanStatus(principal);
    if (scan.state !== 'scanning') return scan;
    if (Date.now() - start > timeoutMs) throw new Error('Scan did not complete in time.');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

test('canonical rescans reuse relinked sources and retain source-less series across restart and deletion', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-canonical-scan-'));
  const store = createCanonicalStateStore({ dataDir });
  await store.start();
  const { service, principal } = await onboardedService({ dataDir, options: { stateStore: store } });
  t.after(async () => { await service.stop(); await store.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const rootPath = path.join(dataDir, 'library');
  await fs.mkdir(rootPath);
  const filePath = path.join(rootPath, 'Show.S01E01.mkv');
  await fs.writeFile(filePath, 'episode bytes');
  const stats = await fs.stat(filePath);
  const root = await service.addLibraryRoot({ path: rootPath, kind: 'tvShows' }, principal);
  store.replaceAllState({
    adminState: store.readAdminState(),
    catalogItems: [
      { id: 'series-1', kind: 'series', title: 'Show', createdAt: 123, updatedAt: 123 },
      { id: 'migrated-episode', kind: 'episode', title: 'Pilot', seriesId: 'series-1', seasonNumber: 1, episodeNumber: 1, createdAt: 123, updatedAt: 123 },
    ],
    mediaSources: [{ id: 'migrated-source', mediaId: 'migrated-episode', rootId: root.id, relativePath: path.basename(filePath),
      locator: filePath, state: 'online', fileExtension: 'mkv', sizeBytes: stats.size, modifiedAtMs: stats.mtimeMs, indexedAt: 123 }],
    mediaIdentityAliases: [{ namespace: 'desktop-path-hash', alias: createMediaItemId(filePath), mediaId: 'migrated-episode', createdAt: 123 }],
  });
  assert.deepEqual(store.resolveScanIdentity(filePath, createMediaItemId(filePath)), {
    mediaId: 'migrated-episode', sourceId: 'migrated-source', seriesId: 'series-1',
  });
  assert.equal(store.resolveScanIdentity(path.join(rootPath, 'alias.mkv'), createMediaItemId(filePath)).mediaId, 'migrated-episode');
  const reopened = (await makeService({ dataDir, options: { stateStore: store } })).service;
  t.after(() => reopened.stop());
  for (const mode of ['quick', 'full', 'metadata']) {
    await reopened.startLibraryScan({ mode }, principal);
    assert.equal((await waitForScan(reopened, principal)).state, 'completed');
    const items = await reopened.listLibraryItems(principal);
    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.id === 'migrated-episode').sourceId, 'migrated-source');
    assert.equal(items.find((item) => item.id === 'series-1').available, true);
    assert.equal(store.listMediaSources('migrated-episode').length, 1);
    assert.equal(store.readAdminState().catalog.find((item) => item.id === 'migrated-episode').seriesId, 'series-1');
  }
  await reopened.deleteLibraryItem('migrated-episode', principal);
  await store.stop();
  await store.start();
  assert.equal(store.readMediaSource('migrated-episode'), null);
  assert.deepEqual(store.readAdminState().catalog.map((item) => item.id), ['series-1']);
});

test('a failed canonical scan write leaves the cached and persisted catalog unchanged', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-scan-failure-'));
  const store = createCanonicalStateStore({ dataDir });
  await store.start();
  let failCompleted = false;
  const adapter = { ...store, replaceAdminState(state) {
    if (failCompleted && state.scan?.state === 'completed') throw new Error('Injected catalog persistence failure');
    return store.replaceAdminState(state);
  } };
  const { service, principal } = await onboardedService({ dataDir, options: { stateStore: adapter } });
  t.after(async () => { await service.stop(); await store.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const rootPath = path.join(dataDir, 'library');
  await fs.mkdir(rootPath);
  await fs.writeFile(path.join(rootPath, 'first.mkv'), 'first');
  await service.addLibraryRoot({ path: rootPath, kind: 'movies' }, principal);
  await service.startLibraryScan({}, principal);
  assert.equal((await waitForScan(service, principal)).state, 'completed');
  const before = await service.listLibraryItems(principal);
  await fs.writeFile(path.join(rootPath, 'second.mkv'), 'second');
  failCompleted = true;
  await service.startLibraryScan({}, principal);
  assert.equal((await waitForScan(service, principal)).state, 'failed');
  assert.deepEqual(await service.listLibraryItems(principal), before);
  assert.deepEqual(store.readAdminState().catalog.map((item) => item.id), before.map((item) => item.id));
});

test('catalog ratings survive projection and quick rescans while child restrictions stay live', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-catalog-ratings-'));
  const store = createCanonicalStateStore({ dataDir });
  await store.start();
  const rootPath = path.join(dataDir, 'library');
  await fs.mkdir(rootPath);
  const ratings = [
    { US: { minimumAge: 8, label: 'PG', source: 'fixture' }, GB: { minimumAge: 12, label: '12', source: 'fixture' } },
    { US: { minimumAge: 18, label: 'R', source: 'fixture' } },
    null,
  ];
  const sources = await Promise.all(ratings.map(async (_rating, index) => {
    const locator = path.join(rootPath, `movie-${index}.mkv`);
    await fs.writeFile(locator, 'movie fixture');
    const stats = await fs.stat(locator);
    return { id: `source-${index}`, mediaId: `movie-${index}`, rootId: 'root-1', relativePath: path.basename(locator),
      locator, state: 'online', fileExtension: 'mkv', sizeBytes: stats.size, modifiedAtMs: stats.mtimeMs, indexedAt: 123 };
  }));
  store.replaceAllState({
    adminState: { owner: { id: 'owner-1', name: 'Owner', salt: 'salt', hash: 'hash', createdAt: 123 },
      roots: [{ id: 'root-1', path: rootPath, kind: 'movies', createdAt: 123 }] },
    catalogItems: ratings.map((contentRatings, index) => ({ id: `movie-${index}`, kind: 'movie', title: `Movie ${index}`,
      ...(contentRatings ? { contentRatings } : {}), createdAt: 123, updatedAt: 123 })),
    mediaSources: sources,
    mediaIdentityAliases: sources.map((source) => ({ namespace: 'desktop-path-hash', alias: createMediaItemId(source.locator), mediaId: source.mediaId, createdAt: 123 })),
    clientState: {
      profiles: [{ id: 'child-1', name: 'Child', kind: 'child', createdAt: 123, updatedAt: 123 }],
      assignments: [{ profileId: 'child-1', accountId: 'owner-1', access: 'manage', createdAt: 123 }],
      selections: [{ profileId: 'child-1', accountId: 'owner-1', deviceId: 'account:owner-1', revision: 1 }],
      profileRestrictions: [{ profileId: 'child-1', allowedRootIds: ['root-1'], country: 'US', maximumAge: 12, allowUnrated: false, revision: 1 }],
    },
  });
  const { service } = await makeService({ dataDir, options: { stateStore: store } });
  const client = createHeadlessClientState({ store });
  t.after(async () => { await service.stop(); await store.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const principal = await service.getPrincipalById('owner-1');
  async function assertRatedCatalog(activeService) {
    const items = await activeService.listLibraryItems(principal);
    assert.deepEqual(items.find((item) => item.id === 'movie-0').contentRatings, ratings[0], 'country, label, and rating provenance survive the scanner projection');
    assert.deepEqual(items.find((item) => item.id === 'movie-1').contentRatings, ratings[1]);
    const check = await client.activePlaybackProfileChecker('owner-1', 'account:owner-1');
    assert.equal(check(items.find((item) => item.id === 'movie-0')).profileId, 'child-1');
    assert.throws(() => check(items.find((item) => item.id === 'movie-1')), { code: 'permission_denied' });
    assert.throws(() => check(items.find((item) => item.id === 'movie-2')), { code: 'permission_denied' });
    return items;
  }
  await assertRatedCatalog(service);
  await service.startLibraryScan({ mode: 'quick' }, principal);
  assert.equal((await waitForScan(service, principal)).state, 'completed');
  await assertRatedCatalog(service);
  const reopened = (await makeService({ dataDir, options: { stateStore: store } })).service;
  t.after(() => reopened.stop());
  const items = await assertRatedCatalog(reopened);
  store.mutateClientState((state) => { state.profileRestrictions[0].maximumAge = 6; state.profileRestrictions[0].revision += 1; });
  const tightened = await client.activePlaybackProfileChecker('owner-1', 'account:owner-1');
  assert.throws(() => tightened(items.find((item) => item.id === 'movie-0')), { code: 'permission_denied' }, 'a new request applies the current age restriction');
  store.mutateClientState((state) => { state.selections[0].profileId = null; });
  await assert.rejects(client.activePlaybackProfileChecker('owner-1', 'account:owner-1'), { code: 'profile_required' });
});

function fileSystemError(code) {
  return Object.assign(new Error(code), { code });
}

function storageCheck(health) {
  return health.checks.find((entry) => entry.name === 'Persistent storage');
}

test('quick admin scans reuse probes and refresh changed and removed sidecars after reload', async (t) => {
  let probeCalls = 0;
  const options = { probeMedia: async (_path, { sourceId }) => {
    probeCalls += 1;
    return { sourceId, container: 'matroska', tracks: [], chapters: [], hdr: false, probedAt: 1, adapterGaps: [] };
  } };
  const { service, dataDir, principal } = await onboardedService({ options });
  const rootPath = path.join(dataDir, 'media');
  await fs.mkdir(rootPath);
  await fs.writeFile(path.join(rootPath, 'stable.mkv'), 'video');
  const sidecar = path.join(rootPath, 'stable.en.srt');
  await fs.writeFile(sidecar, 'first');
  await service.addLibraryRoot({ path: rootPath }, principal);
  await service.startLibraryScan({ mode: 'quick' }, principal);
  assert.equal((await waitForScan(service, principal)).state, 'completed');
  assert.equal(probeCalls, 1);
  await service.stop();
  const statePath = path.join(dataDir, headlessAdminStateFilename);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.catalog[0].summary = 'Keep descriptive enrichment.';
  await fs.writeFile(statePath, JSON.stringify(state));
  const { service: reloaded } = await makeService({ dataDir, options });
  t.after(async () => { await reloaded.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await fs.writeFile(sidecar, 'changed subtitle contents');
  await reloaded.startLibraryScan({ mode: 'quick' }, principal);
  assert.equal((await waitForScan(reloaded, principal)).state, 'completed');
  assert.equal(probeCalls, 1);
  let saved = JSON.parse(await fs.readFile(statePath, 'utf8')).catalog[0];
  assert.equal(saved.summary, 'Keep descriptive enrichment.');
  assert.equal(saved.localMetadata.container, 'matroska');
  assert.equal(saved.subtitleSidecars[0].sizeBytes, Buffer.byteLength('changed subtitle contents'));
  await fs.unlink(sidecar);
  await reloaded.startLibraryScan({ mode: 'quick' }, principal);
  await waitForScan(reloaded, principal);
  saved = JSON.parse(await fs.readFile(statePath, 'utf8')).catalog[0];
  assert.deepEqual(saved.subtitleSidecars, []);
  assert.equal(probeCalls, 1);
});

test('source-less canonical series remain listed and cannot resolve for playback', async (t) => {
  const { service, dataDir } = await makeService({ options: { stateStore: {
    readAdminState: () => ({ catalog: [{ id: 'series-1', rootId: null, path: null, kind: 'series', title: 'Migrated series' }] }),
    replaceAdminState() {},
    listMediaSources: () => [],
    readMediaSource: () => null,
  } } });
  t.after(async () => { await service.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const items = await service.listLibraryItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Migrated series');
  assert.equal(items[0].available, false);
  assert.deepEqual(items[0].sourceIds, []);
  await assert.rejects(service.resolveMediaPath('series-1', null), { status: 404 });
});

test('admin storage health verifies a writable directory and removes its probe file', async () => {
  const { service, dataDir } = await makeService({
    options: {
      storageFileSystem: {
        statfs: async () => ({ blocks: 1_000_000, bsize: 1_024, bavail: 900_000 }),
      },
    },
  });

  const health = await service.getHealth(null);
  assert.deepEqual(health.storage, {
    path: dataDir,
    available: true,
    writable: true,
    state: 'writable',
    totalBytes: 1_024_000_000,
    freeBytes: 921_600_000,
  });
  assert.equal(storageCheck(health)?.state, 'pass');
  assert.equal((await fs.readdir(dataDir)).some((name) => name.startsWith('.loomtv-storage-probe-')), false);

  const publicSummary = await service.getHealth(null, { summary: true });
  assert.equal(Object.hasOwn(publicSummary, 'storage'), false);
  assert.equal(storageCheck(publicSummary), undefined);
});

test('admin storage health distinguishes permission-denied and read-only directories from missing paths', async (t) => {
  for (const [errorCode, expectedState] of [['EACCES', 'permission-denied'], ['EROFS', 'read-only']]) {
    await t.test(errorCode, async () => {
      let accessMode;
      let probeCalled = false;
      const { service } = await makeService({
        options: {
          storageFileSystem: {
            access: async (_targetPath, mode) => {
              accessMode = mode;
              throw fileSystemError(errorCode);
            },
            statfs: async () => ({ blocks: 100, bsize: 4_096, bavail: 50 }),
          },
          storageWriteProbe: async () => { probeCalled = true; },
        },
      });

      const health = await service.getHealth(null);
      assert.equal(accessMode, fsConstants.W_OK);
      assert.equal(probeCalled, false);
      assert.equal(health.storage.available, true);
      assert.equal(health.storage.writable, false);
      assert.equal(health.storage.state, expectedState);
      assert.equal(storageCheck(health)?.state, 'warn');
    });
  }

  await t.test('ENOENT', async () => {
    let postStatCall = false;
    const { service } = await makeService({
      options: {
        storageFileSystem: {
          stat: async () => { throw fileSystemError('ENOENT'); },
          statfs: async () => { postStatCall = true; },
          access: async () => { postStatCall = true; },
        },
        storageWriteProbe: async () => { postStatCall = true; },
      },
    });

    const health = await service.getHealth(null);
    assert.equal(postStatCall, false);
    assert.deepEqual(health.storage, {
      path: health.storage.path,
      available: false,
      writable: false,
      state: 'missing',
    });
    assert.equal(storageCheck(health)?.message, 'Data directory is missing.');
  });
});

test('admin storage health reports a mocked disk write error after closing and cleaning the probe', async () => {
  const calls = [];
  const { service } = await makeService({
    options: {
      storageFileSystem: {
        statfs: async () => ({ blocks: 100, bsize: 4_096, bavail: 50 }),
        open: async (probePath, flags, mode) => {
          calls.push(['open', path.basename(probePath), flags, mode]);
          return {
            writeFile: async () => {
              calls.push(['write']);
              throw fileSystemError('ENOSPC');
            },
            sync: async () => { calls.push(['sync']); },
            close: async () => { calls.push(['close']); },
          };
        },
        rm: async (probePath, options) => { calls.push(['rm', path.basename(probePath), options]); },
      },
    },
  });

  const health = await service.getHealth(null);
  assert.equal(health.storage.available, true);
  assert.equal(health.storage.writable, false);
  assert.equal(health.storage.state, 'write-failed');
  assert.deepEqual(calls.map(([operation]) => operation), ['open', 'write', 'close', 'rm']);
  assert.equal(calls[0][2], 'wx');
  assert.equal(calls[0][3], 0o600);
  assert.deepEqual(calls[3][2], { force: true });
});

test('admin storage health bounds an injected hanging write probe', async () => {
  let probeCalls = 0;
  const { service } = await makeService({
    options: {
      storageFileSystem: {
        statfs: async () => ({ blocks: 100, bsize: 4_096, bavail: 50 }),
      },
      storageProbeTimeoutMs: 20,
      storageWriteProbe: async () => {
        probeCalls += 1;
        return new Promise(() => {});
      },
    },
  });

  const startedAt = Date.now();
  const health = await service.getHealth(null);
  assert.ok(Date.now() - startedAt < 500, 'storage health must return instead of waiting on the hanging probe');
  assert.equal(health.storage.available, true);
  assert.equal(health.storage.writable, false);
  assert.equal(health.storage.state, 'probe-timeout');
  assert.equal(storageCheck(health)?.message, 'Data directory write probe timed out.');

  const repeatedHealth = await service.getHealth(null);
  assert.equal(repeatedHealth.storage.state, 'probe-timeout');
  assert.equal(probeCalls, 1, 'repeated health checks must share a still-running filesystem probe');
});

test('admin storage health surfaces cleanup failure after always attempting rm and unlink', async () => {
  const calls = [];
  const { service } = await makeService({
    options: {
      storageFileSystem: {
        statfs: async () => ({ blocks: 100, bsize: 4_096, bavail: 50 }),
        open: async () => ({
          writeFile: async () => { calls.push('write'); },
          sync: async () => { calls.push('sync'); },
          close: async () => { calls.push('close'); },
        }),
        rm: async () => {
          calls.push('rm');
          throw fileSystemError('EBUSY');
        },
        unlink: async () => {
          calls.push('unlink');
          throw fileSystemError('EBUSY');
        },
      },
    },
  });

  const health = await service.getHealth(null);
  assert.equal(health.storage.available, true);
  assert.equal(health.storage.writable, false);
  assert.equal(health.storage.state, 'cleanup-failed');
  assert.deepEqual(calls, ['write', 'sync', 'close', 'rm', 'unlink']);
  assert.equal(storageCheck(health)?.message, 'Data directory write probe could not clean up its temporary file.');
});

test('owner onboarding issues a usable session and cannot run twice', async () => {
  const { service } = await makeService();
  assert.equal(await service.isOwnerConfigured(), false);

  await assert.rejects(
    () => service.createOwner({ name: 'Owner', password: OWNER_PASSWORD }),
    (error) => error.status === 401 && error.code === 'bootstrap_secret_invalid',
  );
  const session = await service.createOwner({ name: 'Owner', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });
  assert.equal(typeof session.adminToken, 'string');
  assert.equal(session.user.type, 'owner');
  assert.equal(await service.isOwnerConfigured(), true);

  const principal = await service.authenticateRequest(bearer(session.adminToken));
  assert.equal(principal.type, 'owner');
  await assert.rejects(
    () => service.createOwner({ name: 'Second', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET }),
    (error) => error.status === 409,
  );
});

test('concurrent owner bootstrap never shares the winning session token', async () => {
  const { service } = await makeService();
  const attempts = await Promise.allSettled([
    service.createOwner({ name: 'Owner', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET, address: '192.0.2.20' }),
    service.createOwner({ name: 'Owner', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET, address: '192.0.2.21' }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  const rejected = attempts.find((attempt) => attempt.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
});

test('bootstrap lockout is independent from normal login attempts', async () => {
  const { service } = await makeService();
  let bootstrapLock;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await service.createOwner({
        name: 'Owner',
        password: OWNER_PASSWORD,
        bootstrapSecret: `invalid-bootstrap-secret-${attempt}`,
        address: '192.0.2.30',
      });
    } catch (error) {
      if (error.code === 'bootstrap_locked') bootstrapLock = error;
      else assert.equal(error.code, 'bootstrap_secret_invalid');
    }
  }
  assert.equal(bootstrapLock?.status, 429);

  await service.createOwner({
    name: 'Owner',
    password: OWNER_PASSWORD,
    bootstrapSecret: BOOTSTRAP_SECRET,
    address: '192.0.2.31',
  });
  await assert.rejects(
    () => service.createSession({ password: 'wrong-password', address: '192.0.2.30' }),
    (error) => error.status === 401 && error.code === 'invalid_credentials',
  );
});

test('sign-in rejects bad credentials with a generic error and locks out after repeated failures', async () => {
  const { service } = await onboardedService();

  await assert.rejects(
    () => service.createSession({ password: 'wrong-password-1' }),
    (error) => error.status === 401 && error.code === 'invalid_credentials',
  );

  let locked;
  for (let attempt = 0; attempt < 6 && !locked; attempt += 1) {
    try {
      await service.createSession({ password: `wrong-password-${attempt + 2}` });
    } catch (error) {
      if (error.code === 'login_locked') locked = error;
      else assert.equal(error.code, 'invalid_credentials');
    }
  }
  assert.ok(locked, 'repeated failures must lock the account');
  assert.equal(locked.status, 429);
  assert.equal(typeof locked.retryAfter, 'number');

  // The lockout must also block the *correct* password.
  await assert.rejects(
    () => service.createSession({ password: OWNER_PASSWORD }),
    (error) => error.code === 'login_locked',
  );
});

test('shared address failures throttle without hard-locking another identity', async () => {
  const delays = [];
  const { service } = await onboardedService({
    options: { loginDelay: async (milliseconds) => { delays.push(milliseconds); } },
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => service.createSession({
        username: `unknown-${attempt}`,
        password: 'wrong-password',
        address: attempt % 2 === 0 ? '192.0.2.50' : '::ffff:192.0.2.50',
      }),
      (error) => error.code === 'invalid_credentials',
    );
  }

  const valid = await service.createSession({
    username: 'owner',
    password: OWNER_PASSWORD,
    address: '::ffff:192.0.2.50',
  });
  assert.equal(typeof valid.adminToken, 'string');

  await service.createSession({
    username: 'owner',
    password: OWNER_PASSWORD,
    address: '192.0.2.51',
  });
  assert.deepEqual(delays, [250, 250, 250, 250, 250, 500, 250]);
});

test('owner aliases share one per-account lockout bucket', async () => {
  const { service } = await makeService({ options: { loginDelay: async () => {} } });
  await service.createOwner({ name: 'Alice', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(
      () => service.createSession({ username: 'owner', password: `wrong-password-${attempt}` }),
      (error) => error.code === 'invalid_credentials',
    );
  }
  await assert.rejects(
    () => service.createSession({ username: 'Alice', password: 'wrong-password-final' }),
    (error) => error.code === 'login_locked',
  );
  await assert.rejects(
    () => service.createSession({ username: 'owner', password: OWNER_PASSWORD }),
    (error) => error.code === 'login_locked',
  );
});

test('pre-upgrade owner lockouts remain effective across owner aliases', async () => {
  const { service, dataDir } = await makeService({ options: { loginDelay: async () => {} } });
  await service.createOwner({ name: 'Alice', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });
  const statePath = path.join(dataDir, headlessAdminStateFilename);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const now = Date.now();
  state.loginAttempts = [{
    key: createHash('sha256').update('identity:owner').digest('hex'),
    failures: 5,
    firstAttemptAt: now,
    lastAttemptAt: now,
    lockedUntil: now + 60_000,
  }];
  await fs.writeFile(statePath, JSON.stringify(state));

  const { service: reloaded } = await makeService({
    dataDir,
    options: { loginDelay: async () => {} },
  });
  await assert.rejects(
    () => reloaded.createSession({ username: 'Alice', password: OWNER_PASSWORD }),
    (error) => error.code === 'login_locked',
  );
});

test('pre-upgrade owner failures contribute to the stable account bucket', async () => {
  const { service, dataDir } = await makeService({ options: { loginDelay: async () => {} } });
  await service.createOwner({ name: 'Alice', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });
  const statePath = path.join(dataDir, headlessAdminStateFilename);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const now = Date.now();
  state.loginAttempts = [{
    key: createHash('sha256').update('identity:owner').digest('hex'),
    failures: 4,
    firstAttemptAt: now,
    lastAttemptAt: now,
    lockedUntil: 0,
  }];
  await fs.writeFile(statePath, JSON.stringify(state));

  const { service: reloaded } = await makeService({
    dataDir,
    options: { loginDelay: async () => {} },
  });
  await assert.rejects(
    () => reloaded.createSession({ username: 'Alice', password: 'wrong-password-final' }),
    (error) => error.code === 'login_locked',
  );
});

test('shared address throttle delay uses deterministic bounded buckets', () => {
  assert.deepEqual(
    [0, 4, 5, 9, 10, 14, 15, 100].map(loginThrottleDelayMs),
    [250, 250, 500, 500, 1_000, 1_000, 2_000, 2_000],
  );
});

test('revoked and garbage tokens do not authenticate', async () => {
  const { service, token } = await onboardedService();
  await service.revokeRequest(bearer(token));
  assert.equal(await service.authenticateRequest(bearer(token)), null);
  assert.equal(await service.authenticateRequest(bearer('not-a-real-token')), null);
  assert.equal(await service.authenticateRequest({ headers: {} }), null);
});

test('credential resets enforce privilege scope, verify self-service, revoke sessions, and write safe audit details', async () => {
  const { service, dataDir, principal: owner } = await onboardedService();
  const managerPassword = 'manager-password-1';
  const limitedAdminPassword = 'limited-admin-password-1';
  const broadAdminPassword = 'broad-admin-password-1';
  const viewerPassword = 'viewer-password-1';

  const manager = await service.createUser({
    name: 'Manager',
    password: managerPassword,
    role: 'user',
    permissions: ['users.manage', 'account.password'],
    rootIds: null,
  }, owner);
  const limitedAdmin = await service.createUser({
    name: 'Limited admin',
    password: limitedAdminPassword,
    role: 'admin',
    permissions: ['users.manage', 'account.password'],
    rootIds: null,
  }, owner);
  const broadAdmin = await service.createUser({
    name: 'Broad admin',
    password: broadAdminPassword,
    role: 'admin',
    permissions: ['users.manage', 'account.password', 'logs.read'],
    rootIds: null,
  }, owner);
  const viewer = await service.createUser({
    name: 'Viewer',
    password: viewerPassword,
    role: 'viewer',
    rootIds: null,
  }, owner);

  const managerSession = await service.createSession({ username: manager.name, password: managerPassword, address: '127.0.0.1' });
  const managerPrincipal = await service.authenticateRequest(bearer(managerSession.adminToken));
  const limitedAdminSession = await service.createSession({ username: limitedAdmin.name, password: limitedAdminPassword, address: '127.0.0.1' });
  const limitedAdminPrincipal = await service.authenticateRequest(bearer(limitedAdminSession.adminToken));
  const viewerSession = await service.createSession({ username: viewer.name, password: viewerPassword, address: '127.0.0.1' });

  await assert.rejects(
    () => service.changePassword({ userId: broadAdmin.id, newPassword: 'stolen-admin-password-1' }, managerPrincipal),
    (error) => error.status === 403 && error.code === 'permission_denied',
  );
  await assert.rejects(
    () => service.changePassword({ userId: broadAdmin.id, newPassword: 'stolen-peer-password-1' }, limitedAdminPrincipal),
    (error) => error.status === 403 && error.code === 'permission_denied',
  );
  await assert.rejects(
    () => service.changePassword({ userId: owner.id, newPassword: 'stolen-owner-password-1' }, managerPrincipal),
    (error) => error.status === 403 && error.code === 'permission_denied',
  );

  await assert.rejects(
    () => service.changePassword({ newPassword: 'manager-password-2' }, managerPrincipal),
    (error) => error.status === 400 && /current password is required/i.test(error.message),
  );
  await assert.rejects(
    () => service.changePassword({ currentPassword: 'incorrect-password', newPassword: 'manager-password-2' }, managerPrincipal),
    (error) => error.status === 401 && /current password is incorrect/i.test(error.message),
  );
  const changedSelf = await service.changePassword({
    currentPassword: managerPassword,
    newPassword: 'manager-password-2',
  }, managerPrincipal);
  assert.equal(await service.authenticateRequest(bearer(managerSession.adminToken)), null, 'self-change revokes the old session');
  assert.equal((await service.authenticateRequest(bearer(changedSelf.adminToken))).id, manager.id, 'self-change issues one replacement session');

  assert.deepEqual(await service.changePassword({ userId: viewer.id, newPassword: 'viewer-password-2' }, owner), { changed: true });
  assert.equal(await service.authenticateRequest(bearer(viewerSession.adminToken)), null, 'an owner reset revokes target sessions');
  const viewerAfterReset = await service.createSession({ username: viewer.name, password: 'viewer-password-2', address: '127.0.0.1' });
  assert.equal((await service.authenticateRequest(bearer(viewerAfterReset.adminToken))).id, viewer.id);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, headlessAdminStateFilename), 'utf8'));
  const policyLogs = state.logs.filter((entry) => entry.message === 'Credential-reset policy evaluated.');
  assert.ok(policyLogs.some((entry) => entry.details?.actorId === manager.id
    && entry.details?.targetId === broadAdmin.id
    && entry.details?.policyResult === 'denied'));
  assert.ok(policyLogs.some((entry) => entry.details?.actorId === owner.id
    && entry.details?.targetId === viewer.id
    && entry.details?.policyResult === 'allowed'));
  const serializedLogs = JSON.stringify(state.logs);
  for (const password of [managerPassword, limitedAdminPassword, broadAdminPassword, viewerPassword, 'viewer-password-2']) {
    assert.equal(serializedLogs.includes(password), false, 'security logs must not record credentials');
  }
});

test('authentication expiry cleanup and logout revoke only their bound playback sessions', async (t) => {
  let currentTime = Date.now();
  t.mock.method(Date, 'now', () => currentTime);
  const registry = createPlaybackSessionRegistry({ sweepIntervalMs: 0 });
  let media;
  const revocations = [];
  const { service, dataDir, principal, token } = await onboardedService({
    options: {
      onAuthenticationSessionRevoked: (id, reason) => {
        revocations.push({ id, reason });
        return media.revokeAuthenticationSession(id, reason);
      },
    },
  });
  media = createHeadlessMediaService({
    adminService: service, cacheDir: dataDir, playbackSessionRegistry: registry,
    authorize: async () => true, transcoder: { path: null, getHealth: () => ({}) },
    cacheQuotaOptions: { sweepIntervalMs: 0, minFreeBytes: 0 },
  });
  t.after(async () => { await media.stop(); registry.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const expiresAt = await service.getSessionExpiry(principal.sessionId, principal.id);
  const bound = await media.issuePlaybackToken('item-1', principal.id, 'direct', { authenticationSessionId: principal.sessionId });
  const longLived = registry.create({ principalId: principal.id, itemId: 'item-2', action: 'hls',
    profile: { authenticationSessionId: principal.sessionId }, idleTimeoutMs: expiresAt - currentTime + 60_000,
    absoluteExpiresAt: expiresAt + 60_000 });
  assert.ok(bound.absoluteExpiresAt <= expiresAt);
  currentTime = expiresAt;
  assert.equal(await service.isSessionActive(principal.sessionId, principal.id), false);
  assert.equal(await service.getSessionExpiry(principal.sessionId, principal.id), null);
  assert.equal(await service.authenticateRequest(bearer(token)), null);
  assert.equal(registry.get(longLived.id), null);
  assert.deepEqual(revocations, [{ id: principal.sessionId, reason: 'auth_session_expired' }]);
  const login = await service.createSession({ password: OWNER_PASSWORD, address: '127.0.0.1' });
  const signedIn = await service.authenticateRequest(bearer(login.adminToken));
  const playback = await media.issuePlaybackToken('item-1', principal.id, 'direct', { authenticationSessionId: signedIn.sessionId });
  const independent = await media.issuePlaybackToken('item-2', principal.id, 'direct');
  assert.equal(await service.revokeRequest(bearer(login.adminToken)), true);
  assert.equal(registry.get(playback.sessionId), null);
  assert.ok(registry.get(independent.sessionId));
  assert.deepEqual(revocations.at(-1), { id: signedIn.sessionId, reason: 'auth_session_revoked' });
});

test('rejected user updates leave cached and persisted records unchanged', async (t) => {
  const { service, dataDir, principal } = await onboardedService();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const user = await service.createUser({ name: 'Original', password: OWNER_PASSWORD, role: 'viewer', rootIds: [] }, principal);
  const statePath = path.join(dataDir, headlessAdminStateFilename);
  const before = await fs.readFile(statePath, 'utf8');
  const original = await service.getPrincipalById(user.id);
  const manager = { ...principal, type: 'user', role: 'user', permissions: ['users.manage', 'library.read', 'stream', 'account.password'], rootIds: [] };
  for (const [input, actor, status] of [
    [{ role: 'invalid' }, principal, 400],
    [{ permissions: ['invalid'] }, principal, 400],
    [{ rootIds: ['unknown'] }, principal, 400],
    [{ deviceIds: 'invalid' }, principal, 400],
    [{ maxSessions: -1 }, principal, 400],
    [{ role: 'admin' }, manager, 403],
    [{ permissions: ['logs.read'] }, manager, 403],
    [{ rootIds: null }, manager, 403],
  ]) {
    await assert.rejects(() => service.updateUser(user.id, { name: 'Rejected name', ...input }, actor), { status });
    assert.deepEqual(await service.getPrincipalById(user.id), original);
    assert.equal(await fs.readFile(statePath, 'utf8'), before);
  }
  await service.updateUser(user.id, { name: 'Accepted', role: 'user', permissions: ['stream'], deviceIds: ['device-1'], maxSessions: 2 }, principal);
  const updated = await service.getPrincipalById(user.id);
  assert.equal(updated.name, 'Accepted');
  assert.equal(updated.role, 'user');
  assert.deepEqual(updated.permissions, ['stream']);
  assert.deepEqual(updated.deviceIds, ['device-1']);
  assert.equal(updated.maxSessions, 2);
  const { service: reopened } = await makeService({ dataDir });
  assert.deepEqual(await reopened.getPrincipalById(user.id), updated);
});

test('library roots resolve to absolute paths and unauthenticated principals cannot manage them', async () => {
  const { service, principal } = await onboardedService();
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-media-'));

  const root = await service.addLibraryRoot({ path: mediaDir }, principal);
  assert.equal(path.isAbsolute(root.path), true);

  await assert.rejects(
    () => service.addLibraryRoot({ path: mediaDir }, { type: 'user', role: 'viewer', permissions: ['library.read'], rootIds: null }),
    (error) => error.status === 403,
  );
  await assert.rejects(() => service.addLibraryRoot({ path: '' }, principal), (error) => error.status === 400);
});

test('a catalog entry that escapes its root is refused at playback resolution', async () => {
  const { service, dataDir, principal } = await onboardedService();
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-media-'));
  await fs.writeFile(path.join(mediaDir, 'inside.mkv'), 'fake');
  await service.addLibraryRoot({ path: mediaDir }, principal);
  await service.startLibraryScan({}, principal);
  await waitForScan(service, principal);

  const items = await service.listLibraryItems(principal);
  assert.equal(items.length, 1);

  // Tamper with the persisted catalog the way a corrupt or malicious state
  // file would, then reload the service from disk.
  const statePath = path.join(dataDir, headlessAdminStateFilename);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.catalog[0].path = path.join(mediaDir, '..', 'outside-the-root.mkv');
  await fs.writeFile(statePath, JSON.stringify(state));

  const { service: reloaded } = await makeService({ dataDir });
  const reloadedPrincipal = await reloaded.authenticateRequest(bearer((await reloaded.createSession({ password: OWNER_PASSWORD })).adminToken));
  await assert.rejects(
    () => reloaded.resolveMediaPath(state.catalog[0].id, reloadedPrincipal),
    (error) => error.status === 403,
  );
});

test('backup and restore round-trip recovers state and writes a rollback artifact', async () => {
  const clientSnapshots = [];
  let clientState = { profiles: [{ id: 'p1', ownerId: 'user-a', name: 'Viewer' }], progress: {}, selections: {} };
  const { service, principal } = await onboardedService({
    options: {
      getClientState: async () => clientState,
      replaceClientState: async (snapshot) => { clientSnapshots.push(snapshot); clientState = snapshot; },
    },
  });
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-media-'));
  await service.addLibraryRoot({ path: mediaDir }, principal);

  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-backup-'));
  const backup = await service.startBackup({ destination: backupDir }, principal);
  assert.equal(backup.state, 'completed');
  assert.match(backup.checksum, /^[a-f0-9]{64}$/i);
  await fs.access(backup.destination);

  // Mutate live state after the backup, then restore.
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-media-'));
  await service.addLibraryRoot({ path: secondRoot }, principal);
  assert.equal((await service.listLibraryRoots(principal)).length, 2);

  const result = await service.restoreBackup({ path: backup.destination }, principal);
  assert.equal(result.restored, true);
  await fs.access(result.rollbackDestination);
  assert.equal(clientSnapshots.length, 1, 'restore must also replace the hosted client state');

  // Restored state drops sessions, so a fresh sign-in must be required and
  // the pre-backup root list must be back.
  const fresh = await service.createSession({ password: OWNER_PASSWORD });
  const freshPrincipal = await service.authenticateRequest(bearer(fresh.adminToken));
  assert.equal((await service.listLibraryRoots(freshPrincipal)).length, 1);
});

test('a tampered backup is rejected by its checksum', async () => {
  const { service, principal } = await onboardedService();
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-backup-'));
  const backup = await service.startBackup({ destination: backupDir }, principal);

  const envelope = JSON.parse(await fs.readFile(backup.destination, 'utf8'));
  envelope.data.roots = [{ id: 'injected', path: '/etc', kind: 'others', createdAt: Date.now() }];
  await fs.writeFile(backup.destination, JSON.stringify(envelope));

  await assert.rejects(
    () => service.restoreBackup({ path: backup.destination }, principal),
    (error) => /checksum/i.test(error.message) || error.status === 400,
  );
});

test('restore refuses the live state file and non-backup permissions', async () => {
  const { service, dataDir, principal } = await onboardedService();
  await assert.rejects(
    () => service.restoreBackup({ path: path.join(dataDir, headlessAdminStateFilename) }, principal),
    (error) => /live admin state/i.test(error.message),
  );
  await assert.rejects(
    () => service.restoreBackup({ path: '/nonexistent.json' }, { type: 'user', role: 'viewer', permissions: ['library.read'], rootIds: null }),
    (error) => error.status === 403,
  );
});

test('a concurrent sign-in burst runs no more password checks than the lock budget', async () => {
  let checks = 0;
  const releases = [];
  const kdfLimiter = { run: (work) => { checks += 1; return new Promise((resolve, reject) => { releases.push(() => work().then(resolve, reject)); }); } };
  const { service } = await onboardedService({ options: { kdfLimiter } });
  const attempts = Array.from({ length: 12 }, (_, index) => service.createSession({ password: `wrong-password-${index}`, address: '127.0.0.1' }).catch((error) => error));
  // Let every attempt reach its password check or its admission refusal.
  for (let round = 0; round < 50 && checks < 5; round += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  assert.equal(checks, 5, 'at most five password checks may run for one identity');
  while (releases.length) releases.shift()();
  const results = await Promise.all(attempts);
  assert.equal(results.filter((error) => error.code === 'login_in_progress').length, 7);
  assert.equal(results.filter((error) => error.code === 'invalid_credentials' || error.code === 'login_locked').length, 5);
  await assert.rejects(service.createSession({ password: OWNER_PASSWORD, address: '127.0.0.1' }), { status: 429, code: 'login_locked' });
});


test('successful sign-in preserves a failure completed during its check', async (context) => {
  const held = [];
  const kdfLimiter = { run: (work) => new Promise((resolve, reject) => { held.push(() => work().then(resolve, reject)); }) };
  const { service, dataDir } = await onboardedService({ options: { kdfLimiter, loginDelay: async () => {} } });
  context.after(async () => { await service.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const correct = service.createSession({ password: OWNER_PASSWORD, address: '127.0.0.1' });
  await new Promise((resolve) => { setImmediate(resolve); });
  const wrong = service.createSession({ password: 'incorrect-password', address: '127.0.0.1' }).catch((error) => error);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(held.length, 2);
  held.pop()();
  assert.equal((await wrong).code, 'invalid_credentials');
  held.shift()();
  await correct;
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, headlessAdminStateFilename), 'utf8'));
  assert.deepEqual(persisted.loginAttempts.map((entry) => entry.failures), [1, 1], 'identity and address failures both survive');
});

test('password reset invalidates a sign-in whose verification already succeeded', async (context) => {
  let reportVerified;
  let resume;
  const verified = new Promise((resolve) => { reportVerified = resolve; });
  const release = new Promise((resolve) => { resume = resolve; });
  const kdfLimiter = { run: async (work) => {
    const result = await work();
    reportVerified();
    await release;
    return result;
  } };
  const { service, dataDir, principal } = await onboardedService({ options: { kdfLimiter, loginDelay: async () => {} } });
  context.after(async () => { await service.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const attempt = service.createSession({ password: OWNER_PASSWORD, address: '127.0.0.1' }).catch((error) => error);
  await verified;
  await service.changePassword({ currentPassword: OWNER_PASSWORD, newPassword: 'replacement-owner-password' }, principal);
  resume();
  assert.equal((await attempt).code, 'credentials_changed');
});

test('delegated managers cannot demote, disable, remove, or reset broader accounts', async (t) => {
  const { service, dataDir, principal: owner } = await onboardedService();
  t.after(async () => { await service.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const manager = await service.createUser({ name: 'Delegate', password: 'delegate-password', role: 'user',
    permissions: ['users.manage', 'account.password'], rootIds: null }, owner);
  const actor = await service.getPrincipalById(manager.id);
  for (const grants of [
    { role: 'admin', permissions: ['account.password'] },
    { role: 'user', permissions: ['account.password', 'stream'] },
  ]) {
    const target = await service.createUser({ name: `Target ${grants.role}`, password: 'target-password', rootIds: null, ...grants }, owner);
    await assert.rejects(service.updateUser(target.id, { role: 'user', permissions: ['account.password'] }, actor), { status: 403 });
    await assert.rejects(service.updateUser(target.id, { disabled: true, permissions: ['account.password'] }, actor), { status: 403 });
    await assert.rejects(service.removeUser(target.id, actor), { status: 403 });
    await assert.rejects(service.changePassword({ userId: target.id, newPassword: 'replacement-password' }, actor), { status: 403 });
    assert.deepEqual((await service.getPrincipalById(target.id)).permissions, grants.permissions);
    await service.updateUser(target.id, { name: `${target.name} renamed` }, owner);
  }
});

test('device capabilities retain live grants for remote reads and renewal', async (t) => {
  let permissions = ['library.read', 'stream'];
  const device = { id: 'credential-1', deviceId: 'device-1', accountId: null };
  const pairingService = {
    authenticate: async (header) => header === 'LoomDevice test' ? { ...device, permissions } : null,
    resolveSessionDevice: async (accountId, deviceId) => accountId === device.accountId && deviceId === device.deviceId ? { ...device, permissions } : null,
  };
  const { service, dataDir, principal: owner } = await onboardedService({ options: { pairingService } });
  t.after(async () => { await service.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const user = await service.createUser({ name: 'Device user', password: 'device-user-password', role: 'user', permissions: ['library.read', 'stream', 'remote.access'] }, owner);
  device.accountId = user.id;
  const principal = await service.authenticateRequest({ headers: { authorization: 'LoomDevice test' }, socket: { remoteAddress: '127.0.0.1' } });
  assert.deepEqual(principal.devicePermissions, permissions);
  const mediaPath = path.join(dataDir, 'video.mp4');
  await fs.writeFile(mediaPath, 'video');
  const fileId = await fs.stat(mediaPath);
  const media = createHeadlessMediaService({
    cacheDir: dataDir, cacheQuotaOptions: { minFreeBytes: 0, sweepIntervalMs: 0 }, transcoder: { path: null, getHealth: () => ({}) }, authorize: async () => true,
    adminService: { ...service, resolveMediaPath: async () => ({ id: 'media-1', sourceId: 'source-1', rootPath: dataDir, path: mediaPath, fileId }) },
    remotePolicy: { assertPrincipal: (req, actor) => {
      if (req?.remote && !hasPermission(actor, 'remote.access')) throw new Error('remote denied');
    } },
  });
  t.after(() => media.stop());
  const lease = await media.issuePlaybackToken('media-1', user.id, 'direct', { authenticationDeviceId: device.deviceId, deviceId: device.deviceId, remoteAccess: false });
  async function read(remote) {
    const res = { writeHead(status) { this.status = status; }, end() {} };
    await media.handle({ method: 'HEAD', headers: {}, remote }, res, new URL(`http://localhost/api/media/items/media-1?token=${lease.token}`));
    return res.status;
  }
  assert.equal(await read(false), 200);
  assert.equal(await read(true), 401);
  assert.equal(await media.renewPlaybackSession(lease.token, null, 'media-1', undefined, { remote: true }), null);
  permissions = ['library.read'];
  assert.equal(await read(false), 401);
  assert.equal(await media.renewPlaybackSession(lease.sessionId, await service.getPrincipalById(user.id), 'media-1'), null);
});

test('account device allow-lists deny existing credentials, sessions, and playback bindings', async (t) => {
  const device = { id: 'credential-1', deviceId: 'device-1', accountId: null, permissions: ['stream'] };
  const revocations = [];
  const { service, dataDir, principal: owner } = await onboardedService({ options: {
    pairingService: { authenticate: async (header) => header === 'LoomDevice test' ? device : null, resolveSessionDevice: async () => device },
    onPlaybackSessionsRevoked: async (id, reason) => revocations.push([id, reason]),
  } });
  t.after(async () => { await service.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const user = await service.createUser({ name: 'Allowed device', password: 'allowed-device-password', role: 'user', deviceIds: ['device-1'] }, owner);
  device.accountId = user.id;
  const req = { headers: { authorization: 'LoomDevice test' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.ok(await service.authenticateRequest(req));
  const session = await service.issueDeviceSession(device);
  const principal = await service.authenticateRequest(bearer(session.adminToken));
  const binding = { authenticationSessionId: principal.sessionId, authenticationDeviceId: device.deviceId };
  assert.ok(await service.resolvePlaybackPrincipal(user.id, binding));
  await service.updateUser(user.id, { deviceIds: ['device-2'] }, owner);
  assert.equal(await service.authenticateRequest(req), null);
  assert.equal(await service.authenticateRequest(bearer(session.adminToken)), null);
  assert.equal(await service.resolvePlaybackPrincipal(user.id, binding), null);
  assert.equal(await service.resolvePlaybackPrincipal(user.id, { authenticationDeviceId: device.deviceId }), null);
  assert.deepEqual(revocations.at(-1), [user.id, 'permissions_changed']);
});

async function canonicalService(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-audit-server-'));
  const store = createCanonicalStateStore({ dataDir });
  await store.start();
  const { service, principal } = await onboardedService({ dataDir, options: { stateStore: store, ...options } });
  t.after(async () => { await service.stop(); await store.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, service, principal };
}

test('sole profile managers cannot be removed or disabled and unrelated profile writes remain usable', async (t) => {
  const { store, service, principal } = await canonicalService(t);
  const user = await service.createUser({ name: 'Sole manager', password: 'sole-manager-password' }, principal);
  const client = createHeadlessClientState({ store });
  const mine = await client.createProfile({ name: 'Owner profile' }, principal.id);
  const theirs = await client.createProfile({ name: 'User profile' }, user.id);
  const before = store.readAdminState();
  for (const mutation of [() => service.removeUser(user.id, principal), () => service.updateUser(user.id, { disabled: true }, principal)]) {
    await assert.rejects(mutation(), { code: 'profile_manager_required', status: 409 });
    assert.ok(await service.getPrincipalById(user.id));
    assert.deepEqual(store.readAdminState().users, before.users);
    await client.updateProfile(mine.id, { name: 'Still editable' }, principal.id);
    await client.saveProfilePreferences(mine.id, { themeMode: 'light' }, principal.id);
    await client.selectProfile(mine.id, principal.id);
  }
  store.mutateClientState((state) => state.assignments.push({ profileId: theirs.id, accountId: principal.id, access: 'manage', createdAt: Date.now() }));
  await service.removeUser(user.id, principal);
  await store.stop(); await store.start();
  await client.updateProfile(mine.id, { name: 'After restart' }, principal.id);
  assert.equal(store.readAdminState().users.length, 0);
});

test('account removal retires approved unconsumed pairing requests and publishes state only after persistence', async (t) => {
  const { store, service, principal } = await canonicalService(t);
  const user = await service.createUser({ name: 'Pairing user', password: 'pairing-user-password' }, principal);
  const now = Date.now();
  store.createPairingRequest({ id: 'pending-1', requestSecretHash: 'request-hash', credentialId: 'credential-1', credentialSecretHash: 'credential-hash', credentialCiphertext: null, credentialIv: null, credentialTag: null,
    deviceId: 'device-1', name: 'TV', kind: 'tv', permissions: ['stream'], createdAt: now, expiresAt: now + 60_000 });
  store.approvePairingRequest({ requestId: 'pending-1', accountId: user.id, permissions: ['stream'], approvedAt: now, credentialExpiresAt: now + 60_000 });
  assert.equal(store.readPairingRequest('pending-1').state, 'approved');
  await service.removeUser(user.id, principal);
  assert.equal(await service.getPrincipalById(user.id), null);
  assert.equal(store.readPairingRequest('pending-1'), null);
  assert.equal(store.readDeviceCredential('credential-1'), null);
  await store.stop(); await store.start();
  assert.equal(store.readAdminState().users.length, 0);
  assert.equal(store.readPairingRequest('pending-1'), null);
});

test('failed account removal leaves cached credentials and sessions intact', async (t) => {
  let rejectWrite = false;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-removal-rollback-'));
  const store = createCanonicalStateStore({ dataDir });
  await store.start();
  const { service, principal } = await onboardedService({ dataDir, options: { stateStore: { ...store, replaceAdminState(state) {
    if (rejectWrite) throw new Error('forced persistence failure');
    return store.replaceAdminState(state);
  } } } });
  t.after(async () => { await service.stop(); await store.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const user = await service.createUser({ name: 'Rollback user', password: 'rollback-user-password' }, principal);
  const session = await service.createSession({ username: user.name, password: 'rollback-user-password', address: '127.0.0.1' });
  rejectWrite = true;
  await assert.rejects(service.removeUser(user.id, principal), /forced persistence failure/);
  assert.ok(await service.getPrincipalById(user.id));
  assert.ok(await service.authenticateRequest(bearer(session.adminToken)));
  assert.equal(store.readAdminState().users[0].id, user.id);
  rejectWrite = false;
  await store.stop(); await store.start();
  assert.equal(store.readAdminState().users[0].id, user.id);
});

test('concurrent creates and create-rename collisions commit only one normalized login identity', async (t) => {
  const { store, service, principal } = await canonicalService(t);
  const creates = await Promise.allSettled(['Same', ' same '].map((name) => service.createUser({ name, password: 'same-user-password' }, principal)));
  assert.equal(creates.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(creates.find((result) => result.status === 'rejected').reason.status, 409);
  const target = await service.createUser({ name: 'Rename target', password: 'rename-user-password' }, principal);
  const collision = await Promise.allSettled([
    service.createUser({ name: 'Collision', password: 'collision-user-password' }, principal),
    service.updateUser(target.id, { name: ' COLLISION ' }, principal),
  ]);
  assert.equal(collision.filter((result) => result.status === 'fulfilled').length, 1);
  const users = store.readAdminState().users;
  const duplicateSnapshot = store.exportCanonicalSnapshot();
  const accounts = duplicateSnapshot.tables.accounts.filter((account) => account.account_type === 'user');
  accounts[1].name = accounts[0].name.toUpperCase();
  await assert.rejects(store.restoreCanonicalSnapshot(duplicateSnapshot), { code: 'canonical_backup_invalid' });
  assert.equal(new Set(users.map((user) => user.name.trim().toLocaleLowerCase())).size, users.length);
  const state = store.readAdminState();
  assert.throws(() => store.replaceAdminState({ ...state, users: [...state.users, { ...state.users[0], id: 'duplicate-id', name: state.users[0].name.toUpperCase() }] }), { code: 'account_name_conflict' });
  await store.stop(); await store.start();
  assert.equal(store.readAdminState().users.length, users.length);
});

test('changed canonical sources clear failed probes and retry analysis after restart', async (t) => {
  let calls = 0;
  let fail = false;
  const { store, service, dataDir, principal } = await canonicalService(t, { probeMedia: async (_path, { sourceId }) => {
    calls += 1;
    if (fail) throw new Error('forced probe failure');
    return { sourceId, container: 'mp4', tracks: [{ id: 'video', index: 0, kind: 'video', codec: calls === 1 ? 'h264' : 'hevc' }], chapters: [], hdr: false, probedAt: Date.now(), adapterGaps: [] };
  } });
  const rootPath = path.join(dataDir, 'media'); await fs.mkdir(rootPath);
  const file = path.join(rootPath, 'movie.mp4'); await fs.writeFile(file, 'first');
  await service.addLibraryRoot({ path: rootPath }, principal);
  await service.startLibraryScan({ mode: 'quick' }, principal); await waitForScan(service, principal);
  assert.equal(calls, 1);
  await service.startLibraryScan({ mode: 'quick' }, principal); await waitForScan(service, principal);
  assert.equal(calls, 1, 'unchanged sources retain their probe');
  await fs.writeFile(file, 'replacement with different statistics'); fail = true;
  await service.startLibraryScan({ mode: 'quick' }, principal); await waitForScan(service, principal);
  assert.equal(calls, 2);
  assert.equal(store.readAdminState().catalog[0].localMetadata, undefined);
  await store.stop(); await store.start();
  assert.equal(store.readAdminState().catalog[0].localMetadata, undefined);
  fail = false;
  await service.startLibraryScan({ mode: 'quick' }, principal); await waitForScan(service, principal);
  assert.equal(calls, 3);
  assert.equal(store.readAdminState().catalog[0].localMetadata.tracks[0].codec, 'hevc');
});

test('completed full and quick scans persist missing sources while retaining offline roots and secondary sources', async (t) => {
  for (const mode of ['full', 'quick']) await t.test(mode, async (t) => {
    const { store, service, dataDir, principal } = await canonicalService(t);
    const rootPath = path.join(dataDir, 'readable'); const offlinePath = path.join(dataDir, 'offline');
    await fs.mkdir(rootPath); await fs.mkdir(offlinePath);
    const removed = path.join(rootPath, 'removed.mp4'); await fs.writeFile(removed, 'removed');
    await fs.writeFile(path.join(offlinePath, 'keep.mp4'), 'keep');
    const root = await service.addLibraryRoot({ path: rootPath }, principal);
    const offline = await service.addLibraryRoot({ path: offlinePath }, principal);
    await service.startLibraryScan({ mode }, principal); await waitForScan(service, principal);
    const initial = store.readAdminState();
    const missing = initial.catalog.find((item) => item.rootId === root.id);
    const retained = initial.catalog.find((item) => item.rootId === offline.id);
    store.replaceAllState({ adminState: initial, mediaSources: [{ id: 'secondary', mediaId: missing.id, rootId: offline.id, relativePath: 'secondary.mp4',
      locator: path.join(offlinePath, 'secondary.mp4'), state: 'offline', fileExtension: '.mp4', indexedAt: 1 }] });
    await fs.unlink(removed); await fs.rename(offlinePath, `${offlinePath}-disconnected`);
    await service.startLibraryScan({ mode }, principal); assert.equal((await waitForScan(service, principal)).state, 'completed');
    await store.stop(); await store.start();
    assert.equal(store.readMediaSource(missing.id, missing.sourceId).state, 'missing');
    assert.equal(store.readMediaSource(missing.id, 'secondary').state, 'offline');
    assert.equal(store.readMediaSource(retained.id, retained.sourceId).state, 'offline');
    assert.equal(store.readAdminState().catalog.find((item) => item.id === missing.id).available, false);
  });
});

test('a native owner session authenticates as the owner, expires, and needs a configured owner', async () => {
  const { service: fresh } = await makeService();
  await assert.rejects(() => fresh.createNativeOwnerSession(), { code: 'owner_required' });

  const { service } = await onboardedService();
  const session = await service.createNativeOwnerSession();
  assert.ok(session.adminToken);
  assert.ok(Number.isFinite(session.expiresAt) && session.expiresAt > Date.now());
  const principal = await service.authenticateRequest(bearer(session.adminToken));
  assert.equal(principal?.role, 'owner');
});

test('a standalone server never issues native owner sessions', async () => {
  const { createCanonicalVideoServer } = await import('../src/server.js');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-native-owner-'));
  const server = createCanonicalVideoServer({
    host: '127.0.0.1', port: 0, version: 'test',
    paths: { dataDir, cacheDir: dataDir, mediaDir: dataDir },
  });
  await assert.rejects(() => server.createDesktopOwnerSession(), { code: 'native_owner_access_unavailable' });
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('no HTTP route exposes native owner session creation', async () => {
  const sources = await Promise.all(['public-api.js', 'admin-api.js', 'server.js', 'web-app.js'].map(async (name) => (
    fs.readFile(new URL(`../src/${name}`, import.meta.url), 'utf8').catch(() => '')
  )));
  const callers = sources.map((source, index) => [index, (source.match(/createNativeOwnerSession|createDesktopOwnerSession/g) || []).length]);
  // server.js defines the in-process method; nothing else may call it.
  assert.deepEqual(callers.filter(([, count]) => count > 0).map(([index]) => index), [2]);
});
