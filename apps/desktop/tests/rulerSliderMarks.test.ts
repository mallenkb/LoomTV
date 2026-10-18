import test from 'node:test';
import assert from 'node:assert/strict';
import { snapToMark } from '../src/components/ui/rulerSliderMarks.ts';

test('a drag near a mark lands on it', () => {
  assert.equal(snapToMark(9, [4, 8, 14], 0, 40), 8);
  assert.equal(snapToMark(0.2, [0], -5, 5), 0);
});

test('values away from every mark are left alone', () => {
  assert.equal(snapToMark(11, [4, 8, 14], 0, 40), 11);
  assert.equal(snapToMark(1, [0], -5, 5), 1);
});

test('the closest mark wins and an empty range never snaps', () => {
  assert.equal(snapToMark(5.9, [5, 6.5], 0, 40), 6.5);
  assert.equal(snapToMark(3, [3.1], 3, 3), 3);
});
