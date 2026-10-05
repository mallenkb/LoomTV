import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegFixture } from './fixtures/ffmpeg.mjs';
import {
  clearTranscodeCapabilityCache,
  getTranscodeCapabilities,
  probeTranscodeCapabilities,
} from '../src/index.mjs';

function fixtureRunner({ smokeSucceeds = true } = {}) {
  const calls = [];
  const run = (_command, args) => {
    calls.push([...args]);
    if (args.includes('-encoders')) {
      return 'h264_videotoolbox hevc_videotoolbox libx264 libx265 libsvtav1';
    }
    if (args.includes('-decoders')) return 'videotoolbox';
    if (args.includes('-hwaccels')) return 'videotoolbox';
    if (args.includes('-filters')) return 'zscale tonemap';
    if (args.includes('-frames:v')) {
      if (!smokeSucceeds) throw new Error('fixture smoke failure');
      return '';
    }
    return '';
  };
  return { calls, run };
}

test('a missing FFmpeg binary returns the fail-safe unavailable contract', async () => {
  clearTranscodeCapabilityCache();
  const result = await probeTranscodeCapabilities(null, { platform: 'linux', environment: {} });

  assert.equal(result.state, 'unavailable');
  assert.equal(result.ffmpegPath, null);
  assert.equal(result.recommendedBackend, 'software');
  assert.equal(result.hardwareAcceleration, false);
  assert.equal(result.softwareFallback, true);
  assert.deepEqual(result.backends, []);
  assert.deepEqual(result.codecs, { h264: false, hevc: false, av1: false });
});

test('a successful hardware probe reports codecs, software fallbacks, and tone mapping', async () => {
  clearTranscodeCapabilityCache();
  const fixture = fixtureRunner();
  const result = await probeTranscodeCapabilities(process.execPath, {
    platform: 'darwin',
    environment: {},
    commandRunner: fixture.run,
  });

  assert.equal(result.state, 'available');
  assert.equal(result.recommendedBackend, 'videotoolbox');
  assert.equal(result.hardwareAcceleration, true);
  assert.deepEqual(result.codecs, { h264: true, hevc: true, av1: false });
  assert.deepEqual(result.softwareCodecs, { h264: true, hevc: true, av1: true });
  assert.deepEqual(result.softwareEncoders, {
    h264: 'libx264',
    hevc: 'libx265',
    av1: 'libsvtav1',
  });
  assert.equal(result.toneMapping, true);

  const videotoolbox = result.backends.find(({ id }) => id === 'videotoolbox');
  assert.equal(videotoolbox.platformSupported, true);
  assert.equal(videotoolbox.device, 'system');
  assert.equal(videotoolbox.codecs.h264.verified, true);
  assert.ok(fixture.calls.some((args) => args.includes('-allow_sw') && args.includes('0')));
});

test('a failed hardware smoke probe remains limited with software available', async () => {
  clearTranscodeCapabilityCache();
  const fixture = fixtureRunner({ smokeSucceeds: false });
  const result = await probeTranscodeCapabilities(process.execPath, {
    platform: 'darwin',
    environment: {},
    commandRunner: fixture.run,
  });

  assert.equal(result.state, 'limited');
  assert.equal(result.recommendedBackend, 'software');
  assert.equal(result.hardwareAcceleration, false);
  assert.equal(result.softwareCodecs.h264, true);
  assert.match(result.reason, /No hardware H\.264 encoder/);
  assert.equal(
    result.backends.find(({ id }) => id === 'videotoolbox').codecs.h264.reason,
    'Encoder is compiled in but failed the FFmpeg device probe.',
  );
});

test('a command runner with no inspection output fails closed instead of throwing', async () => {
  clearTranscodeCapabilityCache();
  const result = await probeTranscodeCapabilities(process.execPath, {
    platform: 'darwin',
    environment: {},
    commandRunner: () => undefined,
  });

  assert.equal(result.state, 'limited');
  assert.equal(result.hardwareAcceleration, false);
  assert.deepEqual(result.softwareCodecs, { h264: false, hevc: false, av1: false });
});

test('skipSmokeTest trusts compiled encoders without executing a frame probe', async () => {
  clearTranscodeCapabilityCache();
  const fixture = fixtureRunner({ smokeSucceeds: false });
  const result = await probeTranscodeCapabilities(process.execPath, {
    platform: 'darwin',
    environment: {},
    commandRunner: fixture.run,
    skipSmokeTest: true,
  });

  assert.equal(result.state, 'available');
  assert.equal(result.backends.find(({ id }) => id === 'videotoolbox').codecs.h264.verified, true);
  assert.equal(fixture.calls.some((args) => args.includes('-frames:v')), false);
});

test('Windows QSV uses an implicit GPU and verifies each compiled encoder', async () => {
  for (const smokeSucceeds of [true, false]) {
    const calls = [];
    const result = await probeTranscodeCapabilities(process.execPath, {
      platform: 'win32',
      environment: {},
      commandRunner: (_command, args, options) => {
        calls.push([...args]);
        assert.equal(options.windowsHide, true);
        if (args.includes('-encoders')) return 'h264_qsv hevc_qsv libx264 h264_vaapi';
        if (args.includes('-hwaccels')) return 'qsv vaapi';
        if (args.includes('-frames:v') && !smokeSucceeds) throw new Error('No Intel GPU');
        return '';
      },
    });
    const qsv = result.backends.find(({ id }) => id === 'qsv');
    assert.equal(qsv.device, 'windows-gpu');
    assert.equal(qsv.platformSupported, true);
    assert.equal(qsv.available, smokeSucceeds);
    assert.equal(qsv.codecs.h264.verified, smokeSucceeds);
    assert.equal(qsv.codecs.hevc.verified, smokeSucceeds);
    assert.equal(qsv.codecs.av1.compiled, false);
    assert.equal(result.recommendedBackend, smokeSucceeds ? 'qsv' : 'software');
    assert.equal(result.backends.find(({ id }) => id === 'vaapi').device, null);
    assert.deepEqual(calls.filter((args) => args.includes('-frames:v')), ['h264_qsv', 'hevc_qsv'].map((encoder) => [
      '-hide_banner', '-loglevel', 'error', '-init_hw_device', 'qsv=hw',
      '-f', 'lavfi', '-i', 'color=c=black:s=128x128:r=1', '-frames:v', '1',
      '-vf', 'format=nv12,hwupload', '-an', '-c:v', encoder, '-f', 'null', '-',
    ]));
  }
});

test('status reads return probing while one asynchronous probe serves concurrent callers', async (t) => {
  clearTranscodeCapabilityCache();
  const fixture = await ffmpegFixture(t);
  assert.equal(getTranscodeCapabilities(fixture.binary, fixture.options).state, 'probing');
  const first = probeTranscodeCapabilities(fixture.binary, fixture.options);
  const second = probeTranscodeCapabilities(fixture.binary, fixture.options);
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getTranscodeCapabilities(fixture.binary, fixture.options).state, 'probing');
  const result = await first;
  assert.equal(result.state, 'available');
  assert.equal(getTranscodeCapabilities(fixture.binary, fixture.options), result);
  assert.equal((await fixture.calls()).length, 6);
});

test('the memory cache does not expire and explicit self-tests refresh it', async (t) => {
  clearTranscodeCapabilityCache();
  const fixture = await ffmpegFixture(t);
  const result = await probeTranscodeCapabilities(fixture.binary, fixture.options);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 60_000);
  assert.equal(await probeTranscodeCapabilities(fixture.binary, fixture.options), result);
  assert.equal((await fixture.calls()).length, 6);
  const refreshed = await probeTranscodeCapabilities(fixture.binary, { ...fixture.options, force: true });
  assert.notEqual(refreshed, result);
  assert.equal((await fixture.calls()).length, 12);
});

test('the disk cache survives a new process without running FFmpeg again', async (t) => {
  clearTranscodeCapabilityCache();
  const fixture = await ffmpegFixture(t);
  const result = await probeTranscodeCapabilities(fixture.binary, fixture.options);
  const moduleUrl = new URL('../src/index.mjs', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    const { probeTranscodeCapabilities } = await import(${JSON.stringify(moduleUrl)});
    const result = await probeTranscodeCapabilities(${JSON.stringify(fixture.binary)}, ${JSON.stringify(fixture.options)});
    console.log(JSON.stringify({ state: result.state, probedAt: result.probedAt }));
  `]);
  assert.deepEqual(JSON.parse(stdout), { state: 'available', probedAt: result.probedAt });
  assert.equal((await fixture.calls()).length, 6);
});

test('binary path, size, mtime and OS changes invalidate memory and disk results', async (t) => {
  clearTranscodeCapabilityCache();
  const fixture = await ffmpegFixture(t);
  await probeTranscodeCapabilities(fixture.binary, fixture.options);
  let binary = fixture.binary;
  const release = os.release();
  const changes = [
    async () => {
      binary = path.join(fixture.directory, 'replacement-ffmpeg');
      await fs.copyFile(fixture.binary, binary);
      await fs.chmod(binary, 0o700);
    },
    () => fs.appendFile(binary, '\n'),
    () => fs.utimes(binary, new Date(), new Date(Date.now() + 60_000)),
    async () => { t.mock.method(os, 'release', () => `${release}-changed`); },
  ];
  for (const [index, change] of changes.entries()) {
    await change();
    assert.equal(getTranscodeCapabilities(binary, fixture.options).state, 'probing');
    assert.equal((await probeTranscodeCapabilities(binary, fixture.options)).state, 'available');
    assert.equal((await fixture.calls()).length, 6 * (index + 2));
  }
});

test('corrupt and malformed disk results are rebuilt instead of reaching callers', async (t) => {
  clearTranscodeCapabilityCache();
  const fixture = await ffmpegFixture(t);
  await probeTranscodeCapabilities(fixture.binary, fixture.options);
  const [name] = await fs.readdir(fixture.options.cacheDir);
  const target = path.join(fixture.options.cacheDir, name);
  const saved = JSON.parse(await fs.readFile(target, 'utf8'));
  for (const [index, content] of ['{broken', JSON.stringify({ ...saved, capabilities: { ...saved.capabilities, backends: [null] } })].entries()) {
    await fs.writeFile(target, content);
    clearTranscodeCapabilityCache();
    assert.equal((await probeTranscodeCapabilities(fixture.binary, fixture.options)).state, 'available');
    assert.equal((await fixture.calls()).length, 6 * (index + 2));
  }
});

test('an unwritable cache still shares the completed in-memory result', async (t) => {
  clearTranscodeCapabilityCache();
  const fixture = await ffmpegFixture(t);
  const options = { ...fixture.options, cacheDir: fixture.binary };
  const result = await probeTranscodeCapabilities(fixture.binary, options);
  assert.equal(result.state, 'available');
  assert.equal(await probeTranscodeCapabilities(fixture.binary, options), result);
  assert.equal((await fixture.calls()).length, 6);
});

test('encoder timeouts are asynchronous and retain the software fallback', async (t) => {
  clearTranscodeCapabilityCache();
  const fixture = await ffmpegFixture(t, { hangSmokeTest: true });
  const options = { ...fixture.options, probeTimeoutMs: 750 };
  const pending = probeTranscodeCapabilities(fixture.binary, options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getTranscodeCapabilities(fixture.binary, options).state, 'probing');
  const result = await pending;
  assert.equal(result.state, 'limited');
  assert.equal(result.softwareCodecs.h264, true);
  assert.equal(result.backends.find(({ id }) => id === 'videotoolbox').codecs.h264.verified, false);
});
