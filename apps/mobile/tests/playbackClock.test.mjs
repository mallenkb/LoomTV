import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileAbsoluteMediaSeconds, mobilePlayerSecondsForAbsolute } from '../playbackClock.ts';

test('mobile direct play and full-VOD HLS keep one absolute clock', () => {
  assert.equal(mobileAbsoluteMediaSeconds(125), 125);
  assert.equal(mobilePlayerSecondsForAbsolute(240), 240);
});
