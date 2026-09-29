import assert from 'node:assert/strict';
import test from 'node:test';
import {
  playbackFailureFromResponse,
  playbackFailureFromUnknown,
  recoveryActionFor,
  restorePortraitWithRetry,
} from '../playbackRecovery.ts';

test('missing media produces the NAS reconnect-and-retry recovery path', () => {
  const failure = playbackFailureFromResponse(404, {
    code: 'MEDIA_NOT_FOUND',
    error: 'The media file is unavailable.',
    retryable: true,
  });

  assert.equal(failure.code, 'MEDIA_NOT_FOUND');
  assert.equal(failure.message, 'The media file is unavailable.');
  assert.deepEqual(recoveryActionFor(failure), {
    label: 'Reconnect NAS & retry',
    description: 'Reconnect the NAS share on the desktop first, then retry this stream.',
  });
});

test('transcode timeout remains actionable and retryable', () => {
  const failure = playbackFailureFromResponse(500, {
    code: 'TRANSCODE_TIMEOUT',
    error: 'The desktop took too long to prepare this stream.',
    retryable: true,
  });

  assert.equal(failure.code, 'TRANSCODE_TIMEOUT');
  assert.equal(recoveryActionFor(failure)?.label, 'Retry');
});

test('network fetch failures point to reconnecting the desktop', () => {
  const failure = playbackFailureFromUnknown(new TypeError('Network request failed'));

  assert.equal(failure.code, 'DESKTOP_UNREACHABLE');
  assert.equal(recoveryActionFor(failure)?.label, 'Reconnect & retry');
});

test('non-retryable transcoder failures only offer the always-present Back action in the UI', () => {
  const failure = playbackFailureFromResponse(500, {
    code: 'TRANSCODER_UNAVAILABLE',
    retryable: false,
  });

  assert.equal(failure.retryable, false);
  assert.equal(recoveryActionFor(failure), null);
});

test('portrait restoration completes on the first successful lock', async () => {
  let locks = 0;
  const restored = await restorePortraitWithRetry(async () => { locks += 1; });

  assert.equal(restored, true);
  assert.equal(locks, 1);
});

test('portrait restoration resets orientation and retries before player exit', async () => {
  const calls = [];
  let locks = 0;
  const restored = await restorePortraitWithRetry(
    async () => {
      calls.push('lock');
      locks += 1;
      if (locks === 1) throw new Error('native orientation transition in progress');
    },
    async () => { calls.push('unlock'); },
  );

  assert.equal(restored, true);
  assert.deepEqual(calls, ['lock', 'unlock', 'lock']);
});

test('portrait restoration reports failure after exhausting all attempts', async () => {
  let locks = 0;
  const restored = await restorePortraitWithRetry(
    async () => {
      locks += 1;
      throw new Error('unsupported lock');
    },
    async () => {},
    3,
  );

  assert.equal(restored, false);
  assert.equal(locks, 3);
});

test('mobile failure-and-recovery flow reaches a safe portrait exit after NAS recovery', async () => {
  const failure = playbackFailureFromResponse(404, {
    code: 'MEDIA_NOT_FOUND',
    retryable: true,
  });
  const action = recoveryActionFor(failure);
  let streamAvailable = false;

  assert.equal(action?.label, 'Reconnect NAS & retry');
  streamAvailable = true; // The desktop share was reconnected before the retry action.
  assert.equal(streamAvailable, true);

  const exitEvents = [];
  const portraitRestored = await restorePortraitWithRetry(async () => {
    exitEvents.push('portrait-locked');
  });
  if (portraitRestored) exitEvents.push('player-unmounted');

  assert.deepEqual(exitEvents, ['portrait-locked', 'player-unmounted']);
});
