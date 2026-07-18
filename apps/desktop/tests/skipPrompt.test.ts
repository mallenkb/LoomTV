import test from 'node:test';
import assert from 'node:assert/strict';
import { activeSkipSegmentAt, skipPromptLabel } from '../src/components/VideoPlayer/skipPrompt.ts';

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
