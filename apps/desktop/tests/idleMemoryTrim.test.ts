import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIdleMemoryTrimmer,
  HIDDEN_TRIM_DELAY_MS,
  IDLE_TRIM_AFTER_SECONDS,
  PLAYBACK_TRIM_DELAY_MS,
  type IdleTrimReason,
} from '../src/main/idleMemoryTrim.ts';

function harness() {
  const state = { idle: 0, playing: false, playerOpen: false, active: true };
  const trims: IdleTrimReason[] = [];
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const trimmer = createIdleMemoryTrimmer({
    idleSeconds: () => state.idle,
    isPlaybackActive: () => state.playing,
    isPlayerOpen: () => state.playerOpen,
    isWindowActive: () => state.active,
    trim: (reason) => trims.push(reason),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
  });
  const fire = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
  };
  return { state, trims, timers, trimmer, fire };
}

test('idle trims once per stretch of inactivity and again after new input', () => {
  const { state, trims, trimmer } = harness();
  state.idle = IDLE_TRIM_AFTER_SECONDS - 1;
  trimmer.poll();
  assert.deepEqual(trims, []);

  state.idle = IDLE_TRIM_AFTER_SECONDS;
  trimmer.poll();
  trimmer.poll();
  assert.deepEqual(trims, ['idle']);

  state.idle = 3;
  trimmer.poll();
  state.idle = IDLE_TRIM_AFTER_SECONDS + 60;
  trimmer.poll();
  assert.deepEqual(trims, ['idle', 'idle']);
});

test('idle and inactive-window trims wait while media plays', () => {
  const { state, trims, trimmer, fire } = harness();
  state.playing = true;
  state.idle = IDLE_TRIM_AFTER_SECONDS * 2;
  trimmer.poll();
  state.active = false;
  trimmer.windowInactive();
  fire();
  assert.deepEqual(trims, []);

  // Playback ending while still idle trims on the next poll.
  state.playing = false;
  trimmer.poll();
  assert.deepEqual(trims, ['idle']);
});

test('an inactive window trims after the delay unless it becomes active first', () => {
  const { state, trims, timers, trimmer, fire } = harness();
  state.active = false;
  trimmer.windowInactive();
  trimmer.windowInactive();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, HIDDEN_TRIM_DELAY_MS);

  state.active = true;
  trimmer.windowActive();
  fire();
  assert.deepEqual(trims, []);

  state.active = false;
  trimmer.windowInactive();
  fire();
  assert.deepEqual(trims, ['hidden']);
});

test('opening a player schedules one playback trim that closing cancels', () => {
  const { state, trims, timers, trimmer, fire } = harness();
  state.playerOpen = true;
  state.playing = true;
  trimmer.playbackChanged();
  trimmer.playbackChanged();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, PLAYBACK_TRIM_DELAY_MS);

  // Closing the player before the delay cancels the pending trim.
  state.playerOpen = false;
  state.playing = false;
  trimmer.playbackChanged();
  fire();
  assert.deepEqual(trims, []);

  // A player that stays open receives the playback trim even while playing.
  state.playerOpen = true;
  state.playing = true;
  trimmer.playbackChanged();
  fire();
  assert.deepEqual(trims, ['playback']);
});

test('closing a player in an inactive window schedules the hidden trim', () => {
  const { state, trims, timers, trimmer, fire } = harness();
  state.playerOpen = true;
  trimmer.playbackChanged();
  timers.splice(0);

  state.playerOpen = false;
  state.active = false;
  trimmer.playbackChanged();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, HIDDEN_TRIM_DELAY_MS);
  fire();
  assert.deepEqual(trims, ['hidden']);
});

test('dispose cancels pending trims', () => {
  const { state, trims, trimmer, fire } = harness();
  state.playerOpen = true;
  trimmer.playbackChanged();
  state.active = false;
  trimmer.windowInactive();
  trimmer.dispose();
  fire();
  trimmer.poll();
  assert.deepEqual(trims, []);
});
