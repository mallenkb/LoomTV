import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { meetsMinimumMacOS, mpvColor, mpvFlag, normalizeMpvTracks } from '../src/main/mpvPlaybackHelpers.ts';

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

test('libmpv loads only on macOS versions its bundle supports', () => {
  assert.equal(meetsMinimumMacOS('26.0.0', '26.0'), true);
  assert.equal(meetsMinimumMacOS('26.1', '26.0'), true);
  assert.equal(meetsMinimumMacOS('27.2.1', '26.0'), true);
  assert.equal(meetsMinimumMacOS('15.7.3', '26.0'), false);
  assert.equal(meetsMinimumMacOS('12.0', '26.0'), false);
  assert.equal(meetsMinimumMacOS('15.7', null), true);
});

test('mpv flags reported as 1/0 by the bridge still mark the selected track', () => {
  // Bridges built before the @YES/@NO fix serialize flags as numbers.
  const tracks = normalizeMpvTracks([
    { id: 1, type: 'video', selected: 1, default: 1, forced: 0, external: 0 },
    { id: 2, type: 'audio', selected: 0, default: 0 },
  ], new Map());
  assert.equal(tracks[0].selected, true);
  assert.equal(tracks[0].default, true);
  assert.equal(tracks[0].forced, false);
  assert.equal(tracks[1].selected, false);
  assert.equal(mpvFlag(true), true);
  assert.equal(mpvFlag(1), true);
  assert.equal(mpvFlag(0), false);
  assert.equal(mpvFlag('yes'), false);
});
