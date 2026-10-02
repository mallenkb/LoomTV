import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreOffscreenTrack } from '../src/main/offscreenVideoRestore.ts';

test('failed video selection and frame decoding retain the track for later polls', () => {
  let pending: number | null = 3;
  const selected: number[] = [];
  const select = (id: number) => { selected.push(id); return true; };
  pending = restoreOffscreenTrack(pending, () => false, () => { throw new Error('must not seek after rejected selection'); });
  assert.equal(pending, 3);
  pending = restoreOffscreenTrack(pending, select, () => false);
  assert.equal(pending, 3);
  assert.throws(() => { pending = restoreOffscreenTrack(pending, select, () => { throw new Error('decoder unavailable'); }); }, /decoder unavailable/);
  assert.equal(pending, 3);
  pending = restoreOffscreenTrack(pending, select, () => true);
  assert.equal(pending, null);
  restoreOffscreenTrack(pending, () => { throw new Error('already restored'); }, () => false);
  assert.deepEqual(selected, [3, 3, 3]);
});
