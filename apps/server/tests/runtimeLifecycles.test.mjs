import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createHeadlessServer } from '../src/server.js';
import { createPlaybackSessionRegistry } from '../src/playback-session-registry.js';
import { createHeadlessMediaService, terminateChild } from '../src/media-service.js';
import { createTranscodeAdmission } from '../src/transcode-admission.js';
import { createTranscodeCacheQuota } from '../src/transcode-cache-quota.js';

test('playback renewal preserves the absolute cap and overlaps rotated tokens without alias replay', () => {
  let currentTime = 0;
  const registry = createPlaybackSessionRegistry({
    now: () => currentTime,
    sweepIntervalMs: 0,
    idleTimeoutMs: 100,
    absoluteTimeoutMs: 200,
    tokenOverlapMs: 25,
  });
  const created = registry.create({ principalId: 'user-1', itemId: 'item-1', action: 'hls' });
  currentTime = 90;
  const renewed = registry.renew(created.id, { principalId: 'user-1', itemId: 'item-1', action: 'hls' });
  assert.ok(renewed);
  assert.notEqual(renewed.token, created.token);
  assert.equal(registry.authorize(created.token, { action: 'hls' })?.id, created.id);
  assert.equal(renewed.absoluteExpiresAt, created.absoluteExpiresAt);
  assert.equal(registry.renew(created.token, { principalId: 'user-1', itemId: 'item-1', action: 'hls' }), null);
  currentTime = 116;
  assert.equal(registry.authorize(created.token, { action: 'hls' }), null);
  registry.close();
});

test('transcode admission bounds concurrent work and releases queued permits', async () => {
  const admission = createTranscodeAdmission({ globalLimit: 2, principalLimit: 1, queueLimit: 2, principalQueueLimit: 1 });
  const first = await admission.acquire('user-1');
  const second = await admission.acquire('user-2');
  const queued = admission.acquire('user-1');
  assert.deepEqual(admission.stats(), {
    active: 2,
    queued: 1,
    globalLimit: 2,
    principalLimit: 1,
    queueLimit: 2,
    principalQueueLimit: 1,
    principals: { 'user-1': 1, 'user-2': 1 },
    failed: 0,
    canceled: 0,
    closed: false,
  });
  first.release();
  const promoted = await queued;
  assert.equal(admission.stats().active, 2);
  promoted.release();
  second.release();
  admission.close();
});

test('cache quota accounts for orphan bytes, reservations, per-session output, and free-space diagnostics', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-quota-'));
  try {
    await fs.mkdir(path.join(root, 'orphan'), { recursive: true });
    await fs.writeFile(path.join(root, 'orphan', 'segment.ts'), Buffer.alloc(8));
    const quota = createTranscodeCacheQuota({ rootPath: root, maxTotalBytes: 32, maxSessionBytes: 16, minFreeBytes: 0 });
    const before = await quota.status();
    assert.equal(before.totalBytes, 8);
    await quota.reserve('session-1', 'user-1', 16);
    await assert.rejects(() => quota.reserve('session-2', 'user-2', 16), { code: 'transcode_cache_quota' });
    quota.release('session-1');
    assert.equal(quota.snapshot().reservedBytes, 0);
    const lowFreeQuota = createTranscodeCacheQuota({
      rootPath: root,
      maxTotalBytes: 32,
      maxSessionBytes: 16,
      minFreeBytes: 10,
      fileSystem: {
        readdir: (...args) => fs.readdir(...args),
        stat: (...args) => fs.stat(...args),
        statfs: async () => ({ bsize: 1, bavail: 4 }),
      },
    });
    await assert.rejects(() => lowFreeQuota.checkAdmission(), { code: 'transcode_cache_free_space' });
    assert.equal(lowFreeQuota.snapshot().freeBytes, 4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent cache reservations include outstanding free-space commitments', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-quota-concurrent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let scans = 0;
  const quota = createTranscodeCacheQuota({
    rootPath: root, maxTotalBytes: 100, maxSessionBytes: 10, minFreeBytes: 5,
    fileSystem: {
      readdir: (...args) => fs.readdir(...args),
      stat: (...args) => fs.stat(...args),
      statfs: async () => { scans += 1; return { bsize: 1, bavail: 25 }; },
    },
  });
  const results = await Promise.allSettled([
    quota.reserve('first', 'user-1'),
    quota.reserve('second', 'user-2'),
    quota.reserve('third', 'user-3'),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(results[2].reason.code, 'transcode_cache_free_space');
  assert.equal(scans, 1);
  assert.equal(quota.snapshot().reservedBytes, 20);
  assert.deepEqual(quota.snapshot().violations, []);
});

test('cache commitments replace reserved bytes as output materializes and allow exact limits', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-quota-written-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let freeBytes = 25;
  const quota = createTranscodeCacheQuota({
    rootPath: root, maxTotalBytes: 20, maxSessionBytes: 10, minFreeBytes: 5,
    fileSystem: {
      readdir: (...args) => fs.readdir(...args),
      stat: (...args) => fs.stat(...args),
      statfs: async () => ({ bsize: 1, bavail: freeBytes }),
    },
  });
  await quota.reserve('first', 'user-1');
  await fs.mkdir(path.join(root, 'first'));
  await fs.writeFile(path.join(root, 'first', 'segment.ts'), Buffer.alloc(6));
  freeBytes -= 6;
  await quota.reserve('second', 'user-2');
  assert.equal(quota.snapshot().totalBytes, 6);
  assert.equal(quota.snapshot().reservedBytes, 14);
  assert.deepEqual((await quota.checkAdmission()).violations, []);
  await assert.rejects(quota.reserve('third', 'user-3', 1), { code: 'transcode_cache_quota' });
  await fs.writeFile(path.join(root, 'first', 'segment.ts'), Buffer.alloc(10));
  freeBytes -= 4;
  assert.equal((await quota.status()).reservedBytes, 10);
  assert.deepEqual(quota.snapshot().violations, []);
  await fs.writeFile(path.join(root, 'first', 'segment.ts'), Buffer.alloc(11));
  freeBytes -= 1;
  assert.deepEqual((await quota.status()).violations, ['total_bytes', 'free_space', 'session_bytes']);
  quota.release('second');
  assert.equal(quota.snapshot().reservedBytes, 0);
});

test('concurrent reservations for the same session are idempotent', async () => {
  const quota = createTranscodeCacheQuota({
    maxTotalBytes: 10, maxSessionBytes: 10, minFreeBytes: 0,
    fileSystem: { readdir: async () => [], stat: async () => { throw new Error('unexpected stat'); } },
  });
  const [first, second] = await Promise.all([quota.reserve('session', 'user'), quota.reserve('session', 'user')]);
  assert.equal(first, second);
  assert.equal(quota.snapshot().reservedBytes, 10);
});

async function transcodeFixture(t, options = {}) {
  const cacheDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-quota-service-')));
  const root = path.join(cacheDir, 'headless-transcodes');
  await fs.mkdir(root);
  const sourcePath = path.join(cacheDir, 'video.mkv');
  await fs.writeFile(sourcePath, 'video');
  const stats = await fs.stat(sourcePath);
  const principal = { id: 'owner', type: 'owner' };
  const registry = createPlaybackSessionRegistry({ sweepIntervalMs: 0 });
  let sweep;
  const service = createHeadlessMediaService({
    cacheDir,
    playbackSessionRegistry: registry,
    cacheQuotaOptions: { maxTotalBytes: 200, maxSessionBytes: 100, minFreeBytes: 0, sweepIntervalMs: 100 },
    transcodeAdmissionOptions: { globalLimit: 4, principalLimit: 4 },
    clock: { setInterval: (callback) => { sweep = callback; return { unref() {} }; }, clearInterval() {} },
    authorize: async () => true,
    adminService: {
      authenticateRequest: async () => principal,
      getPrincipalById: async () => principal,
      authorizePrincipal: async () => true,
      resolveMediaPath: async () => ({ id: 'item', sourceId: 'source', rootPath: cacheDir,
        path: sourcePath, fileId: { dev: stats.dev, ino: stats.ino } }),
    },
    transcoder: { path: 'ffmpeg', getHealth: () => ({ softwareCodecs: { h264: true } }) },
    spawnProcess: (_command, args) => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
      void fs.writeFile(args.at(-1), '#EXTM3U\n');
      return child;
    },
    ...options,
  });
  t.after(async () => { await service.stop(); registry.close(); await fs.rm(cacheDir, { recursive: true, force: true }); });
  async function start() {
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await service.handle({ method: 'POST', headers: { authorization: 'Bearer owner' } }, res,
      new URL('http://localhost/api/media/transcode?itemId=item&backend=software'));
    assert.equal(res.status, 202, JSON.stringify(res.body));
    return res.body.data;
  }
  await waitUntil(() => service.getCacheQuotaHealth().state !== 'unknown');
  return { root, service, start, sweep: () => sweep() };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition.');
}

test('orphan reconciliation preserves a transcode published during directory enumeration', async (t) => {
  let acquireEntered;
  const entered = new Promise((resolve) => { acquireEntered = resolve; });
  let releaseAcquire;
  const acquireGate = new Promise((resolve) => { releaseAcquire = resolve; });
  const admission = createTranscodeAdmission({ globalLimit: 4, principalLimit: 4 });
  const fixture = await transcodeFixture(t, {
    transcodeAdmission: { ...admission, acquire: async (...args) => {
      acquireEntered();
      await acquireGate;
      return admission.acquire(...args);
    } },
  });
  const starting = fixture.start();
  await entered;
  const originalReaddir = fs.readdir.bind(fs);
  let enumerationEntered;
  const enumerating = new Promise((resolve) => { enumerationEntered = resolve; });
  let releaseEnumeration;
  const enumerationGate = new Promise((resolve) => { releaseEnumeration = resolve; });
  let intercepted = false;
  t.mock.method(fs, 'readdir', async (...args) => {
    if (!intercepted && args[0] === fixture.root) {
      intercepted = true;
      enumerationEntered();
      await enumerationGate;
    }
    return originalReaddir(...args);
  });
  fixture.sweep();
  await enumerating;
  releaseAcquire();
  const session = await starting;
  releaseEnumeration();
  await waitUntil(() => fixture.service.getCacheQuotaHealth().totalBytes > 0);
  assert.equal(await fs.readFile(path.join(fixture.root, session.sessionId, 'index.m3u8'), 'utf8'), '#EXTM3U\n');
  assert.equal((await fixture.service.listSessions()).length, 1);
});

test('quota sweep accepts exact commitment and reclaims only enough sessions', async (t) => {
  const fixture = await transcodeFixture(t);
  const first = await fixture.start();
  const second = await fixture.start();
  fixture.sweep();
  await waitUntil(() => fixture.service.getCacheQuotaHealth().totalBytes === 16);
  assert.equal((await fixture.service.listSessions()).length, 2);
  assert.equal(fixture.service.getCacheQuotaHealth().reservedBytes, 184);
  await fs.writeFile(path.join(fixture.root, first.sessionId, 'segment.ts'), Buffer.alloc(101));
  fixture.sweep();
  await waitUntil(async () => (await fixture.service.listSessions()).length === 1);
  await waitUntil(() => fixture.service.getCacheQuotaHealth().totalBytes === 8);
  assert.equal((await fixture.service.listSessions())[0].id, second.sessionId);
  assert.deepEqual(fixture.service.getCacheQuotaHealth().violations, []);
});

test('hanging playback stream cleanup escalates a child from TERM to KILL', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => child.signals.push(signal);
  await terminateChild(child, 1);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('server stop is bounded and idempotent with an incomplete HTTP request', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-shutdown-data-'));
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-shutdown-cache-'));
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-shutdown-media-'));
  const server = createHeadlessServer({
    host: '127.0.0.1',
    port: 0,
    version: 'test',
    shutdownTimeoutMs: 250,
    termGraceMs: 1,
    paths: { dataDir, cacheDir, mediaDir },
  });
  await server.start();
  const socket = await new Promise((resolve, reject) => {
    const connection = net.connect(server.address().port, '127.0.0.1');
    connection.once('connect', () => resolve(connection));
    connection.once('error', reject);
  }).catch(() => null);
  socket?.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
  await Promise.race([server.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown deadline exceeded')), 1_000))]);
  await server.stop();
  socket?.destroy();
  await Promise.all([
    fs.rm(dataDir, { recursive: true, force: true }),
    fs.rm(cacheDir, { recursive: true, force: true }),
    fs.rm(mediaDir, { recursive: true, force: true }),
  ]);
});
