import test from 'node:test';
import assert from 'node:assert/strict';
import { activeSkipSegmentAt, buildSkipAction, pinVisibleTarget, skipPromptLabel } from '../src/components/VideoPlayer/skipPrompt.ts';

test('unknown client segment types are ignored and labels have a safe fallback', () => {
  const segment = activeSkipSegmentAt([{ type: 'commercial', startMs: 0, endMs: 60_000, mediaDurationMs: 60_000 }], 10);
  assert.equal(segment, null);
  assert.equal(skipPromptLabel('commercial', true), 'Skip');
});

test('known contextual labels remain stable', () => {
  assert.equal(skipPromptLabel('outro', true), 'Outro');
  assert.equal(skipPromptLabel('credits', false), 'Credits');
  assert.equal(skipPromptLabel('preview', true), 'Preview');
});

test('an overlapping ending takes prompt precedence over a broader credits range', () => {
  const credits = { type: 'credits' as const, startMs: 1_425_000, endMs: 1_560_000, mediaDurationMs: 1_560_000 };
  const outro = { type: 'outro' as const, startMs: 1_430_000, endMs: 1_500_000, mediaDurationMs: 1_560_000 };
  const preview = { type: 'preview' as const, startMs: 1_520_000, endMs: 1_550_000, mediaDurationMs: 1_560_000 };
  assert.equal(activeSkipSegmentAt([credits, outro, preview], 1_450)?.type, 'outro');
  assert.equal(activeSkipSegmentAt([credits, outro, preview], 1_510)?.type, 'credits');
  assert.equal(activeSkipSegmentAt([credits, outro, preview], 1_530)?.type, 'preview');
});

test('position outside interval returns null', () => {
  const segment = { startMs: 10_000, endMs: 20_000 as number | null, mediaDurationMs: 100_000 };
  assert.equal(buildSkipAction(segment, 5_000), null);
  assert.equal(buildSkipAction(segment, 25_000), null);
});

test('position at end boundary returns null', () => {
  const segment = { startMs: 10_000, endMs: 20_000 as number | null, mediaDurationMs: 100_000 };
  assert.equal(buildSkipAction(segment, 20_000), null);
});

test('null endMs targets media duration minus pre-roll', () => {
  assert.equal(buildSkipAction({ startMs: 0, endMs: null, mediaDurationMs: 10_000 }, 1_000), 9_500);
  assert.equal(buildSkipAction({ startMs: 0, endMs: null, mediaDurationMs: 10_000 }, 1_000, 1_000), 9_000);
});

test('target equal to duration is refused', () => {
  assert.equal(buildSkipAction({ startMs: 0, endMs: 10_000, mediaDurationMs: 10_000 }, 1_000), null);
});

test('target within 250 ms of position is refused', () => {
  const segment = { startMs: 0, endMs: 5_000 as number | null, mediaDurationMs: 10_000 };
  assert.equal(buildSkipAction(segment, 4_900), null);
  assert.equal(buildSkipAction(segment, 4_750), null);
  assert.equal(buildSkipAction(segment, 4_000), 5_000);
});

test('zero and infinite durations are refused', () => {
  assert.equal(buildSkipAction({ startMs: 0, endMs: 5_000, mediaDurationMs: 0 }, 1_000), null);
  assert.equal(buildSkipAction({ startMs: 0, endMs: 5_000, mediaDurationMs: Number.POSITIVE_INFINITY }, 1_000), null);
});

test('reversed interval is refused', () => {
  assert.equal(buildSkipAction({ startMs: 20_000, endMs: 10_000, mediaDurationMs: 100_000 }, 15_000), null);
});

test('pinVisibleTarget keeps old target for same id and adopts fresh target on id change', () => {
  assert.equal(pinVisibleTarget('a', 9_000, 'a', 9_500), 9_000);
  assert.equal(pinVisibleTarget('a', 9_000, 'b', 9_500), 9_500);
  assert.equal(pinVisibleTarget(null, null, 'b', 9_500), 9_500);
});
