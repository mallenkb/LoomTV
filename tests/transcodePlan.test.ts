import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  HLS_SEGMENT_SECONDS,
  TRANSCODE_READY_SEGMENTS,
  buildEmbeddedSubtitleVttArgs,
  buildHlsArgs,
} from '../src/main/transcodePlan.ts';

const outputPath = path.join('/tmp', 'loomtv-transcode-test', 'index.m3u8');

test('HLS startup waits for enough buffered media to avoid immediate underruns', () => {
  assert.equal(TRANSCODE_READY_SEGMENTS, 2);
  assert.equal(HLS_SEGMENT_SECONDS, 2);
});

test('HLS args stream-copy browser-safe video and audio when no burn-in is needed', () => {
  const args = buildHlsArgs({
    filePath: '/media/movie.mkv',
    outputPath,
    options: {},
    preset: 'software',
    mediaInfo: {
      videoCodec: 'h264',
      videoProfile: 'Main',
      pixelFormat: 'yuv420p',
      audioCodec: 'aac',
    },
  });

  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2), ['-c:v', 'copy']);
  assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'copy']);
  assert.equal(args.includes('-vf'), false);
  assert.equal(args.includes('-force_key_frames'), false);
});

test('HLS args re-encode when subtitles must be burned in', () => {
  const args = buildHlsArgs({
    filePath: '/media/movie.mkv',
    outputPath,
    options: {
      subtitleTrackIndex: 2,
      subtitleStreamOrdinal: 0,
      subtitleCodec: 'subrip',
    },
    preset: 'software',
    mediaInfo: {
      videoCodec: 'h264',
      videoProfile: 'Main',
      pixelFormat: 'yuv420p',
      audioCodec: 'aac',
    },
  });

  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2), ['-c:v', 'libx264']);
  assert.ok(args.includes('-vf'));
  assert.ok(args.includes('-force_key_frames'));
});

test('embedded subtitle extraction emits a WebVTT stream from the selected subtitle ordinal', () => {
  assert.deepEqual(buildEmbeddedSubtitleVttArgs('/media/movie.mkv', 2), [
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    '/media/movie.mkv',
    '-map',
    '0:s:2',
    '-f',
    'webvtt',
    'pipe:1',
  ]);
});
