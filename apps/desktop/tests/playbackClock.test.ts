import assert from 'node:assert/strict';
import test from 'node:test';
import { absoluteMediaSeconds, playerSecondsForAbsolute } from '../src/components/VideoPlayer/playbackClock.ts';
import {
  activeSkipSegmentAt,
  shouldShowSkipPrompt,
  skipPromptLabel,
} from '../src/components/VideoPlayer/skipPrompt.ts';

test('direct, remux, and seekable HLS use the absolute timeline', () => {
  for (const mode of ['direct', 'remux', 'hls'] as const) {
    void mode;
    assert.equal(absoluteMediaSeconds(125, { mode: 'absolute', offsetSeconds: 90 }), 125);
    assert.equal(playerSecondsForAbsolute(240, { mode: 'absolute', offsetSeconds: 90 }), 240);
  }
});

test('linear offset transcodes map both player position and seeks', () => {
  const clock = { mode: 'offset' as const, offsetSeconds: 600 };
  assert.equal(absoluteMediaSeconds(15, clock), 615);
  assert.equal(playerSecondsForAbsolute(660, clock), 60);
  assert.equal(playerSecondsForAbsolute(500, clock), 0);
});

test('skip prompt follows marker timing without depending on transient player state', () => {
  const intro = {
    type: 'intro' as const,
    startMs: 81_000,
    endMs: 147_000,
    mediaDurationMs: 1_476_000,
  };

  assert.equal(activeSkipSegmentAt([intro], 80.999), null);
  assert.equal(activeSkipSegmentAt([intro], 100), intro);
  assert.equal(shouldShowSkipPrompt(intro, false), true);
  assert.equal(shouldShowSkipPrompt(intro, true), false);
  assert.equal(activeSkipSegmentAt([intro], 147), null);
});

test('credits are labeled as an outro for episodes and credits for movies', () => {
  assert.equal(skipPromptLabel('credits', true), 'Outro');
  assert.equal(skipPromptLabel('credits', false), 'Credits');
});
