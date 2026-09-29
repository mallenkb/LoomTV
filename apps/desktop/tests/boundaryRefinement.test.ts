import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRefinedBoundary } from '../src/main/skipSegments/boundaryRefinement.ts';

test('equidistant boundaries prefer chapter over silence and keyframe', () => {
  const result = selectRefinedBoundary({ proposedMs: 60_000, mediaDurationMs: 1_800_000, inwardDirection: 1, points: [
    { kind: 'keyframe', timeMs: 61_000 }, { kind: 'silence', timeMs: 59_000 }, { kind: 'chapter', timeMs: 61_000 },
  ] });
  assert.deepEqual(result, { timeMs: 61_000, kind: 'chapter', originalMs: 60_000 });
});

test('inward and outward windows reject points beyond five and two seconds', () => {
  const result = selectRefinedBoundary({ proposedMs: 60_000, mediaDurationMs: 1_800_000, inwardDirection: 1, points: [
    { kind: 'chapter', timeMs: 53_000 }, { kind: 'silence', timeMs: 66_000 },
  ] });
  assert.equal(result.kind, 'original');
});

test('boundaries within two seconds snap to the media edge', () => {
  assert.equal(selectRefinedBoundary({ proposedMs: 1_500, mediaDurationMs: 100_000, inwardDirection: 1, points: [] }).timeMs, 0);
  assert.equal(selectRefinedBoundary({ proposedMs: 99_000, mediaDurationMs: 100_000, inwardDirection: -1, points: [] }).timeMs, 100_000);
});
