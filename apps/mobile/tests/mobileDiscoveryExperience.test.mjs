import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MOBILE_AUTOMATIC_CONNECT_RETRY_MS,
  automaticDiscoveredHost,
  automaticHostAttemptDelay,
  automaticHostAttemptKey,
  upsertDiscoveredHost,
} from '../mobileDiscoveryExperience.ts';
import { connectionErrorFor } from '../mobileConnection.ts';
import { mobileReconnectDelayMs } from '../mobileDomain.ts';

const fingerprint = 'ab'.repeat(32);
const host = (deviceId, deviceName = deviceId, baseUrl = `https://${deviceId}.local:3848`) => ({
  deviceId,
  deviceName,
  serviceName: deviceName,
  baseUrl,
  certFingerprint: fingerprint,
});

test('one obvious desktop connects automatically while ambiguous first-run discovery waits', () => {
  const desktop = host('desktop-a', 'Office Mac');
  assert.equal(automaticDiscoveredHost([desktop], null), desktop);
  assert.equal(automaticDiscoveredHost([desktop, host('desktop-b')], null), null);
});

test('a saved desktop is selected by stable identity even after its address changes', () => {
  const moved = host('desktop-a', 'Office Mac', 'https://192.168.1.77:3848');
  const saved = { hostDeviceId: 'desktop-a' };
  assert.equal(automaticDiscoveredHost([host('desktop-b'), moved], saved), moved);
  assert.equal(automaticDiscoveredHost([host('desktop-b')], saved), null);
});

test('discovery updates one stable host without duplicates or layout churn', () => {
  const first = host('desktop-a', 'Zeta', 'https://192.168.1.10:3848');
  const moved = host('desktop-a', 'Alpha', 'https://192.168.1.11:3848');
  assert.deepEqual(upsertDiscoveredHost([first, host('desktop-b', 'Beta')], moved), [moved, host('desktop-b', 'Beta')]);
});

test('automatic attempts retry quietly and changed host identity receives a fresh key', () => {
  const desktop = host('desktop-a');
  assert.equal(automaticHostAttemptDelay(undefined, 1_000), 0);
  assert.equal(automaticHostAttemptDelay(1_000, 2_000), MOBILE_AUTOMATIC_CONNECT_RETRY_MS - 1_000);
  assert.equal(automaticHostAttemptDelay(1_000, 1_000 + MOBILE_AUTOMATIC_CONNECT_RETRY_MS), 0);
  assert.notEqual(automaticHostAttemptKey(desktop), automaticHostAttemptKey({ ...desktop, baseUrl: 'https://192.168.1.99:3848' }));
});

test('reconnect cadence is fast but bounded for changing LAN conditions', () => {
  assert.equal(mobileReconnectDelayMs(0), 750);
  assert.equal(mobileReconnectDelayMs(1), 1_500);
  assert.equal(mobileReconnectDelayMs(4), 10_000);
  assert.equal(mobileReconnectDelayMs(100), 10_000);
});

test('LAN timeouts are treated as recoverable instead of user-facing failures', () => {
  assert.deepEqual(connectionErrorFor(new Error('The desktop did not respond within 4000ms.'), 'Failed'), {
    isOffline: true,
    message: 'Server unavailable. Reconnecting automatically.',
  });
  assert.deepEqual(connectionErrorFor(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'Failed'), {
    isOffline: true,
    message: '',
  });
});
