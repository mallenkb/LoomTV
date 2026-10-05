import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createCanonicalVideoServer } from 'loom-media-server-headless/runtime';
import { createHeadlessMediaService } from '../../server/src/media-service.js';
import { clearTranscodeCapabilityCache } from '@loom-media-server/transcode-capabilities';
import { createHeadlessTranscoder } from '../../server/src/transcoder.js';
import { publicHealthSummary } from '../../server/src/public-api.js';
import { ffmpegAvailability } from '../src/main/ipcHandlerPolicy.ts';
import { ffmpegFixture } from '../../../packages/transcode-capabilities/tests/fixtures/ffmpeg.mjs';
import '../../../packages/transcode-capabilities/tests/transcode-capabilities.test.mjs';

test('canonical health and desktop availability report probing without waiting for FFmpeg', async (t) => {
  clearTranscodeCapabilityCache();
  const fixture = await ffmpegFixture(t);
  const options = { ffmpegPath: fixture.binary, ffprobePath: fixture.binary, cacheDir: fixture.options.cacheDir };
  const transcoder = createHeadlessTranscoder(options);
  const second = createHeadlessTranscoder(options);
  const health = transcoder.getHealth();
  assert.equal(health.state, 'probing');
  assert.equal(health.probing, true);
  assert.equal(health.available, true);
  assert.equal(publicHealthSummary({ transcoder: health }).transcoder.state, 'probing');
  const status = ffmpegAvailability(() => fixture.binary, () => transcoder.getCapabilities());
  assert.equal(status.available, true);
  assert.equal(status.capabilities?.state, 'probing');
  const [firstResult, secondResult] = await Promise.all([transcoder.awaitCapabilities(), second.awaitCapabilities()]);
  assert.equal(firstResult, secondResult);
  assert.equal(transcoder.getHealth().probing, false);
  assert.equal(transcoder.getHealth().softwareCodecs.h264, true);
  assert.equal((await fixture.calls()).length, process.platform === 'darwin' ? 6 : 4);
});

test('canonical self-test awaits asynchronous probes and refreshes the shared result', async (t) => {
  clearTranscodeCapabilityCache();
  const fixture = await ffmpegFixture(t);
  const transcoder = createHeadlessTranscoder({ ffmpegPath: fixture.binary, ffprobePath: fixture.binary, cacheDir: fixture.options.cacheDir });
  await transcoder.awaitCapabilities();
  const pending = transcoder.getSelfTest();
  assert.equal(transcoder.getHealth().state, 'probing');
  const result = await pending;
  assert.notEqual(result.state, 'probing');
  assert.ok(result.completedAt >= result.startedAt);
  assert.equal(result.backends.length, 6);
  assert.equal((await fixture.calls()).length, process.platform === 'darwin' ? 12 : 8);
  assert.equal(transcoder.getHealth().state, result.state);
});

test('the canonical public health route reports probing and later serves the completed result', async (t) => {
  clearTranscodeCapabilityCache();
  const fixture = await ffmpegFixture(t);
  const transcoder = createHeadlessTranscoder({ ffmpegPath: fixture.binary, ffprobePath: fixture.binary, cacheDir: fixture.options.cacheDir });
  await fs.mkdir(path.join(fixture.directory, 'data'));
  const server = createCanonicalVideoServer({
    host: '127.0.0.1', port: 0, version: 'test',
    paths: { dataDir: path.join(fixture.directory, 'data'), cacheDir: fixture.options.cacheDir, mediaDir: null },
    transcoder,
  });
  t.after(() => server.stop());
  const address = await server.start();
  const url = `http://127.0.0.1:${address.port}/api/v1/health`;
  const first = await (await fetch(url)).json();
  assert.equal(first.data.transcoder, 'probing');
  await transcoder.awaitCapabilities();
  const completed = await (await fetch(url)).json();
  assert.notEqual(completed.data.transcoder, 'probing');
  assert.equal((await fixture.calls()).length, process.platform === 'darwin' ? 6 : 4);
});

test('canonical playback awaits capabilities before selecting and spawning an encoder', { timeout: 5000 }, async (t) => {
  const fixture = await ffmpegFixture(t);
  const filePath = path.join(fixture.directory, 'video.mkv');
  await fs.writeFile(filePath, 'fixture media');
  const fileId = await fs.stat(filePath);
  let enterProbe!: () => void;
  const entered = new Promise<void>((resolve) => { enterProbe = resolve; });
  let finishProbe!: () => void;
  const pending = new Promise<void>((resolve) => { finishProbe = resolve; });
  let spawns = 0;
  let awaits = 0;
  const capabilities = {
    softwareCodecs: { h264: true, hevc: false, av1: false },
    softwareEncoders: { h264: 'libx264' }, backends: [], recommendedBackend: 'software', toneMapping: false,
  };
  const principal = { id: 'owner-1', type: 'owner' };
  const service = createHeadlessMediaService({
    cacheDir: fixture.options.cacheDir,
    cacheQuotaOptions: { sweepIntervalMs: 0, minFreeBytes: 0 },
    authorize: async () => true,
    adminService: {
      authenticateRequest: async () => principal,
      getPrincipalById: async () => principal,
      authorizePrincipal: async () => true,
      resolveMediaPath: async () => ({ id: 'media-1', sourceId: 'source-1', rootPath: fixture.directory, path: filePath, fileId }),
    },
    transcoder: {
      path: fixture.binary,
      getHealth: () => ({ ...capabilities, softwareCodecs: { h264: false, hevc: false, av1: false } }),
      async awaitCapabilities() { awaits += 1; enterProbe(); await pending; return capabilities; },
    },
    spawnProcess: (_command: string, args: string[]) => {
      spawns += 1;
      assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
      const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), exitCode: null as number | null, kill: () => true });
      const playlist = args.at(-1) as string;
      void Promise.all([
        fs.writeFile(playlist, '#EXTM3U\n#EXTINF:2,\nsegment-00000.ts\n'),
        fs.writeFile(path.join(path.dirname(playlist), 'segment-00000.ts'), 'segment bytes'),
      ]).then(() => { child.exitCode = 0; child.emit('exit', 0); });
      return child;
    },
  });
  t.after(() => service.stop());
  const res = Object.assign(new EventEmitter(), {
    headersSent: false, statusCode: 0, body: '',
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; },
    end(body: string) { this.body = body; return this; },
  });
  const started = service.handle({ method: 'POST', headers: { authorization: 'Bearer fixture-token' } }, res,
    new URL('http://localhost/api/media/transcode?itemId=media-1&mode=transcode&backend=software'));
  assert.equal(await Promise.race([entered.then(() => true), started.then(() => false)]), true, res.body);
  assert.equal(spawns, 0);
  assert.equal(res.headersSent, false);
  finishProbe();
  await started;
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(spawns, 1);
  assert.equal(awaits, 2);
});
