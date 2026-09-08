import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createHeadlessMediaService } from '../src/media-service.js';
import { createPlaybackSessionRegistry } from '../src/playback-session-registry.js';

function response() {
  return Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead(status) { this.statusCode = status; this.headersSent = true; return this; },
    end(body) { this.body = body; return this; },
  });
}

async function fixture(t) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-media-types-'));
  const registry = createPlaybackSessionRegistry({ sweepIntervalMs: 0 });
  const principal = { id: 'owner-1', type: 'owner' };
  let authentications = 0;
  const service = createHeadlessMediaService({
    cacheDir,
    playbackSessionRegistry: registry,
    cacheQuotaOptions: { sweepIntervalMs: 0, minFreeBytes: 0 },
    authorize: async () => true,
    transcoder: { path: null, getHealth: () => ({}) },
    adminService: {
      authenticateRequest: async () => { authentications += 1; return principal; },
      getPrincipalById: async () => principal,
      authorizePrincipal: async () => true,
      resolveMediaPath: async () => ({
        id: 'media-1', sourceId: 'source-1', rootPath: cacheDir,
        path: path.join(cacheDir, 'video.mp4'), fileId: { dev: 1, ino: 2 },
      }),
    },
  });
  t.after(async () => { await service.stop(); registry.close(); await fs.rm(cacheDir, { recursive: true, force: true }); });
  return { service, registry, authentications: () => authentications };
}

test('media authentication rejects an array-valued admin token header', async (t) => {
  const { service, authentications } = await fixture(t);
  const res = response();
  await service.handle({ method: 'GET', headers: { 'x-loom-admin-token': ['first', 'second'] } }, res,
    new URL('http://localhost/api/media/items/media-1'));
  assert.equal(res.statusCode, 401);
  assert.equal(authentications(), 0);
});

test('direct media rejects malformed file identity bindings before opening the source', async (t) => {
  const { service, registry } = await fixture(t);
  const lease = registry.create({
    principalId: 'owner-1', itemId: 'media-1', action: 'direct',
    profile: { sourceId: 'source-1', fileId: { dev: '1', ino: 2 } },
  });
  const res = response();
  await service.handle({ method: 'GET', headers: {} }, res,
    new URL(`http://localhost/api/media/items/media-1?token=${lease.token}`));
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error, 'source_unavailable');
});
