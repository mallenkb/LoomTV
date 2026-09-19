import assert from 'node:assert/strict';
import test from 'node:test';
import { absoluteMediaSeconds, playerSecondsForAbsolute, subtitleCueSeconds, subtitleMediaSeconds } from '../src/components/VideoPlayer/playbackClock.ts';
import { activeSubtitleText } from '../src/components/VideoPlayer/subtitleCues.ts';
import {
  activeSkipSegmentAt,
  shouldShowSkipPrompt,
  skipPromptLabel,
} from '../src/components/VideoPlayer/skipPrompt.ts';

test('positive subtitle delay shows cues later than media time', () => {
  assert.equal(subtitleCueSeconds(10, 1.25), 8.75);
  assert.equal(subtitleCueSeconds(10, -0.5), 10.5);
  assert.equal(subtitleCueSeconds(10, Number.NaN), 10);
  const cues = [{ start: 10, end: 12, text: 'Hello' }];
  assert.equal(activeSubtitleText(cues, subtitleCueSeconds(10, 1)), '');
  assert.equal(activeSubtitleText(cues, subtitleCueSeconds(11, 1)), 'Hello');
});

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

test('outro and credits retain distinct labels', () => {
  assert.equal(skipPromptLabel('outro', true), 'Outro');
  assert.equal(skipPromptLabel('credits', false), 'Credits');
});

test('subtitle clock adds the resume offset only for linear browser transcodes', () => {
  assert.equal(subtitleMediaSeconds(15, undefined, 600, false), 615);
  assert.equal(subtitleMediaSeconds(0, undefined, 900, false), 900);
  assert.equal(subtitleMediaSeconds(615, undefined, 600, true), 615);
  assert.equal(subtitleMediaSeconds(615), 615);
  assert.equal(subtitleMediaSeconds(615, undefined, undefined, false), 615);
});

test('subtitle clock prefers finite native time including zero without applying browser offsets', () => {
  assert.equal(subtitleMediaSeconds(15, 615, 600, false), 615);
  assert.equal(subtitleMediaSeconds(15, 0, 600, false), 0);
  assert.equal(subtitleMediaSeconds(15, 615, 600, true), 615);
  assert.equal(subtitleMediaSeconds(15, NaN, 600, false), 615);
  assert.equal(subtitleMediaSeconds(615, Infinity, 600, true), 615);
});
