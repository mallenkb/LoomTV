import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileCatalogIdentity } from '../mobileDomain.ts';
import { mobileConnectionLifecycleAction, replaceMobilePlayerSource } from '../mobileLifecycle.ts';
import { mobileAbsoluteMediaSeconds, mobilePlayerSecondsForAbsolute } from '../playbackClock.ts';

const lifecycleCases = [
  {
    name: 'backgrounding suspends retries and health checks',
    input: { appState: 'background', hasConnection: true, hasSavedConnection: true, isPairing: false, isServerOffline: false },
    expected: 'idle',
  },
  {
    name: 'an offline saved session retries while active',
    input: { appState: 'active', hasConnection: true, hasSavedConnection: true, isPairing: false, isServerOffline: true },
    expected: 'retry-saved',
  },
  {
    name: 'an active online session runs health checks',
    input: { appState: 'active', hasConnection: true, hasSavedConnection: true, isPairing: false, isServerOffline: false },
    expected: 'health-check',
  },
  {
    name: 'pairing suppresses saved-session retries',
    input: { appState: 'active', hasConnection: false, hasSavedConnection: true, isPairing: true, isServerOffline: false },
    expected: 'discover',
  },
];

for (const fixture of lifecycleCases) {
  test(fixture.name, () => {
    assert.equal(mobileConnectionLifecycleAction(fixture.input), fixture.expected);
  });
}

test('profile and catalog changes produce distinct cache identities', () => {
  assert.notEqual(mobileCatalogIdentity('owner', 4), mobileCatalogIdentity('kid', 4));
  assert.notEqual(mobileCatalogIdentity('owner', 4), mobileCatalogIdentity('owner', 5));
});

test('resume clocks preserve absolute media time', () => {
  assert.equal(mobilePlayerSecondsForAbsolute(245), 245);
  assert.equal(mobileAbsoluteMediaSeconds(245), 245);
});

test('player replacement ignores completion from a stale player generation', async () => {
  let current = true;
  const replacement = replaceMobilePlayerSource(
    async () => { current = false; },
    { uri: 'https://desktop.local/stream' },
    () => current,
  );
  assert.equal(await replacement, 'stale');
});

test('current player replacement reports a native load failure', async () => {
  const result = await replaceMobilePlayerSource(
    async () => { throw new Error('native player unavailable'); },
    { uri: 'https://desktop.local/stream' },
    () => true,
  );
  assert.equal(result, 'failed');
});
