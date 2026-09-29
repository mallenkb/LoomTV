import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  HLS_MAX_LEAD_SEGMENTS,
  HLS_RESUME_LEAD_SEGMENTS,
  hlsPacingDecision,
  hlsSegmentIndex,
} from '../src/hls-pacing.js';
import { createHeadlessMediaService } from '../src/media-service.js';
import { createPlaybackSessionRegistry } from '../src/playback-session-registry.js';

test('the encoder pauses far ahead of the client and resumes when it catches up', () => {
  assert.equal(hlsPacingDecision({ producedIndex: HLS_MAX_LEAD_SEGMENTS - 2, requestedIndex: null, suspended: false }), null);
  assert.equal(hlsPacingDecision({ producedIndex: HLS_MAX_LEAD_SEGMENTS - 1, requestedIndex: null, suspended: false }), 'suspend');
  assert.equal(hlsPacingDecision({ producedIndex: 100, requestedIndex: 100 - HLS_RESUME_LEAD_SEGMENTS - 1, suspended: true }), null);
  assert.equal(hlsPacingDecision({ producedIndex: 100, requestedIndex: 100 - HLS_RESUME_LEAD_SEGMENTS, suspended: true }), 'resume');
  assert.equal(hlsPacingDecision({ producedIndex: 10, requestedIndex: 40, suspended: true }), 'resume', 'a forward seek resumes');
});

test('segment names support indexes beyond five-digit minimum padding', () => {
  assert.equal(hlsSegmentIndex('segment-00042.ts'), 42);
  assert.equal(hlsSegmentIndex('segment-100000.ts'), 100000);
  assert.equal(hlsSegmentIndex('segment-9007199254740992.ts'), null);
  assert.equal(hlsSegmentIndex('../segment-00042.ts'), null);
  assert.equal(hlsSegmentIndex('index.m3u8'), null);
});

const ffmpeg = (() => {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
})();

test('a full remux keeps its first segments and a playlist that starts at them', {
  skip: !ffmpeg ? 'ffmpeg is not installed' : false,
  timeout: 120_000,
}, async (t) => {
  const { service, outputDirFor, response, segments, waitFor } = await pacingFixture(t, {
    spawnProcess: undefined,
    transcoder: { path: ffmpeg, getHealth: () => ({ softwareCodecs: { h264: true } }) },
    sourceSeconds: 180,
  });
  const started = response();
  await service.handle({ method: 'POST', headers: { authorization: 'Bearer owner' } }, started,
    new URL('http://localhost/api/media/transcode?itemId=media-1&mode=remux'));
  assert.equal(started.statusCode, 202, started.body);
  const lease = JSON.parse(started.body).data;
  const outputDir = outputDirFor(lease);
  const playlistUrl = new URL(lease.playlistUrl, 'http://localhost');
  // A slower remux may hit the lead limit before finishing. Advance the
  // consumer through real files instead of depending on remux speed.
  assert.ok(await waitFor(async () => {
    const current = await fs.readFile(path.join(outputDir, 'index.m3u8'), 'utf8').catch(() => '');
    const latest = (current.match(/^segment-\d+\.ts$/gm) || []).at(-1);
    if (latest) {
      const segment = response();
      await service.handle({ method: 'HEAD', headers: {} }, segment,
        new URL(`${latest}?token=${playlistUrl.searchParams.get('token')}`, playlistUrl));
      assert.equal(segment.statusCode, 200, 'an advertised segment must exist');
    }
    return current.includes('#EXT-X-ENDLIST');
  }, 60_000));
  const playlist = await fs.readFile(path.join(outputDir, 'index.m3u8'), 'utf8');
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:EVENT/);
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:0/);
  assert.match(playlist, /^segment-00000\.ts$/m);
  const written = await segments(outputDir);
  assert.equal(written.length, 90);
  assert.ok(written.includes(0));
});

test('the encoder pauses ahead of the client and resumes when it catches up', {
  skip: !ffmpeg ? 'ffmpeg is not installed' : process.platform === 'win32' ? 'encoder pausing needs POSIX signals' : false,
  timeout: 60_000,
}, async (t) => {
  const fakeEncoder = fileURLToPath(new URL('./fixtures/fake-hls-encoder.mjs', import.meta.url));
  const { service, outputDirFor, response, segments, waitFor } = await pacingFixture(t, {
    spawnProcess: (_command, args, options) => spawn(process.execPath, [fakeEncoder, ...args], options),
    transcoder: { path: 'fake-ffmpeg', getHealth: () => ({ softwareCodecs: { h264: true } }) },
    sourceSeconds: 2,
  });
  const started = response();
  await service.handle({ method: 'POST', headers: { authorization: 'Bearer owner' } }, started,
    new URL('http://localhost/api/media/transcode?itemId=media-1&mode=remux'));
  assert.equal(started.statusCode, 202, started.body);
  const lease = JSON.parse(started.body).data;
  const playlistUrl = new URL(lease.playlistUrl, 'http://localhost');
  const outputDir = outputDirFor(lease);

  // Unpaced, the stand-in reaches segment 599 in 12 seconds.
  assert.ok(await waitFor(async () => (await segments(outputDir)).length >= HLS_MAX_LEAD_SEGMENTS, 20_000));
  await new Promise((resolve) => { setTimeout(resolve, 1_000); });
  const paused = Math.max(...await segments(outputDir));
  assert.ok(paused < HLS_MAX_LEAD_SEGMENTS + 20, `encoder reached segment ${paused} before pausing`);
  await new Promise((resolve) => { setTimeout(resolve, 1_500); });
  assert.equal(Math.max(...await segments(outputDir)), paused, 'a paused encoder must not keep writing');

  const missing = response();
  await service.handle({ method: 'HEAD', headers: {} }, missing,
    new URL(`segment-99999.ts?token=${playlistUrl.searchParams.get('token')}`, playlistUrl));
  assert.equal(missing.statusCode, 404);
  await new Promise((resolve) => { setTimeout(resolve, 750); });
  assert.equal(Math.max(...await segments(outputDir)), paused, 'a missing segment must not advance the consumer');

  const segment = response();
  await service.handle({ method: 'HEAD', headers: {} }, segment,
    new URL(`segment-${String(paused - 5).padStart(5, '0')}.ts?token=${playlistUrl.searchParams.get('token')}`, playlistUrl));
  assert.equal(segment.statusCode, 200);
  assert.ok(await waitFor(async () => Math.max(...await segments(outputDir)) > paused + 10, 10_000), 'the encoder should resume');
  // With the client at paused - 5, the encoder pauses again about 60 segments later.
  await new Promise((resolve) => { setTimeout(resolve, 2_500); });
  const again = Math.max(...await segments(outputDir));
  assert.ok(again < paused - 5 + HLS_MAX_LEAD_SEGMENTS + 20, `encoder reached segment ${again} after resuming`);
  assert.ok((await segments(outputDir)).includes(0), 'a small session keeps its early segments');
});

async function pacingFixture(t, { spawnProcess, transcoder, sourceSeconds }) {
  const cacheDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-hls-pacing-')));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const sourcePath = path.join(cacheDir, 'video.mp4');
  if (sourceSeconds > 0) {
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050', '-t', String(sourceSeconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-shortest', sourcePath]);
    assert.equal(generated.status, 0, String(generated.stderr));
  } else {
    await fs.writeFile(sourcePath, 'fixture');
  }
  const fileId = await fs.stat(sourcePath);
  const registry = createPlaybackSessionRegistry({ sweepIntervalMs: 0 });
  const principal = { id: 'owner-1', type: 'owner' };
  const service = createHeadlessMediaService({
    cacheDir,
    playbackSessionRegistry: registry,
    cacheQuotaOptions: { sweepIntervalMs: 0, minFreeBytes: 0 },
    authorize: async () => true,
    transcoder,
    ...(spawnProcess ? { spawnProcess } : {}),
    adminService: {
      authenticateRequest: async () => principal,
      getPrincipalById: async () => principal,
      authorizePrincipal: async () => true,
      resolveMediaPath: async () => ({ id: 'media-1', sourceId: 'source-1', rootPath: cacheDir, path: sourcePath, fileId }),
    },
  });
  t.after(async () => { await service.stop(); registry.close(); });
  return {
    service,
    outputDirFor: (lease) => path.join(cacheDir, 'headless-transcodes', lease.sessionId),
    response: () => ({ statusCode: 0, body: '', writeHead(status) { this.statusCode = status; }, end(body = '') { this.body = String(body); } }),
    segments: async (outputDir) => (await fs.readdir(outputDir).catch(() => [])).map(hlsSegmentIndex).filter((index) => index !== null),
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if (await predicate()) return true; await new Promise((resolve) => { setTimeout(resolve, 100); }); }
      return false;
    },
  };
}
