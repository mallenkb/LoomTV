import assert from 'node:assert/strict';
import test from 'node:test';

import { LIBVLC_INSTANCE_ARGUMENTS } from '../src/main/libvlcRuntimeConfig.ts';
import {
  captureLibVlcTrackSelection,
  restoreLibVlcTrackSelection,
} from '../src/main/libvlcSessionState.ts';

test('all LibVLC instance paths bypass a stale plugin cache', () => {
  assert.deepEqual(LIBVLC_INSTANCE_ARGUMENTS, ['--no-plugins-cache', '--quiet']);
});

test('fullscreen re-arm captures and restores video, audio, and subtitle tracks', () => {
  const selected = { video: 3, audio: 7, subtitle: 11 };
  const captured = captureLibVlcTrackSelection({
    video: { get: () => selected.video },
    audio: { get: () => selected.audio },
    subtitle: { get: () => selected.subtitle },
  });

  selected.video = 1;
  selected.audio = 2;
  selected.subtitle = -1;
  const restored = restoreLibVlcTrackSelection(captured, {
    video: { get: () => selected.video, set: (trackId) => { selected.video = trackId; return 0; } },
    audio: { get: () => selected.audio, set: (trackId) => { selected.audio = trackId; return 0; } },
    subtitle: { get: () => selected.subtitle, set: (trackId) => { selected.subtitle = trackId; return 0; } },
  });

  assert.equal(restored, true);
  assert.deepEqual(selected, { video: 3, audio: 7, subtitle: 11 });
});

test('fullscreen re-arm preserves an explicitly disabled subtitle track', () => {
  const captured = captureLibVlcTrackSelection({
    subtitle: { get: () => -1 },
  });
  let selectedSubtitle = 8;
  assert.equal(restoreLibVlcTrackSelection(captured, {
    subtitle: {
      get: () => selectedSubtitle,
      set: (trackId) => { selectedSubtitle = trackId; return 0; },
    },
  }), true);
  assert.equal(selectedSubtitle, -1);
});

test('fullscreen re-arm reports a rejected native track change for retry', () => {
  assert.equal(restoreLibVlcTrackSelection({ audio: 7 }, {
    audio: { get: () => 2, set: () => -1 },
  }), false);
});
