import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nativeAttemptsForSource,
  nativeStartOptionsForAttempt,
} from '../src/components/VideoPlayer/nativeFallbackPolicy.ts';

test('local files exhaust verified hardware, then software, before the browser path', () => {
  assert.deepEqual(nativeAttemptsForSource('local'), [
    { engine: 'libvlc', decodeMode: 'hardware' },
    { engine: 'mpv', decodeMode: 'hardware' },
    { engine: 'mpv', decodeMode: 'software' },
    { engine: 'libvlc', decodeMode: 'software' },
  ]);
  assert.deepEqual(nativeAttemptsForSource('iptv'), [{ engine: 'libvlc' }]);
  assert.deepEqual(nativeAttemptsForSource('other'), []);
});

test('each decoder attempt receives the same playback handoff state', () => {
  const state = {
    startSeconds: 123.5,
    paused: true,
    volume: 0.35,
    muted: true,
    speed: 1.25,
    audioLanguage: 'ja',
    audioDelay: 0.4,
    subtitleDelay: -0.2,
    subtitleFiles: [{ path: '/video/subtitles.srt', source: 'sidecar' as const }],
    nativeSubtitles: true,
  };
  for (const attempt of nativeAttemptsForSource('local')) {
    assert.deepEqual(nativeStartOptionsForAttempt(attempt, state), {
      ...state,
      decodeMode: attempt.decodeMode,
    });
  }
});
