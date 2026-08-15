import assert from 'node:assert/strict';
import test from 'node:test';

import { libVlcPlatformBinding, libVlcPlatformVariants } from '../src/main/libvlcPlatform.ts';

test('recognizes the canonical Windows bundled-runtime layout', () => {
  assert.deepEqual(libVlcPlatformVariants('win32'), ['win32', 'win', 'windows']);
});

test('uses the Windows HWND LibVLC surface and Direct3D vout', () => {
  assert.deepEqual(libVlcPlatformBinding('win32'), {
    drawableSymbol: 'libvlc_media_player_set_hwnd',
    mediaVoutOption: ':vout=direct3d11',
    host: 'windows-child',
  });
});

test('keeps the existing macOS NSView surface contract', () => {
  assert.deepEqual(libVlcPlatformBinding('darwin'), {
    drawableSymbol: 'libvlc_media_player_set_nsobject',
    mediaVoutOption: ':vout=macosx',
    host: 'macos-child',
  });
});

test('does not advertise an unimplemented Linux LibVLC surface', () => {
  assert.equal(libVlcPlatformBinding('linux'), null);
});
