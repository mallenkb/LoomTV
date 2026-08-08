import assert from 'node:assert/strict';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { PluginSecretStore, PluginSecretStoreError } from '../src/main/pluginSecretStore.ts';

function database() {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE plugin_secret_revisions (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
    INSERT INTO plugin_secret_revisions VALUES (1, 0);
    CREATE TABLE plugin_secrets (
      ref TEXT PRIMARY KEY, addon_id TEXT NOT NULL, field_key TEXT NOT NULL,
      ciphertext TEXT NOT NULL, revision INTEGER NOT NULL, integrity_mac TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(addon_id, field_key)
    );
  `);
  return db;
}

test('PluginSecretStore issues opaque refs, monotonically revisions, and repairs tampering', () => {
  const db = database();
  const store = new PluginSecretStore(db, {
    encrypt: (value) => `cipher:${value}`,
    decrypt: (value) => value.replace(/^cipher:/, ''),
  }, Buffer.alloc(32, 7));

  const first = store.put('org.example.addon', 'apiKey', 'secret');
  assert.match(first.ref, /^loomtv-secret-v1_[A-Za-z0-9_-]{32}$/);
  assert.equal(store.get('org.example.addon', first.ref, 'apiKey'), 'secret');
  const second = store.put('org.example.addon', 'apiKey', 'next-secret');
  assert.ok(second.revision > first.revision);

  db.prepare('UPDATE plugin_secrets SET integrity_mac = ? WHERE ref = ?').run('0'.repeat(64), second.ref);
  assert.throws(
    () => store.get('org.example.addon', second.ref),
    (error) => error instanceof PluginSecretStoreError && error.code === 'PLUGIN_SECRET_INTEGRITY_FAILED',
  );
  assert.equal(store.repair('org.example.addon').removed, 1);
  db.close();
});
