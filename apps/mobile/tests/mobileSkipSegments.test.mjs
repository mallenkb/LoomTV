import assert from 'node:assert/strict';
import test from 'node:test';
import { activeKnownMediaSegmentAt, mobileMediaSegmentLabel } from '../mobileDomain.ts';

test('mobile playback ignores unknown segment types', () => {
  assert.equal(activeKnownMediaSegmentAt([{ id: 'x', type: 'commercial', startMs: 0, endMs: 60_000, confidence: 1, source: 'chapter', mediaDurationMs: 60_000, updatedAt: '' }], 10), null);
});

test('mobile playback exposes preview markers separately from credits', () => {
  const common = { id: 'x', confidence: 1, source: 'theintrodb', mediaDurationMs: 1_560_000, updatedAt: '' };
  const credits = { ...common, type: 'credits', startMs: 1_500_000, endMs: 1_560_000 };
  const preview = { ...common, id: 'y', type: 'preview', startMs: 1_520_000, endMs: 1_550_000 };
  assert.equal(activeKnownMediaSegmentAt([credits, preview], 1_530)?.type, 'preview');
});

test('mobile segment labels use contextual credits and a safe fallback', () => {
  assert.equal(mobileMediaSegmentLabel('credits', true), 'Credits');
  assert.equal(mobileMediaSegmentLabel('outro', false), 'Outro');
  assert.equal(mobileMediaSegmentLabel('credits', false), 'Credits');
  assert.equal(mobileMediaSegmentLabel('commercial', false), 'Skip');
});
