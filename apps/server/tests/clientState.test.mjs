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
