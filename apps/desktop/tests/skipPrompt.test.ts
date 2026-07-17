import test from 'node:test';
import assert from 'node:assert/strict';
import { activeSkipSegmentAt, skipPromptLabel } from '../src/components/VideoPlayer/skipPrompt.ts';

test('unknown client segment types are ignored and labels have a safe fallback', () => {
  const segment = activeSkipSegmentAt([{ type: 'commercial', startMs: 0, endMs: 60_000, mediaDurationMs: 60_000 }], 10);
  assert.equal(segment, null);
  assert.equal(skipPromptLabel('commercial', true), 'Skip');
});

test('known contextual labels remain stable', () => {
  assert.equal(skipPromptLabel('credits', true), 'Outro');
  assert.equal(skipPromptLabel('credits', false), 'Credits');
  assert.equal(skipPromptLabel('preview', true), 'Preview');
});
