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

async function fixture(t, adminOverrides = {}, serviceOverrides = {}) {
  const cacheDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-media-types-')));
  await fs.writeFile(path.join(cacheDir, 'video.mp4'), 'test media');
  const fileId = await fs.stat(path.join(cacheDir, 'video.mp4'));
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
        path: path.join(cacheDir, 'video.mp4'), fileId,
      }),
      ...adminOverrides,
    },
    ...serviceOverrides,
  });
  t.after(async () => { await service.stop(); registry.close(); await fs.rm(cacheDir, { recursive: true, force: true }); });
  return { service, registry, authentications: () => authentications };
}

test('listed playback session IDs cannot authorize direct reads but capability tokens can', async (t) => {
  const { service } = await fixture(t);
  const lease = await service.issuePlaybackToken('media-1', 'owner-1', 'direct');
  const [listed] = await service.listSessions();
  assert.equal(listed.id, lease.sessionId);
  for (const [token, expected] of [[listed.id, 401], [lease.token, 200]]) {
    const res = response();
    res.__loomtvPublicApi = true;
    await service.handle({ method: 'HEAD', headers: {} }, res,
      new URL(`http://localhost/api/media/items/media-1?token=${token}`));
    assert.equal(res.statusCode, expected);
  }
});

test('bound authentication expiry caps playback issuance and renewal', async (t) => {
  const expiresAt = Date.now() + 60_000;
  const { service } = await fixture(t, {
    isSessionActive: async (id, accountId) => id === 'auth-1' && accountId === 'owner-1',
    getSessionExpiry: async () => expiresAt,
  });
  const lease = await service.issuePlaybackToken('media-1', 'owner-1', 'direct', { authenticationSessionId: 'auth-1' });
  assert.equal(lease.absoluteExpiresAt, expiresAt);
  assert.ok(lease.expiresAt <= expiresAt);
  const renewed = await service.renewPlaybackSession(lease.token, null, 'media-1');
  assert.equal(renewed.absoluteExpiresAt, expiresAt);
  assert.ok(renewed.expiresAt <= expiresAt);
});

test('expired bound authentication blocks reads and renewal even with another authenticated principal', async (t) => {
  const { service, registry } = await fixture(t, {
    isSessionActive: async () => false,
    getSessionExpiry: async () => null,
  });
  for (const authenticated of [false, true]) {
    const lease = registry.create({
      principalId: 'owner-1', itemId: 'media-1', action: 'direct',
      profile: { authenticationSessionId: 'expired-auth' },
    });
    assert.equal(await service.renewPlaybackSession(authenticated ? lease.id : lease.token,
      authenticated ? { id: 'owner-1', type: 'owner' } : null, 'media-1'), null);
    const res = response();
    res.__loomtvPublicApi = true;
    await service.handle({ method: 'HEAD', headers: {} }, res,
      new URL(`http://localhost/api/media/items/media-1?token=${lease.token}`));
    assert.equal(res.statusCode, 401);
  }
  await assert.rejects(() => service.issuePlaybackToken('media-1', 'owner-1', 'direct', {
    authenticationSessionId: 'expired-auth',
  }), { status: 401 });
});

test('HLS playlists embed capability URLs and reject listed IDs and expired authentication', async (t) => {
  let active = true;
  const expiresAt = Date.now() + 60_000;
  const { service, registry } = await fixture(t, {
    authenticateRequest: async () => ({ id: 'owner-1', type: 'owner', sessionId: 'auth-1' }),
    isSessionActive: async () => active,
    getSessionExpiry: async () => active ? expiresAt : null,
  }, {
    transcoder: { path: 'fixture-ffmpeg', getHealth: () => ({}) },
    spawnProcess: (_command, args) => {
      const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), exitCode: null });
      const playlistPath = args.at(-1);
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
      void Promise.all([
        fs.writeFile(playlistPath, '#EXTM3U\n#EXTINF:2,\nsegment-00000.ts\n'),
        fs.writeFile(path.join(path.dirname(playlistPath), 'segment-00000.ts'), 'segment bytes'),
      ]).then(() => { child.exitCode = 0; child.emit('exit', 0); }).catch((error) => child.emit('error', error));
      return child;
    },
  });
  const started = response();
  await service.handle({ method: 'POST', headers: { authorization: 'Bearer auth-token' } }, started,
    new URL('http://localhost/api/media/transcode?itemId=media-1&mode=remux'));
  assert.equal(started.statusCode, 202, started.body);
  const lease = JSON.parse(started.body).data;
  assert.equal(lease.absoluteExpiresAt, expiresAt);
  const playlistUrl = new URL(lease.playlistUrl, 'http://localhost');
  const token = playlistUrl.searchParams.get('token');
  const [listed] = await service.listSessions();
  assert.equal(listed.id, lease.sessionId);
  for (const file of ['index.m3u8', 'segment-00000.ts']) {
    for (const headers of [{}, { authorization: `Bearer ${listed.id}` }]) {
      const res = response();
      await service.handle({ method: 'HEAD', headers }, res,
        new URL(`http://localhost/api/media/transcode/${listed.id}/${file}?token=${listed.id}`));
      assert.equal(res.statusCode, 401);
    }
  }
  const playlist = response();
  await service.handle({ method: 'GET', headers: {} }, playlist, playlistUrl);
  assert.equal(playlist.statusCode, 200);
  const segmentPath = playlist.body.split('\n').find((line) => line.startsWith('segment-'));
  assert.equal(new URL(segmentPath, playlistUrl).searchParams.get('token'), token);
  const renewed = await service.renewPlaybackSession(token, null, 'media-1', 'hls');
  assert.ok(renewed);
  assert.equal(renewed.absoluteExpiresAt, expiresAt);
  const segment = response();
  await service.handle({ method: 'HEAD', headers: {} }, segment, new URL(segmentPath, playlistUrl));
  assert.equal(segment.statusCode, 200);
  const refreshed = response();
  await service.handle({ method: 'GET', headers: {} }, refreshed, playlistUrl);
  assert.equal(refreshed.statusCode, 200);
  assert.ok(refreshed.body.includes(`?token=${renewed.token}`));
  active = false;
  const denied = response();
  await service.handle({ method: 'HEAD', headers: {} }, denied, new URL(segmentPath, playlistUrl));
  assert.equal(denied.statusCode, 401);
  assert.equal(await service.renewPlaybackSession(renewed.token, null, 'media-1', 'hls'), null);
  assert.equal(registry.authorize(renewed.token), null);
});

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
