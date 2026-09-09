import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUpdateAdapter,
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  type UpdateAdapterState,
} from '../src/main/updateAdapter.ts';

function createState(status: UpdateAdapterState['status']): UpdateAdapterState {
  return {
    status,
    supported: true,
  };
}

test('update adapter starts automatic checks after the startup delay and on the interval', () => {
  const scheduledTimeouts: Array<() => void> = [];
  const scheduledIntervals: Array<() => void> = [];
  let checks = 0;

  const adapter = createUpdateAdapter({
    startupDelayMs: 10,
    checkIntervalMs: 20,
    getState: () => createState('idle'),
    configure: () => undefined,
    checkForUpdates: async () => {
      checks += 1;
      return createState('not-available');
    },
    setTimeout: (callback) => {
      scheduledTimeouts.push(callback);
      return 1;
    },
    clearTimeout: () => undefined,
    setInterval: (callback) => {
      scheduledIntervals.push(callback);
      return 2;
    },
    clearInterval: () => undefined,
  });

  adapter.start();
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledIntervals.length, 1);

  scheduledTimeouts[0]();
  scheduledIntervals[0]();

  assert.equal(checks, 2);
});

test('update adapter checks once per day by default', () => {
  let scheduledIntervalMs = 0;

  const adapter = createUpdateAdapter({
    getState: () => createState('idle'),
    configure: () => undefined,
    checkForUpdates: async () => createState('not-available'),
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: (_callback, delayMs) => {
      scheduledIntervalMs = delayMs;
      return 2;
    },
    clearInterval: () => undefined,
  });

  adapter.start();

  assert.equal(scheduledIntervalMs, DEFAULT_UPDATE_CHECK_INTERVAL_MS);
  assert.equal(scheduledIntervalMs, 24 * 60 * 60 * 1000);
});

test('update adapter returns downloaded readiness without prompting', async () => {

  const adapter = createUpdateAdapter({
    getState: () => createState('idle'),
    configure: () => undefined,
    checkForUpdates: async () => createState('downloaded'),
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 2,
    clearInterval: () => undefined,
  });

  assert.equal((await adapter.checkNow()).status, 'downloaded');
});

test('update adapter skips automatic checks while an update is busy', async () => {
  const busyStatuses: UpdateAdapterState['status'][] = ['checking', 'available', 'downloading', 'downloaded', 'installing'];

  for (const status of busyStatuses) {
    let checks = 0;
    const adapter = createUpdateAdapter({
      getState: () => createState(status),
      configure: () => undefined,
      checkForUpdates: async () => {
        checks += 1;
        return createState('not-available');
      },
        setTimeout: () => 1,
      clearTimeout: () => undefined,
      setInterval: () => 2,
      clearInterval: () => undefined,
    });

    await adapter.checkNow();

    assert.equal(checks, 0, `${status} should not trigger another check`);
  }
});
