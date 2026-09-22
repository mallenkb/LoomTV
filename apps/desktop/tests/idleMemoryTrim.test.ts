import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIdleMemoryTrimmer,
  HIDDEN_TRIM_DELAY_MS,
  IDLE_TRIM_AFTER_SECONDS,
  type IdleTrimReason,
} from '../src/main/idleMemoryTrim.ts';

function harness() {
  const state = { idle: 0, playing: false, visible: true };
  const trims: IdleTrimReason[] = [];
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const trimmer = createIdleMemoryTrimmer({
    idleSeconds: () => state.idle,
    isPlaybackActive: () => state.playing,
    isWindowVisible: () => state.visible,
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

test('nothing is trimmed while a player is open or media plays', () => {
  const { state, trims, trimmer, fire } = harness();
  state.playing = true;
  state.idle = IDLE_TRIM_AFTER_SECONDS * 2;
  trimmer.poll();
  state.visible = false;
  trimmer.windowHidden();
  fire();
  assert.deepEqual(trims, []);

  // Playback ending while still idle trims on the next poll.
  state.playing = false;
  trimmer.poll();
  assert.deepEqual(trims, ['idle']);
});

test('a hidden window trims after the delay unless it comes back first', () => {
  const { state, trims, timers, trimmer, fire } = harness();
  state.visible = false;
  trimmer.windowHidden();
  trimmer.windowHidden();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, HIDDEN_TRIM_DELAY_MS);

  state.visible = true;
  trimmer.windowShown();
  fire();
  assert.deepEqual(trims, []);

  state.visible = false;
  trimmer.windowHidden();
  fire();
  assert.deepEqual(trims, ['hidden']);
});
