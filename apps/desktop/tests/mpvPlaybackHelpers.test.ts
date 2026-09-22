import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { normalizeMpvTracks } from '../src/main/mpvPlaybackHelpers.ts';

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
