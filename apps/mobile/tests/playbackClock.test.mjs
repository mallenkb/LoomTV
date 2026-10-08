import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileAbsoluteMediaSeconds, mobilePlayerSecondsForAbsolute } from '../playbackClock.ts';

test('mobile direct play and full-VOD HLS keep one absolute clock', () => {
  assert.equal(mobileAbsoluteMediaSeconds(125), 125);
  assert.equal(mobilePlayerSecondsForAbsolute(240), 240);
});

test('HLS resume adds its source offset once for position, duration and recovery', async () => {
  assert.equal(mobilePlayerSecondsForAbsolute(600, 600), 0);
  assert.equal(mobileAbsoluteMediaSeconds(15, 600), 615);
  const { mobileMediaDurationSeconds } = await import('../playbackClock.ts');
  assert.equal(mobileMediaDurationSeconds(1200, 600), 1800);
  assert.equal(mobileMediaDurationSeconds(1200, 600, 1800), 1800);
  assert.equal(mobilePlayerSecondsForAbsolute(615, 600), 15);
  assert.equal(mobilePlayerSecondsForAbsolute(590, 600), 0);
  assert.equal(mobilePlayerSecondsForAbsolute(mobileAbsoluteMediaSeconds(15, 600), 600), 15);
});
