import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  isLikelyNaturalMpvEof,
  normalizeMpvTracks,
  unexpectedMpvExitMessage,
} from '../src/main/mpvPlaybackHelpers.ts';

test('mpv tracks normalize embedded and authorized external subtitles', () => {
  const externalPath = path.resolve('/tmp/loomtv-example.en.srt');
  const tracks = normalizeMpvTracks([
    { id: 1, type: 'video', codec: 'hevc', selected: true },
    { id: 2, type: 'audio', codec: 'aac', lang: 'eng', 'demux-channel-count': 6 },
    { id: 3, type: 'sub', codec: 'subrip', external: true, 'external-filename': externalPath },
    { id: 'invalid', type: 'sub' },
  ], new Map([[externalPath, 'opensubtitles']]));

  assert.deepEqual(tracks, [
    {
      id: 1,
      type: 'video',
      codec: 'hevc',
      language: undefined,
      title: undefined,
      channels: undefined,
      default: false,
      forced: false,
      selected: true,
      external: false,
      source: 'embedded',
    },
    {
      id: 2,
      type: 'audio',
      codec: 'aac',
      language: 'eng',
      title: undefined,
      channels: 6,
      default: false,
      forced: false,
      selected: false,
      external: false,
      source: 'embedded',
    },
    {
      id: 3,
      type: 'subtitle',
      codec: 'subrip',
      language: undefined,
      title: undefined,
      channels: undefined,
      default: false,
      forced: false,
      selected: false,
      external: true,
      source: 'opensubtitles',
    },
  ]);
});

test('a clean mpv close is inferred as EOF only near the known duration', () => {
  assert.equal(isLikelyNaturalMpvEof({ code: 0, position: 99, duration: 100 }), true);
  assert.equal(isLikelyNaturalMpvEof({ code: 0, position: 50, duration: 100 }), false);
  assert.equal(isLikelyNaturalMpvEof({ code: 1, position: 100, duration: 100 }), false);
  assert.equal(isLikelyNaturalMpvEof({ code: 0, position: 100 }), false);
});

test('unexpected mpv exits retain actionable process diagnostics', () => {
  assert.equal(
    unexpectedMpvExitMessage({ code: 2, signal: null, stderr: 'decoder initialization failed' }),
    'mpv exited unexpectedly (code 2): decoder initialization failed',
  );
  assert.equal(
    unexpectedMpvExitMessage({ code: null, signal: 'SIGTERM' }),
    'mpv exited unexpectedly (signal SIGTERM).',
  );
});
