import assert from 'node:assert/strict';
import test from 'node:test';

import { factsVideoSpecs, mergeVideoSpecs, probeVideoSpecs, resolutionName, videoSpecRows } from '../src/components/VideoPlayer/videoSpecs.ts';

test('video specs describe a 10-bit HDR HEVC file', () => {
  const specs = probeVideoSpecs({
    container: 'matroska',
    bitrateKbps: 18_460,
    tracks: [
      { index: 0, type: 'video', codec: 'hevc', profile: 'Main 10', width: 3840, height: 2160, pixelFormat: 'yuv420p10le', frameRate: 23.976023976, colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' },
      { index: 1, type: 'audio', codec: 'eac3' },
    ],
  });
  assert.deepEqual(videoSpecRows(specs), [
    ['Resolution', '3840 × 2160 (4K)'],
    ['Video format', 'HEVC Main 10'],
    ['Color', '10-bit 4:2:0'],
    ['Frame rate', '23.976 fps'],
    ['Dynamic range', 'HDR10 (PQ)'],
    ['Bitrate', '18.5 Mb/s'],
    ['Container', 'MKV'],
  ]);
});

test('the playing size is listed only when it differs from the file', () => {
  const specs = { width: 1920, height: 1080, codec: 'h264' };
  assert.equal(videoSpecRows(specs, { width: 1920, height: 1080 }).some(([label]) => label === 'Playing at'), false);
  assert.deepEqual(videoSpecRows(specs, { width: 1280, height: 720 })[1], ['Playing at', '1280 × 720 (720p)']);
});

test('the live probe wins and saved library facts fill the gaps', () => {
  const merged = mergeVideoSpecs(
    probeVideoSpecs({ tracks: [{ type: 'video', width: 1920, height: 800, frameRate: 24 }] }),
    factsVideoSpecs({ width: 1280, height: 720, videoCodec: 'h264', videoProfile: 'High', container: 'mov' }),
  );
  assert.deepEqual(videoSpecRows(merged), [
    ['Resolution', '1920 × 800 (1080p)'],
    ['Video format', 'H.264 High'],
    ['Frame rate', '24 fps'],
    ['Container', 'MP4 / MOV'],
  ]);
});

test('missing or malformed probe data produces no rows', () => {
  assert.deepEqual(videoSpecRows(probeVideoSpecs(undefined)), []);
  assert.deepEqual(videoSpecRows(probeVideoSpecs({ tracks: 'nope', bitrateKbps: -1 })), []);
  assert.equal(resolutionName(720, 480), '480p');
});
