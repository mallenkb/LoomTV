import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeadlessClientState, normalizeHeadlessClientState } from '../src/client-state.js';

async function makeStore() {
  let state = normalizeHeadlessClientState({});
  const canonicalStore = {
    readClientState: () => state,
    replaceClientState: (next) => { state = normalizeHeadlessClientState(next); },
    mutateClientState: (mutation) => mutation(state),
  };
  return { store: createHeadlessClientState({ store: canonicalStore }), canonicalStore };
}

test('profiles are scoped to their owning account', async () => {
  const { store } = await makeStore();
  const mine = await store.createProfile({ name: 'Living room' }, 'user-a');
  await store.createProfile({ name: 'Other household' }, 'user-b');

  const visible = await store.listProfiles('user-a');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, mine.id);

  await assert.rejects(
    () => store.selectProfile(mine.id, 'user-b'),
    (error) => error.status === 403 && error.code === 'profile_forbidden',
  );
  const everything = await store.listProfiles('user-b', true);
  assert.equal(everything.length, 2);
});

test('progress round-trips and derives watched state near the end of playback', async () => {
  const { store } = await makeStore();
  const profile = await store.createProfile({ name: 'Viewer' }, 'user-a');

  const partial = await store.saveProgress(profile.id, 'media-1', { position: 120, duration: 3600 }, 'user-a');
  assert.equal(partial.watched, false);
  const nearEnd = await store.saveProgress(profile.id, 'media-1', { position: 3500, duration: 3600 }, 'user-a');
  assert.equal(nearEnd.watched, true);

  const read = await store.getProgress(profile.id, 'media-1', 'user-a');
  assert.equal(read.position, 3500);
  assert.equal(read.watched, true);
});

test('a malformed legacy client snapshot stops canonical import', async () => {
  const junkProfiles = [
    { id: 'ok', ownerId: 'user-a', name: 'x'.repeat(500), type: 'not-a-type', createdAt: 'yesterday' },
    { ownerId: 'missing-id' },
    'not-an-object',
    null,
  ];
  assert.throws(
    () => normalizeHeadlessClientState({ profiles: junkProfiles, progress: { p: { m: { position: -5, duration: 'NaN' } } }, selections: 42 }),
    (error) => error.code === 'unknown_profile_kind',
  );
});

test('client state refuses to create a second legacy persistence authority', () => {
  assert.throws(() => createHeadlessClientState({}), /canonical state store/i);
});

test('exportState/importState round-trips profiles and progress for backups', async () => {
  const { store } = await makeStore();
  const profile = await store.createProfile({ name: 'Backup me', type: 'kid' }, 'user-a');
  await store.saveProgress(profile.id, 'media-9', { position: 42, duration: 100 }, 'user-a');

  const snapshot = await store.exportState();
  const { store: restored } = await makeStore();
  await restored.importState(snapshot);

  const profiles = await restored.listProfiles('user-a');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'Backup me');
  assert.equal(profiles[0].kind, 'child');
  const progress = await restored.getProgress(profiles[0].id, 'media-9', 'user-a');
  assert.equal(progress.position, 42);
});

test('an account is limited to 10 profiles', async () => {
  const { store } = await makeStore();
  for (let index = 0; index < 10; index += 1) {
    await store.createProfile({ name: `Profile ${index}` }, 'user-a');
  }
  await assert.rejects(
    () => store.createProfile({ name: 'One too many' }, 'user-a'),
    (error) => error.status === 400 && error.code === 'profile_limit',
  );
});

// A limiter whose checks finish only when the test releases them, in order.
function heldLimiter() {
  const held = [];
  return {
    run: (work) => new Promise((resolve, reject) => { held.push(() => work().then(resolve, reject)); }),
    releaseNext: async () => { const next = held.shift(); if (next) next(); await new Promise((resolve) => { setImmediate(resolve); }); },
    releaseLast: async () => { const last = held.pop(); if (last) last(); await new Promise((resolve) => { setImmediate(resolve); }); },
    get pending() { return held.length; },
  };
}

async function pinProfileStore(kdfLimiter) {
  let state = normalizeHeadlessClientState({});
  const canonicalStore = {
    readClientState: () => state,
    replaceClientState: (next) => { state = normalizeHeadlessClientState(next); },
    mutateClientState: (mutation) => mutation(state),
  };
  const setup = createHeadlessClientState({ store: canonicalStore });
  const profile = await setup.createProfile({ name: 'Kids' }, 'user-a');
  await setup.updateProfilePin(profile.id, '1234', 'user-a');
  return { client: createHeadlessClientState({ store: canonicalStore, kdfLimiter }), profile };
}

test('a concurrent PIN burst checks no more PINs than the free-attempt budget', async () => {
  const limiter = heldLimiter();
  const { client, profile } = await pinProfileStore(limiter);
  const attempts = Array.from({ length: 10 }, (_, index) => client.selectProfile(profile.id, 'user-a', false, 'tv-1', String(1000 + index)).catch((error) => error));
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(limiter.pending, 5, 'only five attempts may be checked at once');
  while (limiter.pending) await limiter.releaseNext();
  const results = await Promise.all(attempts);
  assert.equal(results.filter((error) => error.code === 'pin_in_progress').length, 5);
  assert.equal(results.filter((error) => error.code === 'profile_locked').length, 5);
  // Each checked failure was counted, so the profile is now in its wait period.
  await assert.rejects(client.selectProfile(profile.id, 'user-a', false, 'tv-1', '1234'), { status: 429, code: 'profile_locked' });
});

test('a PIN success does not erase a failure that finished while it was checked', async () => {
  const limiter = heldLimiter();
  const { client, profile } = await pinProfileStore(limiter);
  const correct = client.selectProfile(profile.id, 'user-a', false, 'tv-1', '1234');
  await new Promise((resolve) => { setImmediate(resolve); });
  const wrong = client.selectProfile(profile.id, 'user-a', false, 'tv-1', '0000').catch((error) => error);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(limiter.pending, 2);
  // Finish the wrong attempt first, while the correct one is still checking.
  await limiter.releaseLast();
  assert.equal((await wrong).code, 'profile_locked');
  await limiter.releaseNext();
  await correct;
  // The earlier failure survived, so the fourth further failure is the fifth
  // in total and starts the wait period.
  const outcomes = [];
  for (const pin of ['1111', '2222', '3333', '4444']) {
    const attempt = client.selectProfile(profile.id, 'user-a', false, 'tv-1', pin).catch((error) => error);
    await new Promise((resolve) => { setImmediate(resolve); });
    await limiter.releaseNext();
    outcomes.push((await attempt).status);
  }
  assert.deepEqual(outcomes, [403, 403, 403, 429]);
});

test('a PIN changed during the check is not accepted', async () => {
  const limiter = heldLimiter();
  const { client, profile } = await pinProfileStore(limiter);
  const attempt = client.selectProfile(profile.id, 'user-a', false, 'tv-1', '1234').catch((error) => error);
  await new Promise((resolve) => { setImmediate(resolve); });
  await client.updateProfilePin(profile.id, '9876', 'user-a');
  await limiter.releaseNext();
  assert.equal((await attempt).code, 'profile_pin_changed');
});


test('PIN cooldown permits one retry and retains escalating backoff', async (context) => {
  const limiter = heldLimiter();
  const { client, profile } = await pinProfileStore(limiter);
  let currentTime = Date.now();
  context.mock.method(Date, 'now', () => currentTime);
  async function check(pin) {
    const attempt = client.selectProfile(profile.id, 'user-a', false, 'tv-1', pin).catch((error) => error);
    await limiter.releaseNext();
    return attempt;
  }
  for (let index = 0; index < 4; index += 1) assert.equal((await check('0000')).status, 403);
  assert.equal((await check('0000')).retryAfter, 30);
  currentTime += 30_001;
  const retry = client.selectProfile(profile.id, 'user-a', false, 'tv-1', '0000').catch((error) => error);
  await assert.rejects(client.selectProfile(profile.id, 'user-a', false, 'tv-2', '1234'), { code: 'pin_in_progress' });
  await limiter.releaseNext();
  assert.equal((await retry).retryAfter, 60);
  currentTime += 60_001;
  assert.equal((await check('1234')).id, profile.id);
  assert.equal((await check('0000')).status, 403, 'successful recovery clears earlier failures');
});

test('PIN success preserves a newer failure even when timestamps are equal', async (context) => {
  const limiter = heldLimiter();
  const { client, profile } = await pinProfileStore(limiter);
  const currentTime = Date.now();
  context.mock.method(Date, 'now', () => currentTime);
  const correct = client.selectProfile(profile.id, 'user-a', false, 'tv-1', '1234');
  const wrong = client.selectProfile(profile.id, 'user-a', false, 'tv-1', 'invalid').catch((error) => error);
  await limiter.releaseLast();
  assert.equal((await wrong).status, 403);
  await limiter.releaseNext();
  await correct;
  for (let index = 0; index < 4; index += 1) {
    const attempt = client.selectProfile(profile.id, 'user-a', false, 'tv-1', '0000').catch((error) => error);
    await limiter.releaseNext();
    assert.equal((await attempt).status, index === 3 ? 429 : 403);
  }
});
