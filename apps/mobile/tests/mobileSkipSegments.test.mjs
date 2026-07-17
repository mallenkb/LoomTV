import assert from 'node:assert/strict';
import test from 'node:test';
import { activeKnownMediaSegmentAt, mobileMediaSegmentLabel } from '../mobileDomain.ts';

test('mobile playback ignores unknown segment types', () => {
  assert.equal(activeKnownMediaSegmentAt([{ id: 'x', type: 'commercial', startMs: 0, endMs: 60_000, confidence: 1, source: 'chapter', mediaDurationMs: 60_000, updatedAt: '' }], 10), null);
});

test('mobile segment labels use contextual credits and a safe fallback', () => {
  assert.equal(mobileMediaSegmentLabel('credits', true), 'Credits');
  assert.equal(mobileMediaSegmentLabel('credits', false), 'Outro');
  assert.equal(mobileMediaSegmentLabel('commercial', false), 'Skip');
});
