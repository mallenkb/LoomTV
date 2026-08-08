import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createHeadlessServer } from '../src/server.js';
import { createPlaybackSessionRegistry } from '../src/playback-session-registry.js';
import { terminateChild } from '../src/media-service.js';
import { createTranscodeAdmission } from '../src/transcode-admission.js';
import { createTranscodeCacheQuota } from '../src/transcode-cache-quota.js';

test('playback renewal uses a fake clock, renews the safety window, and overlaps rotated tokens', () => {
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
  assert.ok(renewed.absoluteExpiresAt > created.absoluteExpiresAt);
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
    shutdownTimeoutMs: 50,
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
  await Promise.race([server.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown deadline exceeded')), 500))]);
  await server.stop();
  socket?.destroy();
  await Promise.all([
    fs.rm(dataDir, { recursive: true, force: true }),
    fs.rm(cacheDir, { recursive: true, force: true }),
    fs.rm(mediaDir, { recursive: true, force: true }),
  ]);
});
