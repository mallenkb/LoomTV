import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRANSCODE_BACKENDS,
  backendEncoder,
  clearTranscodeCapabilityCache,
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

test('the public backend registry is ordered and immutable', () => {
  assert.deepEqual(TRANSCODE_BACKENDS, [
    'videotoolbox',
    'nvenc',
    'qsv',
    'vaapi',
    'amf',
    'rkmpp',
  ]);
  assert.equal(Object.isFrozen(TRANSCODE_BACKENDS), true);
});

test('a missing FFmpeg binary returns the fail-safe unavailable contract', () => {
  clearTranscodeCapabilityCache();
  const result = probeTranscodeCapabilities(null, { platform: 'linux', environment: {} });

  assert.equal(result.state, 'unavailable');
  assert.equal(result.ffmpegPath, null);
  assert.equal(result.recommendedBackend, 'software');
  assert.equal(result.hardwareAcceleration, false);
  assert.equal(result.softwareFallback, true);
  assert.deepEqual(result.backends, []);
  assert.deepEqual(result.codecs, { h264: false, hevc: false, av1: false });
});

test('a successful hardware probe reports codecs, software fallbacks, and tone mapping', () => {
  clearTranscodeCapabilityCache();
  const fixture = fixtureRunner();
  const result = probeTranscodeCapabilities(process.execPath, {
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
  assert.equal(backendEncoder(result, 'videotoolbox'), 'h264_videotoolbox');
  assert.equal(backendEncoder(result, 'videotoolbox', 'hevc'), 'hevc_videotoolbox');
  assert.ok(fixture.calls.some((args) => args.includes('-allow_sw') && args.includes('0')));
});

test('a failed hardware smoke probe remains limited with software available', () => {
  clearTranscodeCapabilityCache();
  const fixture = fixtureRunner({ smokeSucceeds: false });
  const result = probeTranscodeCapabilities(process.execPath, {
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

test('a command runner with no inspection output fails closed instead of throwing', () => {
  clearTranscodeCapabilityCache();
  const result = probeTranscodeCapabilities(process.execPath, {
    platform: 'darwin',
    environment: {},
    commandRunner: () => undefined,
  });

  assert.equal(result.state, 'limited');
  assert.equal(result.hardwareAcceleration, false);
  assert.deepEqual(result.softwareCodecs, { h264: false, hevc: false, av1: false });
});

test('skipSmokeTest trusts compiled encoders without executing a frame probe', () => {
  clearTranscodeCapabilityCache();
  const fixture = fixtureRunner({ smokeSucceeds: false });
  const result = probeTranscodeCapabilities(process.execPath, {
    platform: 'darwin',
    environment: {},
    commandRunner: fixture.run,
    skipSmokeTest: true,
  });

  assert.equal(result.state, 'available');
  assert.equal(result.backends.find(({ id }) => id === 'videotoolbox').codecs.h264.verified, true);
  assert.equal(fixture.calls.some((args) => args.includes('-frames:v')), false);
});

test('backendEncoder returns null for absent capability data', () => {
  assert.equal(backendEncoder(null, 'nvenc'), null);
  assert.equal(backendEncoder({ backends: [] }, 'nvenc'), null);
});
