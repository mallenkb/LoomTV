import assert from 'node:assert/strict';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { loadSettings, saveSettings } from '../src/main/databasePlaybackRepository.ts';
import {
  SECURE_SETTINGS_FIELD,
  SECURE_SETTINGS_RECOVERY_FIELD,
  SECRET_SETTINGS_KEYS,
  SecureSettingsCorruptError,
  SecureSettingsUnavailableError,
  createSecureSettingsPersistence,
  loadOrInitializeSettings,
  parseSettingsJson,
  readSecureSettings,
  writeSecureSettings,
  type SecureSettingsCodec,
} from '../src/main/secureSettings.ts';

function fixture() {
  const values = new Map<string, string>();
  let available = true;
  const codec: SecureSettingsCodec = {
    isEncryptionAvailable: () => available,
    encrypt: (value) => { const id = `ciphertext-${values.size}`; values.set(id, value); return id; },
    decrypt: (id) => { const value = values.get(id); if (value === undefined) throw new Error('Cannot decrypt'); return value; },
  };
  return { codec, values, lock: () => { available = false; } };
}

const secrets = {
  metadataApiKeys: { tmdb: 'provider-secret', custom: 'custom-secret' },
  tmdbApiKey: 'legacy-tmdb-secret',
  omdbApiKey: 'legacy-omdb-secret',
  openSubtitlesUsername: 'subtitle-user',
  openSubtitlesPassword: ' password with spaces ',
  localNetworkHmacSecret: 'ab'.repeat(32),
  localNetworkShareToken: '123456',
};

test('all credentials round trip without changing public fields or the input', () => {
  const { codec } = fixture();
  const original = { ...secrets, appThemeMode: 'light', extra: { keep: true } };
  const stored = writeSecureSettings(original, codec);
  for (const key of SECRET_SETTINGS_KEYS) assert.equal(Object.hasOwn(stored, key), false);
  assert.equal(JSON.stringify(stored).includes('provider-secret'), false);
  assert.deepEqual(readSecureSettings(stored, codec), { settings: original, needsMigration: false });
  assert.equal(original.openSubtitlesPassword, secrets.openSubtitlesPassword);
});

test('plaintext migration requires the secret store and never returns a plaintext fallback', () => {
  const f = fixture();
  assert.deepEqual(readSecureSettings(secrets, f.codec), { settings: secrets, needsMigration: true });
  f.lock();
  assert.throws(() => readSecureSettings(secrets, f.codec), SecureSettingsUnavailableError);
  assert.throws(() => writeSecureSettings(secrets, f.codec), SecureSettingsUnavailableError);
});

test('mixed storage keeps credentials saved by the older app and recovers missing fields', () => {
  const { codec } = fixture();
  const stored = writeSecureSettings({ tmdbApiKey: 'key' }, codec);
  assert.deepEqual(readSecureSettings({ ...stored, omdbApiKey: 'other' }, codec), {
    settings: { tmdbApiKey: 'key', omdbApiKey: 'other' }, needsMigration: true,
  });
  assert.equal(readSecureSettings({ ...stored, tmdbApiKey: 'updated-by-older-app' }, codec).settings.tmdbApiKey, 'updated-by-older-app');
});

test('legacy migration restores missing API keys without rotating the active LAN identity', () => {
  const { codec } = fixture();
  const stored = writeSecureSettings(secrets, codec);
  const result = readSecureSettings({
    ...stored,
    metadataApiKeys: { tmdb: 'new-tmdb', custom: '' },
    omdbApiKey: '',
    localNetworkHmacSecret: 'cd'.repeat(32),
    localNetworkShareToken: '654321',
  }, codec);
  assert.deepEqual(result.settings.metadataApiKeys, { tmdb: 'new-tmdb', custom: 'custom-secret' });
  assert.equal(result.settings.omdbApiKey, secrets.omdbApiKey);
  assert.equal(result.settings.localNetworkHmacSecret, 'cd'.repeat(32));
  assert.equal(result.settings.localNetworkShareToken, '654321');
});

test('mixed credential migration preserves encrypted recovery copies across subsequent saves', t => {
  const database = new BetterSqlite3(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE app_settings (id INTEGER PRIMARY KEY, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const { codec } = fixture();
  const original = writeSecureSettings(secrets, codec);
  saveSettings(database, { ...original, tmdbApiKey: 'new-legacy-key' });
  let failWrite = true;
  const persistence = createSecureSettingsPersistence({
    load: () => loadSettings(database),
    save: settings => { saveSettings(database, settings); if (failWrite) throw new Error('write failed'); },
    transaction: action => database.transaction(action)(),
  }, codec);
  const before = loadSettings(database);
  assert.throws(() => persistence.load(), /write failed/);
  assert.deepEqual(loadSettings(database), before);
  failWrite = false;
  const restored = persistence.load();
  assert.ok(restored);
  assert.equal(restored.tmdbApiKey, 'new-legacy-key');
  assert.equal(Object.hasOwn(restored, SECURE_SETTINGS_RECOVERY_FIELD), false);
  const persisted = loadSettings(database);
  assert.ok(persisted);
  const recovery = persisted[SECURE_SETTINGS_RECOVERY_FIELD] as Array<{ encrypted: unknown; legacy: unknown }>;
  assert.equal(recovery.length, 1);
  assert.deepEqual(recovery[0].encrypted, original[SECURE_SETTINGS_FIELD]);
  assert.equal(readSecureSettings({ [SECURE_SETTINGS_FIELD]: recovery[0].legacy }, codec).settings.tmdbApiKey, 'new-legacy-key');
  assert.equal(JSON.stringify(persisted).includes('new-legacy-key'), false);
  persistence.save({ theme: 'light' });
  assert.deepEqual(loadSettings(database)?.[SECURE_SETTINGS_RECOVERY_FIELD], recovery);
  assert.equal(persistence.load()?.tmdbApiKey, 'new-legacy-key');
  persistence.save({ tmdbApiKey: '' });
  assert.equal(persistence.load()?.tmdbApiKey, '');
});

test('invalid envelopes and payloads fail without returning defaults', () => {
  const { codec } = fixture();
  for (const envelope of [null, undefined, {}, { version: 2, encrypted: 'x' }, { version: 1, encrypted: '' }, { version: 1, encrypted: 'missing' }]) {
    assert.throws(() => readSecureSettings({ [SECURE_SETTINGS_FIELD]: envelope }, codec), SecureSettingsCorruptError);
  }
  for (const payload of ['null', '[]', '{', '{"unexpected":"field"}', '{"tmdbApiKey":123}']) {
    assert.throws(() => readSecureSettings({ [SECURE_SETTINGS_FIELD]: { version: 1, encrypted: codec.encrypt(payload) } }, codec), SecureSettingsCorruptError);
  }
});

test('locked encrypted settings and empty encryption output fail closed', () => {
  const f = fixture();
  const stored = writeSecureSettings(secrets, f.codec);
  assert.throws(() => writeSecureSettings(stored, f.codec), SecureSettingsCorruptError);
  assert.throws(() => writeSecureSettings(secrets, { ...f.codec, encrypt: () => '' }), SecureSettingsCorruptError);
  f.lock();
  assert.throws(() => readSecureSettings(stored, f.codec), SecureSettingsUnavailableError);
});

test('missing optional secrets remain absent instead of becoming invalid null credentials', () => {
  const { codec } = fixture();
  const stored = writeSecureSettings({ tmdbApiKey: undefined, theme: 'light' }, codec);
  assert.deepEqual(stored, { theme: 'light' });
  assert.deepEqual(readSecureSettings(stored, codec).settings, stored);
});

test('SQLite migration is atomic and failed secure writes preserve the original row', (t) => {
  const database = new BetterSqlite3(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE app_settings (id INTEGER PRIMARY KEY, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const f = fixture();
  let failWrite = false;
  const persistence = createSecureSettingsPersistence({
    load: () => loadSettings(database),
    save: (settings) => { saveSettings(database, settings); if (failWrite) throw new Error('write failed'); },
    transaction: (action) => database.transaction(action)(),
  }, f.codec);
  saveSettings(database, { ...secrets, theme: 'light' });
  const encrypt = f.codec.encrypt;
  f.codec.encrypt = () => { throw new Error('encryption failed'); };
  assert.throws(() => persistence.load(), /encryption failed/);
  assert.deepEqual(loadSettings(database), { ...secrets, theme: 'light' });
  f.codec.encrypt = encrypt;
  failWrite = true;
  assert.throws(() => persistence.load(), /write failed/);
  assert.deepEqual(loadSettings(database), { ...secrets, theme: 'light' });
  failWrite = false;
  assert.deepEqual(persistence.load(), { ...secrets, theme: 'light' });
  assert.ok(loadSettings(database)?.[SECURE_SETTINGS_FIELD]);
  persistence.save({ theme: 'dark', tmdbApiKey: undefined });
  assert.deepEqual(persistence.load(), { ...secrets, theme: 'dark' });
  const before = loadSettings(database);
  f.lock();
  assert.throws(() => persistence.save({ theme: 'light' }), SecureSettingsUnavailableError);
  assert.deepEqual(loadSettings(database), before);
});

test('corrupt SQLite settings cannot turn into an empty record', (t) => {
  const database = new BetterSqlite3(':memory:');
  t.after(() => database.close());
  database.exec("CREATE TABLE app_settings (id INTEGER PRIMARY KEY, data_json TEXT, updated_at INTEGER); INSERT INTO app_settings VALUES (1, '{broken', 0)");
  assert.throws(() => loadSettings(database));
  for (const json of ['null', '[]', '123', '"settings"']) assert.throws(() => parseSettingsJson(json));
});

test('legacy JSON write failure cannot fall through to defaults or a second save', () => {
  let normalized = 0, writes = 0;
  assert.throws(() => loadOrInitializeSettings({
    loadDatabase: () => null,
    readLegacy: () => ({ ...secrets }),
    normalize: (value) => { normalized++; assert.deepEqual(value, secrets); return value; },
    save: () => { writes++; throw new SecureSettingsUnavailableError(); },
  }), SecureSettingsUnavailableError);
  assert.equal(normalized, 1);
  assert.equal(writes, 1);
});

test('legacy read failures and invalid saved LAN credentials never reach normalization', () => {
  for (const readLegacy of [
    () => { throw new Error('read failed'); },
    () => ({ localNetworkHmacSecret: 'broken' }),
    () => ({ localNetworkShareToken: 'broken' }),
  ]) {
    let calls = 0;
    assert.throws(() => loadOrInitializeSettings({
      loadDatabase: () => null, readLegacy,
      normalize: (value) => { calls++; return value; }, save: () => { calls++; },
    }));
    assert.equal(calls, 0);
  }
});

test('existing database settings win over retained JSON and defaults require absent sources', () => {
  let reads = 0, writes = 0;
  const current = { ...secrets, localNetworkSecurityEpoch: 2 };
  assert.deepEqual(loadOrInitializeSettings({
    loadDatabase: () => current,
    readLegacy: () => { reads++; return null; },
    normalize: (value) => value, save: () => { writes++; },
  }), current);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(loadOrInitializeSettings({
    loadDatabase: () => null, readLegacy: () => null,
    normalize: (value) => value, save: () => { writes++; },
  }), {});
  assert.equal(writes, 1);
});
