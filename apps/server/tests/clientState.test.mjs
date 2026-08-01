import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHeadlessClientState, legacyHeadlessClientStateFilename } from '../src/client-state.js';

async function makeStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-client-state-'));
  return { store: createHeadlessClientState({ dataDir }), dataDir };
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

test('a malformed legacy JSON store is normalized during migration instead of crashing', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-client-state-'));
  const junkProfiles = [
    { id: 'ok', ownerId: 'user-a', name: 'x'.repeat(500), type: 'not-a-type', createdAt: 'yesterday' },
    { ownerId: 'missing-id' },
    'not-an-object',
    null,
  ];
  await fs.writeFile(
    path.join(dataDir, legacyHeadlessClientStateFilename),
    JSON.stringify({ profiles: junkProfiles, progress: { p: { m: { position: -5, duration: 'NaN' } } }, selections: 42 }),
  );
  const store = createHeadlessClientState({ dataDir });
  const profiles = await store.listProfiles('user-a');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name.length <= 80, true);
  assert.equal(['owner', 'standard', 'kid', 'guest'].includes(profiles[0].type), true);
});

test('legacy JSON state migrates into SQLite once and survives a store reopen', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-client-state-'));
  const legacy = {
    profiles: [{ id: 'legacy-1', ownerId: 'user-a', name: 'From JSON', type: 'kid', createdAt: 5, updatedAt: 6 }],
    progress: { 'legacy-1': { 'media-1': { position: 10, duration: 100, watched: false, updatedAt: 7 } } },
    selections: { 'user-a': 'legacy-1' },
  };
  await fs.writeFile(path.join(dataDir, legacyHeadlessClientStateFilename), JSON.stringify(legacy));

  const store = createHeadlessClientState({ dataDir });
  const profiles = await store.listProfiles('user-a');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'From JSON');
  assert.equal((await store.getProgress('legacy-1', 'media-1', 'user-a')).position, 10);

  // The JSON file is renamed so the migration cannot run twice.
  await assert.rejects(() => fs.access(path.join(dataDir, legacyHeadlessClientStateFilename)));
  await fs.access(path.join(dataDir, `${legacyHeadlessClientStateFilename}.migrated`));

  // A fresh store instance over the same dataDir reads the SQLite data.
  const reopened = createHeadlessClientState({ dataDir });
  assert.equal((await reopened.listProfiles('user-a'))[0].name, 'From JSON');
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
  assert.equal(profiles[0].type, 'kid');
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
