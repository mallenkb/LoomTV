import test from 'node:test';
import assert from 'node:assert/strict';
import { fillSliderGeometry } from '../src/components/ui/fillSliderGeometry.ts';

test('a 0-to-max slider fills from the left edge to the value', () => {
  assert.deepEqual(fillSliderGeometry(0.9, 0, 1), { valuePct: 90, fillLeft: 0, fillWidth: 90 });
  assert.deepEqual(fillSliderGeometry(1, 1, 3), { valuePct: 0, fillLeft: 0, fillWidth: 0 });
});

test('a range that crosses zero fills outward from zero', () => {
  assert.deepEqual(fillSliderGeometry(2.5, -5, 5), { valuePct: 75, fillLeft: 50, fillWidth: 25 });
  assert.deepEqual(fillSliderGeometry(-5, -5, 5), { valuePct: 0, fillLeft: 0, fillWidth: 50 });
  assert.deepEqual(fillSliderGeometry(0, -10, 10), { valuePct: 50, fillLeft: 50, fillWidth: 0 });
});

test('out-of-range and invalid values stay inside the bar', () => {
  assert.equal(fillSliderGeometry(140, 0, 100).valuePct, 100);
  assert.equal(fillSliderGeometry(-3, 0, 100).valuePct, 0);
  assert.equal(fillSliderGeometry(Number.NaN, 0, 100).valuePct, 0);
  assert.equal(fillSliderGeometry(5, 5, 5).valuePct, 0, 'an empty range does not divide by zero');
});
