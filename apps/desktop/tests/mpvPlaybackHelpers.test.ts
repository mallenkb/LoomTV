import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { mpvColor, normalizeMpvTracks } from '../src/main/mpvPlaybackHelpers.ts';

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

test('subtitle colors are converted to the #AARRGGBB form mpv accepts', () => {
  assert.equal(mpvColor('#ffffff'), '#ffffffff');
  assert.equal(mpvColor('#FFF'), '#ffffffff');
  assert.equal(mpvColor('transparent'), '#00000000');
  // CSS puts alpha last; mpv expects it first.
  assert.equal(mpvColor('#000000cc'), '#cc000000');
  assert.equal(mpvColor('rgba(0, 0, 0, 0.5)'), '#80000000');
  assert.equal(mpvColor('rgb(255 128 0 / 50%)'), '#80ff8000');
  assert.equal(mpvColor('rgb(255, 255, 255)'), '#ffffffff');
  assert.equal(mpvColor('white'), null);
  assert.equal(mpvColor('rgba(0, 0, 0, nope)'), null);
});
