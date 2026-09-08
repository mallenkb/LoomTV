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
