import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCanonicalStateStore } from '../src/canonical-state-store.js';
import { createHeadlessClientState } from '../src/client-state.js';
import {
  commitLegacyCanonicalImport,
  createLegacyCanonicalImportPlan,
  createMigrationReport,
  createVerifiedLegacyBackup,
} from '../src/legacy-state-import.js';

const owner = { id: 'owner-1', name: 'Owner', salt: 'preserved-salt', hash: 'preserved-hash', createdAt: 123 };

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-state-regression-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('legacy JSON import without a desktop projection preserves its source files and credentials', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const adminBytes = JSON.stringify({ owner });
  const clientBytes = JSON.stringify({
    profiles: [{ id: 'profile-1', name: 'Viewer', ownerId: owner.id, type: 'standard', createdAt: 456, updatedAt: 789 }],
    selections: { [owner.id]: 'profile-1' },
  });
  await fs.writeFile(path.join(dataDir, 'headless-admin.json'), adminBytes);
  await fs.writeFile(path.join(dataDir, 'headless-client.json'), clientBytes);
  const plan = await createLegacyCanonicalImportPlan({ dataDir });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.state.clientState.profiles[0].kind, 'adult');
  assert.equal(plan.state.clientState.assignments[0].access, 'manage');
  assert.equal(plan.state.adminState.owner.hash, owner.hash);
  const backup = await createVerifiedLegacyBackup({ dataDir, migrationId: plan.migrationId, destinationDir: path.join(dataDir, 'backups') });
  const reportPath = path.join(dataDir, 'migration-report.json');
  await fs.writeFile(reportPath, JSON.stringify(createMigrationReport(plan, { dryRun: false, backup })));
  const result = await commitLegacyCanonicalImport({ dataDir, plan, backupPath: backup.backupPath, reportPath });
  assert.equal(result.committed, true);
  const store = createCanonicalStateStore({ dataDir });
  t.after(() => store.stop());
  await store.start();
  assert.equal(store.readAdminState().owner.hash, owner.hash);
  assert.equal(store.readClientState().profiles[0].id, 'profile-1');
  assert.equal(await fs.readFile(path.join(dataDir, 'headless-admin.json'), 'utf8'), adminBytes);
  assert.equal(await fs.readFile(path.join(dataDir, 'headless-client.json'), 'utf8'), clientBytes);
});

test('canonical preferences survive reopening and a corrupt snapshot rolls back atomically', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = createCanonicalStateStore({ dataDir });
  t.after(() => store.stop());
  await store.start();
  store.replaceAdminState({ owner });
  const client = createHeadlessClientState({ store });
  const profile = await client.createProfile({ name: 'Viewer' }, owner.id);
  await client.saveProfilePreferences(profile.id, { themeMode: 'light', skipBackSeconds: 15 }, owner.id);
  await client.saveTrackPreferences(profile.id, 'movie-1', { audio: { enabled: true, language: 'en', index: 0 } }, owner.id);
  const before = store.readClientState();
  const snapshot = store.exportCanonicalSnapshot();
  snapshot.tables.profile_preferences[0].payload_json = '{';
  await assert.rejects(store.restoreCanonicalSnapshot(snapshot), { code: 'canonical_backup_invalid' });
  assert.deepEqual(store.readClientState(), before);
  await store.stop();
  await store.start();
  assert.deepEqual(store.readClientState(), before);
  assert.deepEqual(await client.getProfilePreferences(profile.id, owner.id), { themeMode: 'light', skipBackSeconds: 15 });
  assert.deepEqual(await client.getTrackPreferences(profile.id, 'movie-1', owner.id), { audio: { enabled: true, language: 'en', index: 0 } });
});

test('migrated episodes round-trip through canonical backup with validated series references', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = createCanonicalStateStore({ dataDir });
  t.after(() => store.stop());
  await store.start();
  store.replaceAllState({
    adminState: { owner },
    catalogItems: [
      { id: 'series-1', kind: 'series', title: 'Show', createdAt: 123, updatedAt: 123 },
      { id: 'episode-1', kind: 'episode', title: 'Pilot', seriesId: 'series-1', seasonNumber: 1, episodeNumber: 1, createdAt: 123, updatedAt: 123 },
    ],
  });
  const before = store.readAdminState().catalog;
  const snapshot = store.exportCanonicalSnapshot();
  assert.equal(JSON.parse(snapshot.tables.catalog_items.find((item) => item.id === 'episode-1').extension_json).seriesId, 'series-1');
  await store.restoreCanonicalSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(store.readAdminState().catalog, before);
  for (const seriesId of [null, 42, '', 'missing-series', 'episode-1']) {
    const invalid = structuredClone(snapshot);
    invalid.tables.catalog_items.find((item) => item.id === 'episode-1').extension_json = JSON.stringify({ seriesId });
    await assert.rejects(store.restoreCanonicalSnapshot(invalid), { code: 'canonical_backup_invalid' });
    assert.deepEqual(store.readAdminState().catalog, before);
  }
});

test('preference validation rejects non-numeric values without replacing saved preferences', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = createCanonicalStateStore({ dataDir });
  t.after(() => store.stop());
  await store.start();
  store.replaceAdminState({ owner });
  const client = createHeadlessClientState({ store });
  const profile = await client.createProfile({ name: 'Viewer' }, owner.id);
  await client.saveProfilePreferences(profile.id, { skipBackSeconds: 10 }, owner.id);
  for (const skipBackSeconds of [null, '15', {}, [], true]) {
    await assert.rejects(client.saveProfilePreferences(profile.id, { skipBackSeconds }, owner.id), { code: 'invalid_request' });
  }
  await assert.rejects(client.saveTrackPreferences(profile.id, 'movie-1', { audio: { enabled: true, index: '0' } }, owner.id), { code: 'invalid_request' });
  assert.deepEqual(await client.getProfilePreferences(profile.id, owner.id), { skipBackSeconds: 10 });
});

test('a progress heartbeat writes one row and leaves other profile tables alone', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const dataDir = await temporaryDirectory(t);
  const store = createCanonicalStateStore({ dataDir });
  t.after(() => store.stop());
  await store.start();
  store.replaceAdminState({ owner });
  const client = createHeadlessClientState({ store });
  const profile = await client.createProfile({ name: 'Viewer' }, owner.id);
  await client.saveProfilePreferences(profile.id, { themeMode: 'light' }, owner.id);
  await client.setProfileListEntry(profile.id, 'movie-1', 'watchlist', true, owner.id);
  await client.saveTrackPreferences(profile.id, 'movie-1', { audio: { enabled: true, language: 'en', index: 0 } }, owner.id);

  // Persistent triggers log any delete or rewrite of the neighbouring tables,
  // which the former full-state replacement did on every heartbeat.
  const observer = new DatabaseSync(path.join(dataDir, 'loomtv-canonical.sqlite'));
  t.after(() => observer.close());
  observer.exec('CREATE TABLE test_change_log (tbl TEXT NOT NULL)');
  for (const table of ['profiles', 'profile_assignments', 'profile_preferences', 'profile_list_entries', 'track_preferences', 'watch_history']) {
    observer.exec(`CREATE TRIGGER test_${table}_delete AFTER DELETE ON ${table} BEGIN INSERT INTO test_change_log VALUES ('${table}'); END;
      CREATE TRIGGER test_${table}_update AFTER UPDATE ON ${table} BEGIN INSERT INTO test_change_log VALUES ('${table}'); END;`);
  }
  const changes = () => observer.prepare('SELECT tbl FROM test_change_log').all().map((row) => row.tbl);

  const first = await client.saveProgress(profile.id, 'movie-1', { position: 30, duration: 100 }, owner.id);
  assert.equal(first.watched, false);
  const second = await client.saveProgress(profile.id, 'movie-1', { position: 95, duration: 100 }, owner.id);
  assert.equal(second.watched, true, 'reaching 90% marks the title watched');
  const rewound = await client.saveProgress(profile.id, 'movie-1', { position: 10, duration: 100 }, owner.id);
  assert.equal(rewound.watched, true, 'watched stays set until explicitly cleared');
  const cleared = await client.saveProgress(profile.id, 'movie-1', { position: 10, duration: 100, watched: false }, owner.id);
  assert.equal(cleared.watched, false);
  assert.deepEqual(changes(), [], 'heartbeats must not touch other profile tables');
  assert.deepEqual(await client.listProgress(profile.id, owner.id), {
    'movie-1': { position: 10, duration: 100, watched: false, updatedAt: cleared.updatedAt },
  });

  await assert.rejects(client.saveProgress(profile.id, 'movie-1', { position: 1, duration: 100 }, 'someone-else'), { status: 403, code: 'profile_forbidden' });
  await assert.rejects(client.saveProgress('missing-profile', 'movie-1', { position: 1, duration: 100 }, owner.id), { status: 404, code: 'profile_not_found' });

  // The triggers do catch full-state writes.
  await client.saveProfilePreferences(profile.id, { themeMode: 'dark' }, owner.id);
  assert.ok(changes().length > 0);
});

test('targeted progress saves keep only the newest entries per profile', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = createCanonicalStateStore({ dataDir });
  t.after(() => store.stop());
  await store.start();
  store.replaceAdminState({ owner });
  const client = createHeadlessClientState({ store });
  const profile = await client.createProfile({ name: 'Viewer' }, owner.id);
  const allow = () => {};
  for (const [index, mediaId] of ['a', 'b', 'c', 'd'].entries()) {
    store.saveWatchProgress({ profileId: profile.id, mediaId, positionSeconds: 5, durationSeconds: 100, updatedAt: 1000 + index, maxPerProfile: 3 }, allow);
  }
  assert.deepEqual(Object.keys(await client.listProgress(profile.id, owner.id)).sort(), ['b', 'c', 'd']);
});

test('library filtering checks every item against one client-state read', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = createCanonicalStateStore({ dataDir });
  t.after(() => store.stop());
  await store.start();
  store.replaceAdminState({ owner });
  const client = createHeadlessClientState({ store });
  const profile = await client.createProfile({ name: 'Viewer' }, owner.id);
  store.mutateClientState((state) => {
    state.profileRestrictions.push({ profileId: profile.id, allowedRootIds: ['root-a'], allowUnrated: true, maximumAge: 12, country: 'US', revision: 1 });
  });
  const items = [
    { id: 'allowed', rootId: 'root-a' },
    { id: 'other-root', rootId: 'root-b' },
    { id: 'rated-16', rootId: 'root-a', contentRatings: { US: { minimumAge: 16 } } },
    { id: 'rated-7', rootId: 'root-a', maximumAge: 7 },
  ];
  const decide = async (run) => {
    try { await run(); return 'allowed'; } catch (error) { return error.code; }
  };
  const expected = [];
  for (const item of items) expected.push(await decide(() => client.requireActivePlaybackProfile(owner.id, undefined, item)));
  assert.deepEqual(expected, ['allowed', 'permission_denied', 'permission_denied', 'allowed']);

  let reads = 0;
  const readClientState = store.readClientState;
  store.readClientState = () => { reads += 1; return readClientState(); };
  t.after(() => { store.readClientState = readClientState; });
  const check = await client.activePlaybackProfileChecker(owner.id, undefined);
  const actual = [];
  for (const item of items) actual.push(await decide(() => check(item)));
  assert.deepEqual(actual, expected, 'the snapshot checker must make the same decisions');
  assert.equal(reads, 1);

  const scoped = await client.scopedProfileChecker(owner.id, profile.id);
  assert.deepEqual(await Promise.all(items.map((item) => decide(() => scoped(item)))), expected);
  assert.equal(reads, 2);
});

test('bulk media source lookup matches the per-item lookup', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = createCanonicalStateStore({ dataDir });
  t.after(() => store.stop());
  await store.start();
  const roots = [{ id: 'root-a', path: '/media/a', kind: 'movies', createdAt: 1 }];
  const catalog = ['movie-1', 'movie-2', 'episode-1'].map((id, index) => ({
    id, rootId: 'root-a', path: `/media/a/${id}.mkv`, relativePath: `${id}.mkv`, type: 'video',
    kind: id.startsWith('episode') ? 'episode' : 'movie', title: id, extension: '.mkv',
    sizeBytes: 100 + index, modifiedAtMs: 10 + index, available: index !== 1, indexedAt: 1000 + index,
  }));
  store.replaceAdminState({ owner, roots, catalog });
  const grouped = store.listMediaSourcesByMedia();
  assert.deepEqual([...grouped.keys()].sort(), ['episode-1', 'movie-1', 'movie-2']);
  for (const item of catalog) assert.deepEqual(grouped.get(item.id), store.listMediaSources(item.id));
  assert.equal(grouped.get('movie-2')[0].state, 'offline');
});

test('backups reconcile deleted invitation scopes and restore with enabled profile managers', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = createCanonicalStateStore({ dataDir }); await store.start(); t.after(() => store.stop());
  const user = { id: 'user-1', name: 'User', salt: 'user-salt', hash: 'user-hash', role: 'user', permissions: ['library.read', 'stream'], rootIds: null, deviceIds: null, maxSessions: null, disabled: false, createdAt: 123, updatedAt: 123 };
  const root = { id: 'root-1', path: path.join(dataDir, 'fixture-media'), kind: 'movies', createdAt: 123 };
  store.replaceAllState({ adminState: { owner, users: [user], roots: [root] },
    catalogItems: [{ id: 'media-1', kind: 'movie', title: 'Movie', createdAt: 123, updatedAt: 123 }],
    mediaSources: [{ id: 'source-1', mediaId: 'media-1', rootId: root.id, relativePath: 'movie.mp4', locator: path.join(root.path, 'movie.mp4'), state: 'online', indexedAt: 123 }] });
  const client = createHeadlessClientState({ store });
  const profile = await client.createProfile({ name: 'Owner profile' }, owner.id);
  const removed = await client.createProfile({ name: 'Removed profile' }, owner.id);
  const managed = await client.createProfile({ name: 'User profile' }, user.id);
  const now = Date.now();
  for (const [id, profileId] of [['media-invite', profile.id], ['profile-invite', removed.id], ['historical-invite', profile.id]]) {
    store.createInvitation({ id, issuerAccountId: owner.id, secretHash: `${id}-hash`, scope: { profileId, rootIds: [root.id], mediaIds: ['media-1'], permissions: ['library.read', 'stream'], downloadQuotaBytes: 1024 }, createdAt: now, expiresAt: now + 60_000 });
  }
  store.revokeInvitation('historical-invite', owner.id);
  await client.removeProfile(removed.id, owner.id);
  assert.equal(store.readInvitation('profile-invite'), null);
  store.deleteMediaSource('media-1', 'source-1');
  for (const id of ['media-invite', 'historical-invite']) {
    assert.deepEqual(store.readInvitation(id).scope.mediaIds, []);
    assert.equal(store.readInvitation(id).state, 'revoked');
  }
  const state = store.readAdminState();
  assert.throws(() => store.replaceAdminState({ ...state, users: [{ ...user, disabled: true }] }), { code: 'profile_manager_required' });
  store.mutateClientState((state) => state.assignments.push({ profileId: managed.id, accountId: owner.id, access: 'manage', createdAt: now }));
  store.replaceAdminState({ ...store.readAdminState(), users: [{ ...user, disabled: true }] });
  const snapshot = store.exportCanonicalSnapshot();
  const copyDir = await temporaryDirectory(t);
  const copy = createCanonicalStateStore({ dataDir: copyDir }); await copy.start(); t.after(() => copy.stop());
  copy.replaceAdminState({ owner });
  await copy.restoreCanonicalSnapshot(snapshot);
  assert.equal(copy.readAdminState().users[0].disabled, true);
  assert.deepEqual(copy.readClientState().profiles, store.readClientState().profiles);
  assert.equal(copy.readInvitation('media-invite').state, 'revoked');
  assert.deepEqual(copy.readInvitation('media-invite').scope.mediaIds, []);
});

test('backup export rejects state that restore would reject', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = createCanonicalStateStore({ dataDir }); await store.start(); t.after(() => store.stop());
  store.replaceAdminState({ owner });
  const client = createHeadlessClientState({ store });
  const profile = await client.createProfile({ name: 'Viewer' }, owner.id);
  store.mutateClientState((state) => state.profilePreferences.push({ profileId: profile.id, preferences: { themeMode: 'invalid' }, updatedAt: Date.now() }));
  assert.throws(() => store.exportCanonicalSnapshot(), { code: 'canonical_backup_invalid' });
});

test('operational logs keep newest-first order, ties, and retention across replacement and restart', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = createCanonicalStateStore({ dataDir }); await store.start(); t.after(() => store.stop());
  store.replaceAdminState({ owner });
  const now = Date.now();
  store.appendOperationalLog({ timestamp: now, message: 'first' }, now);
  store.appendOperationalLog({ timestamp: now, message: 'second' }, now);
  store.appendOperationalLog({ timestamp: now + 1, message: 'newest' }, now + 1);
  const expected = ['newest', 'second', 'first'];
  assert.deepEqual(store.readAdminState().logs.map((entry) => entry.message), expected);
  store.replaceAdminState(store.readAdminState());
  await store.stop(); await store.start();
  assert.deepEqual(store.readAdminState().logs.map((entry) => entry.message), expected);
  for (let index = 0; index < 260; index += 1) store.appendOperationalLog({ timestamp: now + 2 + index, message: `log-${index}` }, now + 2 + index);
  const logs = store.readAdminState().logs;
  assert.equal(logs.length, 250);
  assert.equal(logs[0].message, 'log-259');
  assert.equal(logs.at(-1).message, 'log-10');
  store.replaceAdminState({ ...store.readAdminState(), logs });
  await store.stop(); await store.start();
  assert.deepEqual(store.readAdminState().logs, logs);
  store.replaceAdminState({ ...store.readAdminState(), logs: Array.from({ length: 300 }, (_, index) => ({ timestamp: now + 1000 + index, message: `replacement-${index}` })) });
  const replacement = store.readAdminState().logs;
  assert.equal(replacement.length, 250);
  assert.equal(replacement[0].message, 'replacement-299');
  assert.equal(replacement.at(-1).message, 'replacement-50');
});
