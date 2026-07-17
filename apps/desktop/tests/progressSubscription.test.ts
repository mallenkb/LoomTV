import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProgressRefreshSubscription,
  type ProgressRefreshEventTarget,
} from '../src/lib/progressSubscription.ts';

class FakeEventTarget {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  addCalls = 0;
  removeCalls = 0;

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.addCalls += 1;
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.removeCalls += 1;
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener(new Event(type)));
  }
}

test('progress refresh subscribers share one timer and one set of window listeners', () => {
  const eventTarget = new FakeEventTarget();
  let refreshes = 0;
  let firstUpdates = 0;
  let secondUpdates = 0;
  let intervalCallback: (() => void) | undefined;
  let intervalDelay = 0;
  const clearedTimers: number[] = [];

  const subscription = createProgressRefreshSubscription({
    eventTarget: eventTarget as unknown as ProgressRefreshEventTarget,
    onRefresh: () => {
      refreshes += 1;
    },
    setInterval: (callback, delayMs) => {
      intervalCallback = callback;
      intervalDelay = delayMs;
      return 41;
    },
    clearInterval: (timerId) => {
      clearedTimers.push(timerId);
    },
  });

  const unsubscribeFirst = subscription.subscribe(() => {
    firstUpdates += 1;
  });
  const unsubscribeSecond = subscription.subscribe(() => {
    secondUpdates += 1;
  });

  assert.equal(eventTarget.addCalls, 3);
  assert.equal(intervalDelay, 2000);

  eventTarget.dispatch('focus');
  intervalCallback?.();
  assert.deepEqual([refreshes, firstUpdates, secondUpdates], [2, 2, 2]);

  unsubscribeFirst();
  assert.equal(eventTarget.removeCalls, 0);
  assert.deepEqual(clearedTimers, []);

  unsubscribeSecond();
  assert.equal(eventTarget.removeCalls, 3);
  assert.deepEqual(clearedTimers, [41]);
});

test('progress refresh event filtering prevents duplicate internal publications', () => {
  const eventTarget = new FakeEventTarget();
  let allowEventRefresh = false;
  let refreshes = 0;
  let updates = 0;

  const subscription = createProgressRefreshSubscription({
    eventTarget: eventTarget as unknown as ProgressRefreshEventTarget,
    onRefresh: () => {
      refreshes += 1;
    },
    setInterval: () => 9,
    clearInterval: () => undefined,
    shouldRefreshEvent: () => allowEventRefresh,
  });
  const unsubscribe = subscription.subscribe(() => {
    updates += 1;
  });

  subscription.publish();
  eventTarget.dispatch('loomtv-progress');
  assert.deepEqual([refreshes, updates], [1, 1]);

  allowEventRefresh = true;
  eventTarget.dispatch('loomtv-progress');
  assert.deepEqual([refreshes, updates], [2, 2]);
  unsubscribe();
});
