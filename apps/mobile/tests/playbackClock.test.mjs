import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mobileAbsoluteMediaSeconds,
  mobileAccessibleSeekRange,
  mobileAccessibleSeekTarget,
  mobileAccessibleTimeLabel,
  mobilePlayerSecondsForAbsolute,
} from '../playbackClock.ts';

test('mobile direct play and full-VOD HLS keep one absolute clock', () => {
  assert.equal(mobileAbsoluteMediaSeconds(125), 125);
  assert.equal(mobilePlayerSecondsForAbsolute(240), 240);
});

test('mobile seek accessibility range clamps and reports remaining time', () => {
  assert.deepEqual(mobileAccessibleSeekRange(65.6, 120.2), {
    min: 0,
    max: 120,
    now: 66,
    remaining: 54,
  });
  assert.deepEqual(mobileAccessibleSeekRange(-10, 120), {
    min: 0,
    max: 120,
    now: 0,
    remaining: 120,
  });
  assert.deepEqual(mobileAccessibleSeekRange(150, 120), {
    min: 0,
    max: 120,
    now: 120,
    remaining: 0,
  });
  assert.deepEqual(mobileAccessibleSeekRange(Number.NaN, Number.POSITIVE_INFINITY), {
    min: 0,
    max: 0,
    now: 0,
    remaining: 0,
  });
});

test('mobile seek accessibility time uses spoken elapsed and remaining units', () => {
  assert.equal(mobileAccessibleTimeLabel(0), '0 seconds');
  assert.equal(mobileAccessibleTimeLabel(65), '1 minute, 5 seconds');
  assert.equal(mobileAccessibleTimeLabel(3661), '1 hour, 1 minute, 1 second');
});

test('mobile seek accessibility actions move ten seconds within media bounds', () => {
  assert.equal(mobileAccessibleSeekTarget(42.5, 120, 'increment'), 52.5);
  assert.equal(mobileAccessibleSeekTarget(42.5, 120, 'decrement'), 32.5);
  assert.equal(mobileAccessibleSeekTarget(115, 120, 'increment'), 120);
  assert.equal(mobileAccessibleSeekTarget(5, 120, 'decrement'), 0);
});
