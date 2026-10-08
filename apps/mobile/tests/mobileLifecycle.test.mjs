import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
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

test('disconnect deletion follows a pending native credential write', async () => {
  const { serializeMobileCredentialMutation } = await import('../mobileCredentialPersistence.ts');
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let stored = null;
  const write = serializeMobileCredentialMutation(async () => { entered(); await held; stored = 'credential'; });
  await started;
  const clear = serializeMobileCredentialMutation(async () => { stored = null; });
  release();
  await Promise.all([write, clear]);
  assert.equal(stored, null);
});

function appFunction(name, nextName, context) {
  const source = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const end = name === 'refreshSavedCredentials' ? source.indexOf('  const requestMobileCatalog =') : source.indexOf(`  async function ${nextName}(`);
  const fn = source.slice(source.indexOf(`  async function ${name}(`), end);
  vm.runInContext(`${stripTypeScriptTypes(fn)};globalThis.run = ${name};`, context);
  return context.run;
}

for (const invalidate of ['lock', 'disconnect']) {
  test(`offline restoration cannot undo ${invalidate} during snapshot reads`, async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let generation = 0;
    const changes = [];
    const context = vm.createContext({
      captureSession: () => { const captured = generation; return () => generation === captured; },
      mobileOfflineCacheGeneration: () => generation,
      credentialRefreshKeyRef: { current: 'credential' },
      loadMobileOfflineSnapshot: () => pending,
      canRestoreMobileOfflineSnapshot: () => true,
      clearMobileOfflineSnapshot: async () => {},
      formatOfflineSnapshotTime: () => '',
    });
    for (const name of ['Connection', 'Profiles', 'ActiveProfile', 'AutomaticProfileSignIn', 'ProfileLists', 'Progress', 'ProfilePickerMode', 'IsOnboarding', 'BaseUrl', 'OfflineSnapshotSavedAt', 'IsServerOffline', 'Error']) {
      context[`set${name}`] = (...args) => changes.push(args);
    }
    const restore = appFunction('restoreOfflineConnection', 'reconnectSavedConnection', context);
    const restoring = restore({ hostDeviceId: 'host', refreshTokenExpiresAt: Date.now() + 10000 });
    generation += 1;
    if (invalidate === 'disconnect') context.credentialRefreshKeyRef.current = '';
    release({ library: {}, progress: {}, profiles: [], savedAt: Date.now() });
    assert.equal(await restoring, false);
    assert.equal(changes.length, 0);
  });
}

test('credential refresh cannot install state after disconnect during persistence', async () => {
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let current = true;
  const changes = [];
  const context = vm.createContext({
    captureSession: () => () => current,
    credentialRefreshPromiseRef: { current: null }, credentialRefreshKeyRef: { current: '' },
    mobileDeviceName: () => 'Phone',
    mobileLanClient: { refreshCredentials: async () => ({ ok: true }) },
    readJsonResponse: async () => ({ accessToken: 'token', refreshToken: 'token', accessTokenExpiresAt: 1000, refreshTokenExpiresAt: 1000 }),
    refreshedCredentialsSchema: {}, SAVED_CONNECTION_KEY: 'connection',
    serializeMobileCredentialMutation: (operation) => operation(),
    SecureStore: { setItemAsync: async () => { entered(); await held; } },
    setSavedConnection: (...args) => changes.push(args), setConnection: (...args) => changes.push(args),
  });
  const refresh = appFunction('refreshSavedCredentials', 'hydrateSelectedProfile', context);
  const refreshing = refresh({ hostDeviceId: 'host', deviceId: 'phone', baseUrl: 'https://desktop', refreshToken: 'token' });
  await started;
  current = false;
  context.credentialRefreshKeyRef.current = '';
  release();
  await assert.rejects(refreshing, /superseded/);
  assert.equal(changes.length, 0);
});

test('owned playback lease renews while paused, stops once and ignores a late renewal', async () => {
  const { ownMobilePlaybackLease } = await import('../mobilePlaybackLease.ts');
  let timer;
  let release;
  let renewals = 0;
  let replacements = 0;
  let stops = 0;
  const lease = ownMobilePlaybackLease({
    expiresAt: 300000, absoluteExpiresAt: 900000, now: () => 0,
    schedule: (fn) => { timer = fn; return 1; }, unschedule: () => {},
    renew: async () => { renewals += 1; return new Promise((resolve) => { release = resolve; }); },
    stop: async () => { stops += 1; },
    onRenewed: async () => { replacements += 1; }, onFailure: assert.fail,
  });
  timer();
  assert.equal(renewals, 1);
  await lease.close();
  await lease.close();
  release({ playlistUrl: 'https://server/rotated', expiresAt: 600000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacements, 0);
  assert.equal(stops, 1);
});

test('playback renewal respects the original absolute lifetime', async () => {
  const { ownMobilePlaybackLease } = await import('../mobilePlaybackLease.ts');
  let timer;
  let time = 0;
  let renewals = 0;
  let failures = 0;
  const lease = ownMobilePlaybackLease({
    expiresAt: 300000, absoluteExpiresAt: 600000, now: () => time,
    schedule: (fn) => { timer = fn; return 1; }, unschedule: () => {},
    renew: async () => { renewals += 1; return { expiresAt: 1000000, absoluteExpiresAt: 1000000 }; },
    stop: async () => {}, onRenewed: async () => {}, onFailure: () => { failures += 1; },
  });
  timer();
  await new Promise((resolve) => setImmediate(resolve));
  time = 600000;
  timer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewals, 1);
  assert.equal(failures, 1);
  await lease.close();
});

test('downloaded playback records local progress before an unavailable server can respond', async () => {
  const source = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const syncPlaybackProgress =');
  const end = source.indexOf('  useEffect(() => {', start);
  const changes = {};
  const persisted = [];
  const target = { mediaId: 'episode', streamPath: 'episode', offlineUri: 'file:///download.mp4' };
  const context = vm.createContext({
    useCallback: (fn) => fn, playTarget: target, player: { currentTime: 200, duration: 1000 },
    sourceOffset: 0, connectionBaseUrl: 'https://server', connectionDeviceToken: 'device', connectionSelectionRevision: 1,
    connection: { hostDeviceId: 'host', library: {} }, activeProfile: { id: 'profile' }, progress: {}, isServerOffline: true,
    captureSession: () => () => true,
    mobileAbsoluteMediaSeconds, mobileMediaDurationSeconds: (value) => value,
    filePathFromUrl: (path) => path, mediaIdForPlayTarget: (value) => value.mediaId,
    libraryWithPlayedItem: (library) => library,
    setProgress: (update) => { changes.progress = update(changes.progress || {}); }, setConnection: () => {},
    saveMobilePendingProgress: async (host, profile, entry) => { persisted.push({ host, profile, entry }); },
    mobileLanClient: { saveProgress: async () => { throw new Error('offline'); } },
    reportNonFatal: () => {},
  });
  vm.runInContext(`${stripTypeScriptTypes(source.slice(start, end))};globalThis.sync = syncPlaybackProgress;`, context);
  await context.sync();
  assert.equal(changes.progress.episode.position, 200);
  assert.equal(persisted[0].profile, 'profile');
  assert.equal(persisted[0].entry.progress.position, 200);
});

test('cancelled preparation stops a lease returned after cancellation', async () => {
  const source = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  useEffect(() => {', source.indexOf('// Only prepare/transcode'));
  const end = source.indexOf('  const retryPlayback =', start);
  let cleanup;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const stopped = [];
  const installed = [];
  const context = vm.createContext({
    useEffect: (fn) => { cleanup = fn(); }, AbortController,
    playTarget: { mediaId: 'episode' }, connection: { baseUrl: 'https://server', deviceToken: 'device' },
    streamOptions: {}, streamRetryNonce: 0, player: {}, shouldAutoplayRef: {}, userPausedRef: {},
    playbackReleaseRef: { current: Promise.resolve() }, hasStreamOptions: () => false,
    mediaIdForPlayTarget: (target) => target.mediaId,
    mobileLanClient: { startHls: () => pending, stopPlayback: async (...args) => { stopped.push(args); } },
    readJsonResponse: async () => ({ ok: true, data: { playlistUrl: 'https://server/index.m3u8', sessionId: 'owned-session', expiresAt: 300000 } }),
    hlsSessionResultSchema: {}, setPlaybackUrl: (url) => installed.push(url), setPlaybackFailure: () => {},
    setIsPreparingStream: () => {}, setSourceOffset: () => {}, reportNonFatal: () => {},
  });
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
  await new Promise((resolve) => setImmediate(resolve));
  cleanup();
  release({ ok: true });
  await context.playbackReleaseRef.current;
  assert.deepEqual(installed, []);
  assert.equal(stopped.length, 1);
  assert.deepEqual(Array.from(stopped[0]), ['https://server', 'device', 'episode', 'owned-session']);
});

test('expired credentials cannot restore an offline snapshot', async () => {
  let reads = 0;
  let cleared = 0;
  const context = vm.createContext({
    captureSession: () => () => true, mobileOfflineCacheGeneration: () => 0,
    credentialRefreshKeyRef: { current: '' },
    clearMobileOfflineSnapshot: async () => { cleared += 1; },
    loadMobileOfflineSnapshot: async () => { reads += 1; },
  });
  const restore = appFunction('restoreOfflineConnection', 'reconnectSavedConnection', context);
  assert.equal(await restore({ hostDeviceId: 'host', refreshTokenExpiresAt: Date.now() - 1 }), false);
  assert.equal(reads, 0);
  assert.equal(cleared, 1);
});

test('offline restoration rejects fabricated expiry dates for the same fixed credential', async () => {
  let reads = 0;
  const context = vm.createContext({
    captureSession: () => () => true, mobileOfflineCacheGeneration: () => 0,
    credentialRefreshKeyRef: { current: '' },
    clearMobileOfflineSnapshot: async () => {},
    loadMobileOfflineSnapshot: async () => { reads += 1; },
  });
  const restore = appFunction('restoreOfflineConnection', 'reconnectSavedConnection', context);
  assert.equal(await restore({ hostDeviceId: 'host', deviceToken: 'fixed', refreshToken: 'fixed',
    accessTokenExpiresAt: Date.now() + 86400000, refreshTokenExpiresAt: Date.now() + 365 * 86400000 }), false);
  assert.equal(reads, 0);
});
