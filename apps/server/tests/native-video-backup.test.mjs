import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  exportNativeVideoBackup,
  validateNativeVideoBackup,
  clearNativeVideoBackupTables,
  restoreNativeVideoBackup,
} from '../src/native-video-backup.js';

test('native snapshot keeps encrypted bytes and validates schema before deletion', (context) => {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  database.exec(`CREATE TABLE native_extension_manifest(name TEXT PRIMARY KEY);
    CREATE TABLE protected_state(id TEXT PRIMARY KEY,payload BLOB NOT NULL);
    INSERT INTO native_extension_manifest VALUES('protected_state');
    INSERT INTO protected_state VALUES('configuration',x'01020304');`);
  const snapshot = exportNativeVideoBackup(database);
  validateNativeVideoBackup(database, snapshot);
  const invalid = structuredClone(snapshot);
  invalid.tables.protected_state.columns.push('unexpected');
  assert.throws(() => validateNativeVideoBackup(database, invalid), /storage schema/);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM protected_state').get().count, 1);
  clearNativeVideoBackupTables(database, snapshot);
  restoreNativeVideoBackup(database, snapshot);
  assert.deepEqual(
    Buffer.from(database.prepare('SELECT payload FROM protected_state').get().payload),
    Buffer.from([1, 2, 3, 4]),
  );
});

test('native snapshots revoke LAN credentials while preserving encrypted provider settings', (context) => {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  database.exec(`CREATE TABLE native_extension_manifest(name TEXT PRIMARY KEY);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE app_settings(id INTEGER PRIMARY KEY,data_json TEXT NOT NULL);
    INSERT INTO native_extension_manifest VALUES('app_settings');
    INSERT INTO meta VALUES('native_owner_profile','owner-profile');`);
  const settings = {
    localNetworkSharingEnabled: true,
    localNetworkPairedDevices: [{ id: 'old-device', tokenHash: 'revoked-credential' }],
    __loomtvSecureSettings: { version: 1, encrypted: 'os-encrypted-provider-secrets' },
  };
  database.prepare('INSERT INTO app_settings VALUES(1,?)').run(JSON.stringify(settings));
  const snapshot = exportNativeVideoBackup(database);
  assert.equal(snapshot.ownerProfileId, 'owner-profile');
  assert.equal(snapshot.ownerPasswordPending, false);
  const exported = JSON.parse(snapshot.tables.app_settings.rows[0].data_json);
  assert.deepEqual(exported.localNetworkPairedDevices, []);
  assert.equal(exported.localNetworkSharingEnabled, false);
  assert.deepEqual(exported.__loomtvSecureSettings, settings.__loomtvSecureSettings);

  // An older snapshot must not restore credentials either. JSON key order is irrelevant.
  snapshot.tables.app_settings.rows[0] = { data_json: JSON.stringify(settings), id: 1 };
  validateNativeVideoBackup(database, snapshot);
  clearNativeVideoBackupTables(database, snapshot);
  restoreNativeVideoBackup(database, snapshot);
  const restored = JSON.parse(database.prepare('SELECT data_json FROM app_settings').get().data_json);
  assert.deepEqual(restored.localNetworkPairedDevices, []);
  assert.equal(restored.localNetworkSharingEnabled, false);
  assert.deepEqual(restored.__loomtvSecureSettings, settings.__loomtvSecureSettings);
});
