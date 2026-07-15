import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  HLS_SEGMENT_SECONDS,
  HLS_WINDOW_SEGMENTS,
  TRANSCODE_READY_SEGMENTS,
  buildEmbeddedSubtitleVttArgs,
  buildHlsArgs,
  buildVodPlaylist,
  shouldRepositionEncoder,
  transcodeSegmentCount,
  transcodeSegmentName,
  transcodeSessionKey,
} from '../src/main/transcodePlan.ts';

const outputPath = path.join('/tmp', 'loomtv-transcode-test', 'index.m3u8');

test('HLS startup reports ready after the first segment for fast seek response', () => {
  assert.equal(TRANSCODE_READY_SEGMENTS, 1);
  assert.equal(HLS_SEGMENT_SECONDS, 2);
  assert.equal(HLS_WINDOW_SEGMENTS, 45);
});

test('segment file names are zero-padded to match FFmpeg %05d output', () => {
  assert.equal(transcodeSegmentName(0), 'segment-00000.ts');
  assert.equal(transcodeSegmentName(42), 'segment-00042.ts');
  assert.equal(transcodeSegmentName(12345), 'segment-12345.ts');
});

test('segment count covers the whole duration with a partial final segment', () => {
  assert.equal(transcodeSegmentCount(10, 2), 5);
  assert.equal(transcodeSegmentCount(11, 2), 6); // partial last segment
  assert.equal(transcodeSegmentCount(0, 2), 0);
  assert.equal(transcodeSegmentCount(5, 0), 0);
});

test('VOD playlist lists every segment up front and ends with ENDLIST', () => {
  const playlist = buildVodPlaylist({ durationSeconds: 7, segmentSeconds: 2 });
  const lines = playlist.trim().split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.ok(lines.includes('#EXT-X-PLAYLIST-TYPE:VOD'));
  assert.ok(lines.includes('#EXT-X-TARGETDURATION:2'));
  const segments = lines.filter((line) => line.endsWith('.ts'));
  assert.deepEqual(segments, [
    'segment-00000.ts',
    'segment-00001.ts',
    'segment-00002.ts',
    'segment-00003.ts',
  ]);
  // Final segment is the 1s remainder, earlier segments are full length.
  assert.ok(playlist.includes('#EXTINF:2.000000,'));
  assert.ok(playlist.includes('#EXTINF:1.000000,'));
  assert.equal(lines[lines.length - 1], '#EXT-X-ENDLIST');
});

test('encoder repositions on a seek but waits during sequential playback', () => {
  const base = { windowStartIndex: 10, lastRequestedIndex: 12, processAlive: true, contiguityTolerance: 3 };
  // Cached on disk: always served, never restart.
  assert.equal(shouldRepositionEncoder({ ...base, requestedIndex: 4, segmentOnDisk: true }), false);
  // Sequential fill just ahead of the last request: wait for the encoder.
  assert.equal(shouldRepositionEncoder({ ...base, requestedIndex: 14, segmentOnDisk: false }), false);
  // Forward seek past the contiguity window: reposition.
  assert.equal(shouldRepositionEncoder({ ...base, requestedIndex: 40, segmentOnDisk: false }), true);
  // Backward before the current window with no cached file: reposition.
  assert.equal(shouldRepositionEncoder({ ...base, requestedIndex: 3, segmentOnDisk: false }), true);
  // Dead encoder: reposition to respawn.
  assert.equal(shouldRepositionEncoder({ ...base, requestedIndex: 13, segmentOnDisk: false, processAlive: false }), true);
});

test('seekable HLS args re-encode with global numbering and timeline offset', () => {
  const args = buildHlsArgs({
    filePath: '/media/movie.mkv',
    outputPath,
    options: { startSeconds: 120 },
    preset: 'software',
    mediaInfo: { videoCodec: 'h264', videoProfile: 'high', pixelFormat: 'yuv420p', audioCodec: 'aac' },
    seekable: true,
    startNumber: 60,
    segmentSeconds: 2,
  });
  // Even copy-safe video must re-encode so keyframes land on the segment grid,
  // and copy-safe audio must re-encode so A/V/subtitle timestamps stay aligned.
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  // Re-encoded audio is resampled against the video clock so it stays in lip-sync
  // across input seeks and on-demand window respawns.
  assert.equal(args[args.indexOf('-af') + 1], 'aresample=async=1:first_pts=0');
  // Global segment numbering + absolute-timeline timestamps.
  assert.equal(args[args.indexOf('-start_number') + 1], '60');
  assert.equal(args[args.indexOf('-output_ts_offset') + 1], '120');
  assert.equal(args[args.indexOf('-avoid_negative_ts') + 1], 'disabled');
  assert.equal(args[args.indexOf('-t') + 1], String(HLS_SEGMENT_SECONDS * HLS_WINDOW_SEGMENTS));
  assert.ok(args.includes('-force_key_frames'));
});

test('non-seekable HLS args keep stream-copy while bounding the live playlist', () => {
  const args = buildHlsArgs({
    filePath: '/media/movie.mkv',
    outputPath,
    options: {},
    preset: 'videotoolbox',
    mediaInfo: { videoCodec: 'h264', videoProfile: 'high', pixelFormat: 'yuv420p', audioCodec: 'aac' },
  });
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-avoid_negative_ts') + 1], 'make_zero');
  assert.equal(args[args.indexOf('-hls_list_size') + 1], '12');
  assert.ok(!args.includes('-start_number'));
  assert.ok(!args.includes('-output_ts_offset'));
  assert.ok(!args.includes('-hls_playlist_type'));
});

test('transcode session key dedupes seeks but preserves media profile changes', () => {
  const base = transcodeSessionKey('/media/movie.mkv', {
    forceTranscode: true,
    startSeconds: 10,
    audioTrackIndex: 1,
    subtitleStyle: { fontSize: 42, position: 82 },
  });
  const seekOnly = transcodeSessionKey('/media/movie.mkv', {
    startSeconds: 900,
    audioTrackIndex: 1,
    subtitleStyle: { position: 82, fontSize: 42 },
  });
  const differentAudio = transcodeSessionKey('/media/movie.mkv', {
    startSeconds: 10,
    audioTrackIndex: 2,
    subtitleStyle: { fontSize: 42, position: 82 },
  });

  assert.equal(base, seekOnly);
  assert.notEqual(base, differentAudio);
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
  // Stream-copied audio cannot be filtered, so no resample filter is added.
  assert.equal(args.includes('-af'), false);
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

test('subtitle filter paths survive apostrophes and filter-special characters', () => {
  const args = buildHlsArgs({
    filePath: "/media/The Terror of Tal'Dorei [SEV].mkv",
    outputPath,
    options: {
      subtitleTrackIndex: 2,
      subtitleStreamOrdinal: 0,
      subtitleCodec: 'ass',
    },
    preset: 'software',
    mediaInfo: { videoCodec: 'hevc', audioCodec: 'eac3' },
  });

  const filter = args[args.indexOf('-vf') + 1] || '';
  const escaped = '\\'.repeat(3);
  assert.ok(filter.startsWith('subtitles=filename='));
  assert.ok(filter.includes(`Tal${escaped}'Dorei ${escaped}[SEV${escaped}].mkv\\:si=0`));
  assert.equal(filter.includes("subtitles='"), false);
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
