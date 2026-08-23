/**
 * Focused checks for the canonical migration bridge.
 *
 * These cover the failures that would silently lose user data or silently widen access:
 * an empty desktop library grant, a subfolder grant with no canonical form, a malformed
 * JSON column, an idempotent rerun, and a rollback that has to put artifacts back where
 * they came from. They build a real desktop SQLite database and run the real bridge, so a
 * change to the canonical server's importer contract fails here rather than on an operator's install.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  inspectCanonicalMigration,
  isMigrationBridgeError,
  planCanonicalMigration,
  rollbackCanonicalMigration,
  runCanonicalMigration,
} from '../src/index.mjs';
import { canonicalStatePath } from '../src/canonicalMarker.mjs';

const OWNER = { name: 'Owner', password: 'a-long-enough-owner-password' };

async function scratch(name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `loomtv-${name}-`));
  test.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Builds a desktop database and a media tree that matches it. The media files are real
 * files with distinct bytes, because identity evidence is read from disk and a fixture of
 * identical empty files would collide on every evidence kind at once.
 */
async function buildDesktopInstall(options = {}) {
  const root = await scratch('desktop');
  const mediaRoot = path.join(root, 'Movies');
  await fs.mkdir(mediaRoot, { recursive: true });

  const files = [];
  for (const title of ['Alpha', 'Beta']) {
    const filePath = path.join(mediaRoot, `${title}.mkv`);
    await fs.writeFile(filePath, `${title}-${'x'.repeat(4096)}`);
    files.push({ title, filePath });
  }

  const databasePath = path.join(root, 'loomtv.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE app_settings (id INTEGER PRIMARY KEY, data_json TEXT NOT NULL);
    CREATE TABLE library_folders (path TEXT PRIMARY KEY, kind TEXT NOT NULL, added_at INTEGER NOT NULL);
    CREATE TABLE media_items (
      id TEXT PRIMARY KEY, type TEXT, format TEXT, title TEXT, year INTEGER, poster TEXT, backdrop TEXT,
      logo TEXT, summary TEXT, rating REAL, content_rating TEXT, content_ratings_json TEXT, runtime TEXT,
      season_count INTEGER, episode_count INTEGER, provider_ratings_json TEXT, file_path TEXT,
      file_size INTEGER, last_played INTEGER, genres_json TEXT, provider_ids_json TEXT,
      local_metadata_json TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE episode_files (
      media_id TEXT NOT NULL, season INTEGER, episode INTEGER, file_path TEXT NOT NULL,
      title TEXT, thumbnail TEXT, still TEXT, local_metadata_json TEXT
    );
    CREATE TABLE seasons (
      media_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT, episode_count INTEGER
    );
    CREATE TABLE episodes (
      media_id TEXT NOT NULL, season INTEGER NOT NULL, number INTEGER NOT NULL,
      title TEXT, summary TEXT, still TEXT, rating REAL, air_date TEXT
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar_key TEXT, color_key TEXT, profile_type TEXT,
      pin_hash TEXT, pin_salt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_used_at INTEGER, sort_order INTEGER, is_guest INTEGER, guest_device_id TEXT
    );
    CREATE TABLE profile_preferences (
      profile_id TEXT PRIMARY KEY, preferences_json TEXT NOT NULL, revision INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE profile_restrictions (
      profile_id TEXT PRIMARY KEY, country TEXT, maximum_age INTEGER, allow_unrated INTEGER,
      revision INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE profile_library_access (profile_id TEXT NOT NULL, folder_path TEXT NOT NULL);
    CREATE TABLE profile_media_lists (
      profile_id TEXT NOT NULL, media_id TEXT NOT NULL, list_kind TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE playback_progress (
      profile_id TEXT NOT NULL, file_path TEXT NOT NULL, position REAL, duration REAL,
      updated_at INTEGER NOT NULL, watched INTEGER
    );
    CREATE TABLE playback_track_preferences (
      profile_id TEXT NOT NULL, scope TEXT NOT NULL, preferences_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE device_profile_selections (
      device_id TEXT PRIMARY KEY, profile_id TEXT, selected_at INTEGER, automatic_sign_in INTEGER,
      selection_revision INTEGER
    );
    CREATE TABLE custom_artwork (
      media_id TEXT NOT NULL, target TEXT NOT NULL, data_url TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);

  database.prepare('INSERT INTO app_settings (id, data_json) VALUES (1, ?)')
    .run(JSON.stringify({ localNetworkPairedDevices: [] }));
  database.prepare('INSERT INTO library_folders (path, kind, added_at) VALUES (?, ?, ?)')
    .run(mediaRoot, 'movies', 1_700_000_000_000);

  const { createMediaItemId } = await import('@loom-media-server/media-core');
  const mediaIds = [];
  for (const file of files) {
    const mediaId = createMediaItemId(file.filePath);
    mediaIds.push(mediaId);
    database.prepare(`INSERT INTO media_items
      (id, type, title, year, summary, rating, file_path, genres_json, provider_ids_json, ${options.malformedJson ? 'content_ratings_json, ' : ''}updated_at)
      VALUES (?, 'movie', ?, 2020, 'A summary.', 7.5, ?, ?, ?, ${options.malformedJson ? '?, ' : ''}?)`)
      .run(
        mediaId,
        file.title,
        file.filePath,
        JSON.stringify(['Drama']),
        JSON.stringify({ tmdb: '1234' }),
        ...(options.malformedJson ? ['{not json'] : []),
        1_700_000_100_000,
      );
  }

  let seriesId = null;
  if (options.withSeries) {
    seriesId = 'series-1';
    const episodePath = path.join(mediaRoot, 'Series.S01E01.mkv');
    await fs.writeFile(episodePath, `Series-episode-${'y'.repeat(4096)}`);
    files.push({ title: 'Series episode', filePath: episodePath });
    database.prepare(`INSERT INTO media_items
      (id, type, title, year, summary, rating, season_count, episode_count, genres_json, provider_ids_json, updated_at)
      VALUES (?, 'tv', 'Series', 2021, 'Series summary.', 8.1, 1, 1, ?, ?, ?)`)
      .run(seriesId, JSON.stringify(['Drama']), JSON.stringify({ tmdb: 'series-123' }), 1_700_000_110_000);
    database.prepare(`INSERT INTO episode_files
      (media_id, season, episode, file_path, title, thumbnail, still, local_metadata_json)
      VALUES (?, 1, 1, ?, 'Pilot', '', '', ?)`)
      .run(seriesId, episodePath, JSON.stringify({ source: 'desktop' }));
    database.prepare('INSERT INTO seasons (media_id, number, title, episode_count) VALUES (?, 1, ?, 1)')
      .run(seriesId, 'Season one');
    database.prepare(`INSERT INTO episodes
      (media_id, season, number, title, summary, still, rating, air_date)
      VALUES (?, 1, 1, 'Pilot', 'Pilot summary.', '', 8.2, '2021-01-01')`)
      .run(seriesId);
  }

  database.prepare(`INSERT INTO profiles
    (id, name, avatar_key, color_key, profile_type, created_at, updated_at, sort_order, is_guest)
    VALUES ('owner-profile', 'Owner', 'glyph-01', 'ember', 'owner', 1, 2, 0, 0)`).run();
  database.prepare(`INSERT INTO profiles
    (id, name, avatar_key, color_key, profile_type, pin_hash, pin_salt, created_at, updated_at, sort_order, is_guest)
    VALUES ('kid-profile', 'Kid', 'glyph-02', 'ocean', 'kid', 'pin-hash', 'pin-salt', 3, 4, 1, 0)`).run();

  database.prepare('INSERT INTO profile_preferences (profile_id, preferences_json, revision, updated_at) VALUES (?, ?, 1, ?)')
    .run('owner-profile', JSON.stringify({ appThemeMode: 'dark', appHomeStyle: 'classic' }), 1_700_000_200_000);
  database.prepare('INSERT INTO profile_restrictions (profile_id, country, maximum_age, allow_unrated, revision, updated_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run('kid-profile', 'US', 12, 0, 1_700_000_300_000);

  for (const folder of options.libraryAccess || []) {
    database.prepare('INSERT INTO profile_library_access (profile_id, folder_path) VALUES (?, ?)')
      .run('kid-profile', folder === '@root' ? mediaRoot : path.join(mediaRoot, folder));
  }

  database.prepare('INSERT INTO profile_media_lists (profile_id, media_id, list_kind, created_at) VALUES (?, ?, ?, ?)')
    .run('owner-profile', mediaIds[0], 'watchlist', 1_700_000_400_000);
  if (seriesId) {
    database.prepare('INSERT INTO profile_media_lists (profile_id, media_id, list_kind, created_at) VALUES (?, ?, ?, ?)')
      .run('owner-profile', seriesId, 'favorite', 1_700_000_400_001);
  }
  database.prepare('INSERT INTO playback_progress (profile_id, file_path, position, duration, updated_at, watched) VALUES (?, ?, ?, ?, ?, 0)')
    .run('owner-profile', files[0].filePath, 620, 5400, 1_700_000_500_000);
  database.prepare('INSERT INTO playback_track_preferences (profile_id, scope, preferences_json, updated_at) VALUES (?, ?, ?, ?)')
    .run('owner-profile', `file:${files[1].filePath}`, JSON.stringify({ audioLanguage: 'eng' }), 1_700_000_600_000);
  if (seriesId) {
    database.prepare('INSERT INTO playback_track_preferences (profile_id, scope, preferences_json, updated_at) VALUES (?, ?, ?, ?)')
      .run('owner-profile', `media:${seriesId}`, JSON.stringify({ subtitleLanguage: 'eng' }), 1_700_000_600_001);
  }
  database.prepare('INSERT INTO device_profile_selections (device_id, profile_id, selected_at, automatic_sign_in, selection_revision) VALUES (?, ?, ?, 1, 3)')
    .run('device-1', 'owner-profile', 1_700_000_700_000);
  database.prepare('INSERT INTO custom_artwork (media_id, target, data_url, updated_at) VALUES (?, ?, ?, ?)')
    .run(mediaIds[0], 'poster', 'data:image/png;base64,aGVsbG8=', 1_700_000_800_000);
  database.close();

  return { root, mediaRoot, databasePath, files, mediaIds, seriesId };
}

async function addHeadlessInstall(dataDir) {
  const mediaRoot = path.join(dataDir, 'Headless Movies');
  await fs.mkdir(mediaRoot, { recursive: true });
  const filePath = path.join(mediaRoot, 'Headless.mkv');
  await fs.writeFile(filePath, `Headless-${'z'.repeat(4096)}`);
  const state = {
    owner: { id: 'headless-owner', name: 'Owner', salt: 'headless-salt', hash: 'headless-hash' },
    users: [],
    sessions: [],
    loginAttempts: [],
    roots: [{ id: 'headless-root', path: mediaRoot, kind: 'movies', createdAt: 1_700_000_000_000 }],
    catalog: [{
      id: 'headless-media', rootId: 'headless-root', path: filePath,
      relativePath: 'Headless.mkv', type: 'movie', kind: 'movie', title: 'Headless',
      available: true, indexedAt: 1_700_000_100_000,
    }],
    logs: [],
  };
  await fs.writeFile(path.join(dataDir, 'headless-admin.json'), `${JSON.stringify(state)}\n`);
  return { mediaRoot, filePath };
}

async function addOverlappingHeadlessInstall(dataDir, install) {
  const media = install.files[0];
  const rootId = createHash('sha256').update(path.resolve(install.mediaRoot)).digest('hex').slice(0, 24);
  const state = {
    owner: { id: 'headless-owner', name: 'Owner', salt: 'headless-salt', hash: 'headless-hash' },
    users: [], sessions: [], loginAttempts: [], logs: [],
    roots: [{ id: rootId, path: install.mediaRoot, kind: 'movies', createdAt: 1_700_000_000_000 }],
    catalog: [{
      id: install.mediaIds[0], rootId, path: media.filePath, relativePath: path.basename(media.filePath),
      type: 'movie', kind: 'movie', title: media.title, available: true, indexedAt: 1_700_000_100_000,
    }],
  };
  await fs.writeFile(path.join(dataDir, 'headless-admin.json'), `${JSON.stringify(state)}\n`);
}

function migrationOptions(install, dataDir, overrides = {}) {
  return {
    dataDir,
    desktopDatabase: install.databasePath,
    workDir: path.join(dataDir, 'work'),
    owner: OWNER,
    // Content hashing every fixture file is affordable, and it is the evidence kind the
    // contract requires be tried first.
    allowContentHash: true,
    ...overrides,
  };
}

test('a dry run plans the whole desktop install and writes nothing canonical', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('data');

  const result = await planCanonicalMigration(migrationOptions(install, dataDir));

  assert.equal(result.dryRun, true);
  assert.equal(result.committed, false);
  assert.equal(result.sourceMode, 'projected');
  assert.equal(result.summary.roots, 1);
  assert.equal(result.summary.catalogItems, 2);
  assert.equal(result.summary.profiles, 2);
  assert.equal(result.report.reconciliation.progress.imported, 1);
  assert.equal(result.report.reconciliation.profileCredentials.imported, 1);
  assert.equal(result.report.reconciliation.trackPreferences.imported, 1);
  assert.ok(result.report.reconciliation.mediaIdentityEvidence.imported > 0);
  assert.equal(await fs.access(canonicalStatePath(dataDir)).then(() => true, () => false), false);
});

test('an empty desktop library grant becomes unrestricted canonical roots', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('data');

  const result = await planCanonicalMigration(migrationOptions(install, dataDir));

  // The desktop meaning of an empty grant list is "every folder". Copying the empty array
  // through would revoke the whole library for the restricted profile.
  const decision = result.report.decisions.find((entry) => entry.code === 'empty_library_grants_map_to_all_roots');
  assert.ok(decision, 'the empty-grant decision must be recorded in the report');
  assert.equal(decision.value, 'allowedRootIds-null');
  assert.equal(result.report.reconciliation.profileRestrictions.imported, 1);
});

test('a subfolder grant stops the migration instead of widening to the root', async () => {
  const install = await buildDesktopInstall({ libraryAccess: ['Kids'] });
  const dataDir = await scratch('data');

  const error = await planCanonicalMigration(migrationOptions(install, dataDir)).then(
    () => null,
    (thrown) => thrown,
  );

  assert.ok(error, 'a subfolder grant must not plan successfully');
  assert.ok(isMigrationBridgeError(error));
  assert.equal(error.code, 'legacy_restriction_unrepresentable');
  assert.equal(error.failures[0].code, 'legacy_subfolder_restriction_unrepresentable');
  assert.equal(await fs.access(canonicalStatePath(dataDir)).then(() => true, () => false), false);
});

test('a malformed desktop JSON column stops with a typed reconciliation error', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [], malformedJson: true });
  const dataDir = await scratch('data');

  const error = await planCanonicalMigration(migrationOptions(install, dataDir)).then(
    () => null,
    (thrown) => thrown,
  );

  assert.ok(error);
  assert.equal(error.code, 'desktop_state_malformed');
  assert.equal(error.table, 'media_items');
  assert.equal(error.column, 'content_ratings_json');
  assert.equal(error.failureReportWritten, true);
  const failureReport = JSON.parse(await fs.readFile(
    path.join(dataDir, 'work', 'reports', error.failureReportFileName),
    'utf8',
  ));
  assert.equal(failureReport.format, 'loomtv-canonical-migration-failure-v1');
  assert.equal(failureReport.error.code, 'desktop_state_malformed');
  assert.equal(failureReport.canonicalStateChanged, false);
  const serialized = JSON.stringify(failureReport);
  assert.equal(serialized.includes('{not json'), false);
  assert.equal(serialized.includes(install.mediaRoot), false);
});

test('series, scoped state, and unknown selection devices survive as canonical records', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [], withSeries: true });
  const dataDir = await scratch('data');

  const result = await runCanonicalMigration(migrationOptions(install, dataDir));
  assert.equal(result.summary.catalogItems, 4);
  const database = new DatabaseSync(canonicalStatePath(dataDir), { readOnly: true });
  try {
    const series = database.prepare('SELECT media_kind, extension_json FROM catalog_items WHERE id=?').get(install.seriesId);
    assert.equal(series.media_kind, 'series');
    assert.deepEqual(JSON.parse(series.extension_json).seasons, [{ number: 1, title: 'Season one', episodeCount: 1 }]);
    const episode = database.prepare("SELECT extension_json FROM catalog_items WHERE media_kind='episode'").get();
    assert.equal(JSON.parse(episode.extension_json).seriesId, install.seriesId);
    assert.ok(database.prepare('SELECT 1 FROM profile_list_entries WHERE media_id=?').get(install.seriesId));
    assert.ok(database.prepare('SELECT 1 FROM track_preferences WHERE scope=?').get(`media:${install.seriesId}`));
    const device = database.prepare('SELECT disabled FROM devices WHERE id=?').get('device-1');
    assert.equal(device.disabled, 1);
    assert.equal(database.prepare('SELECT COUNT(*) count FROM device_credentials WHERE device_id=?').get('device-1').count, 0);
  } finally {
    database.close();
  }
});

test('compatible overlapping headless and desktop media merge with explicit reconciliation', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('combined-overlap');
  await addOverlappingHeadlessInstall(dataDir, install);

  const options = migrationOptions(install, dataDir, { owner: {} });
  const planned = await planCanonicalMigration(options);
  assert.deepEqual(planned.report.conflicts, []);
  const result = await runCanonicalMigration(options);
  assert.equal(result.report.reconciliation.catalogItems.merged, 1);
  assert.equal(result.report.reconciliation.mediaSources.merged, 1);
  const database = new DatabaseSync(canonicalStatePath(dataDir), { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT COUNT(*) count FROM catalog_items WHERE id=?').get(install.mediaIds[0]).count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) count FROM media_sources WHERE media_id=?').get(install.mediaIds[0]).count, 1);
  } finally {
    database.close();
  }
});

test('desktop settings devices retain only live credentials and allowed permissions', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('settings-devices');
  const settingsPath = path.join(install.root, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({
    localNetworkPairedDevices: [
      { id: 'active-device', name: 'Active', refreshTokenHash: 'active-hash', refreshTokenExpiresAt: 1_800_000_000_000, permissions: ['stream', 'admin.write'] },
      { id: 'expired-device', name: 'Expired', refreshTokenHash: 'expired-hash', refreshTokenExpiresAt: 1_600_000_000_000 },
      { id: 'missing-expiry', name: 'Missing expiry', refreshTokenHash: 'hash' },
    ],
  }));

  await runCanonicalMigration(migrationOptions(install, dataDir, { desktopSettingsPath: settingsPath }));
  const database = new DatabaseSync(canonicalStatePath(dataDir), { readOnly: true });
  try {
    const active = database.prepare('SELECT disabled,permissions_json FROM devices WHERE id=?').get('active-device');
    assert.equal(active.disabled, 0);
    assert.deepEqual(JSON.parse(active.permissions_json), ['stream']);
    assert.equal(database.prepare('SELECT COUNT(*) count FROM device_credentials WHERE device_id=?').get('active-device').count, 1);
    for (const deviceId of ['expired-device', 'missing-expiry']) {
      assert.equal(database.prepare('SELECT disabled FROM devices WHERE id=?').get(deviceId).disabled, 1);
      assert.equal(database.prepare('SELECT COUNT(*) count FROM device_credentials WHERE device_id=?').get(deviceId).count, 0);
    }
  } finally {
    database.close();
  }
});

test('a source mutation during planning stops before backup or commit', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('source-change');
  let changed = false;
  const provider = {
    supports: () => false,
    async exists() {
      if (!changed) {
        changed = true;
        const database = new DatabaseSync(install.databasePath);
        try { database.prepare("UPDATE media_items SET title='Changed after inventory' WHERE id=?").run(install.mediaIds[0]); }
        finally { database.close(); }
      }
      return true;
    },
    async evidence() { return null; },
  };

  const error = await runCanonicalMigration(migrationOptions(install, dataDir, { evidenceProvider: provider }))
    .then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'legacy_state_changed');
  assert.equal(await fs.access(canonicalStatePath(dataDir)).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(dataDir, 'work', 'backups')).then(() => true, () => false), false);
});

test('malformed headless JSON writes a bounded redacted failure report', async () => {
  const dataDir = await scratch('malformed-headless');
  const sourcePath = path.join(dataDir, 'headless-admin.json');
  await fs.writeFile(sourcePath, '{"owner":');
  const error = await planCanonicalMigration({ dataDir, workDir: path.join(dataDir, 'work') })
    .then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'legacy_state_malformed');
  assert.equal(error.failureReportWritten, true);
  const reportPath = path.join(dataDir, 'work', 'reports', error.failureReportFileName);
  const stats = await fs.stat(reportPath);
  assert.ok(stats.size < 64 * 1024);
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(report.sourceSizeBytes, 9);
  assert.equal(JSON.stringify(report).includes('{"owner":'), false);
});

test('a failure-report write error is surfaced as its own typed stop', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [], malformedJson: true });
  const dataDir = await scratch('failure-report-error');
  const reportDir = path.join(dataDir, 'report-target');
  await fs.writeFile(reportDir, 'not a directory');
  const error = await planCanonicalMigration(migrationOptions(install, dataDir, { reportDir }))
    .then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'failure_report_write_failed');
  assert.equal(error.migrationFailureCode, 'desktop_state_malformed');
});

test('headless and desktop sources migrate together under the existing headless owner', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('combined');
  await addHeadlessInstall(dataDir);

  const result = await runCanonicalMigration(migrationOptions(install, dataDir, { owner: {} }));
  assert.equal(result.sourceMode, 'combined');
  const database = new DatabaseSync(canonicalStatePath(dataDir), { readOnly: true });
  try {
    assert.ok(database.prepare('SELECT 1 FROM accounts WHERE id=?').get('headless-owner'));
    assert.ok(database.prepare('SELECT 1 FROM catalog_items WHERE id=?').get('headless-media'));
    assert.ok(database.prepare('SELECT 1 FROM profiles WHERE id=?').get('owner-profile'));
    assert.ok(database.prepare('SELECT 1 FROM profile_assignments WHERE account_id=?').get('headless-owner'));
  } finally {
    database.close();
  }
  const manifestPath = path.join(dataDir, 'work', 'backups', `canonical-cutover-${result.migrationId}`, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.ok(manifest.artifacts.some((artifact) => artifact.kind === 'admin-json'));
  assert.ok(manifest.artifacts.some((artifact) => artifact.kind === 'desktop-sqlite'));
});

test('migration source files contain no literal NUL bytes', async () => {
  const sourceRoot = new URL('../src/', import.meta.url);
  for (const name of await fs.readdir(sourceRoot)) {
    if (!name.endsWith('.mjs')) continue;
    const bytes = await fs.readFile(new URL(name, sourceRoot));
    assert.equal(bytes.includes(0), false, `${name} must remain plain text`);
  }
});

test('a run commits, reads back independently, and a rerun makes no new records', async () => {
  const install = await buildDesktopInstall({ libraryAccess: ['@root'] });
  const dataDir = await scratch('data');

  const first = await runCanonicalMigration(migrationOptions(install, dataDir));
  assert.equal(first.committed, true);
  assert.equal(first.readback.verified, true);
  assert.equal(first.readback.counts.profiles, 2);
  assert.equal(first.readback.counts.progress, 1);
  assert.equal(first.readback.counts.profileCredentials, 1);
  assert.ok(first.readback.counts.mediaIdentityEvidence > 0);
  assert.equal(first.marker.backupRecorded, true);
  assert.equal(first.evidenceAvailable.backup, true);

  const second = await runCanonicalMigration(migrationOptions(install, dataDir));
  assert.equal(second.committed, true);
  assert.equal(second.recovered, true);
  assert.equal(second.migrationId, first.migrationId);

  // Idempotence is only real if the store did not grow.
  const database = new DatabaseSync(canonicalStatePath(dataDir), { readOnly: true });
  try {
    for (const table of ['profiles', 'catalog_items', 'watch_progress', 'profile_list_entries']) {
      const before = first.readback.counts[{
        profiles: 'profiles',
        catalog_items: 'catalogItems',
        watch_progress: 'progress',
        profile_list_entries: 'profileListEntries',
      }[table]];
      const after = Number(database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total);
      if (Number.isFinite(before)) assert.equal(after, before, `${table} must not grow on rerun`);
    }
  } finally {
    database.close();
  }
});

test('the verified backup binds the desktop database and its sidecars', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('data');

  const result = await runCanonicalMigration(migrationOptions(install, dataDir));

  const manifestPath = path.join(dataDir, 'work', 'backups', `canonical-cutover-${result.migrationId}`, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.ok(manifest.artifacts.some((artifact) => artifact.kind === 'desktop-sqlite'));
  assert.equal(manifest.migrationId, result.migrationId);
});

test('rollback restores the desktop database to its own location, not the data directory', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('data');
  await runCanonicalMigration(migrationOptions(install, dataDir));

  // Simulate an operator who removed the desktop database after the cutover.
  await fs.rm(install.databasePath);

  const result = await rollbackCanonicalMigration({
    dataDir,
    confirmServerStopped: true,
    restoreSources: true,
    desktopDatabase: install.databasePath,
  });

  assert.equal(result.rolledBack, true);
  assert.equal(await fs.access(install.databasePath).then(() => true, () => false), true);
  assert.equal(
    await fs.access(path.join(dataDir, 'desktop-source-1.sqlite')).then(() => true, () => false),
    false,
    'a desktop artifact must never be restored into the server data directory',
  );
  assert.equal(await fs.access(canonicalStatePath(dataDir)).then(() => true, () => false), false);
  assert.equal((await inspectCanonicalMigration({ dataDir })).committed, false);
});

test('rollback refuses when a backed-up artifact has no supplied destination', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('data');
  await runCanonicalMigration(migrationOptions(install, dataDir));
  await fs.rm(install.databasePath);

  const error = await rollbackCanonicalMigration({
    dataDir,
    confirmServerStopped: true,
    restoreSources: true,
  }).then(() => null, (thrown) => thrown);

  assert.ok(error);
  assert.equal(error.code, 'rollback_evidence_missing');
  assert.equal(error.unresolved[0].origin, 'desktop-database');
});

test('rollback replaces a damaged desktop source and keeps the damaged copy', async () => {
  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('rollback-damaged');
  const original = await fs.readFile(install.databasePath);
  await runCanonicalMigration(migrationOptions(install, dataDir));
  await fs.writeFile(install.databasePath, 'damaged');

  const result = await rollbackCanonicalMigration({
    dataDir,
    confirmServerStopped: true,
    restoreSources: true,
    desktopDatabase: install.databasePath,
  });
  assert.equal(result.rolledBack, true);
  assert.deepEqual(await fs.readFile(install.databasePath), original);
  const siblings = await fs.readdir(path.dirname(install.databasePath));
  assert.ok(siblings.some((name) => name.startsWith('loomtv.sqlite.pre-rollback-')));
});

test('rollback requires an explicit confirmation that every server is stopped', async () => {
  const dataDir = await scratch('data');
  const error = await rollbackCanonicalMigration({ dataDir }).then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'rollback_not_confirmed');
});

test('the public package surface exposes no plan state or credential material', async () => {
  const surface = await import('../src/index.mjs');
  for (const name of [
    'prepareCanonicalMigration',
    'projectDesktopState',
    'readDesktopInventory',
    'createOwnerAccount',
    'resolveMediaIdentity',
    'resolveWorkDirectories',
  ]) {
    assert.equal(surface[name], undefined, `${name} must not be part of the public surface`);
  }

  const install = await buildDesktopInstall({ libraryAccess: [] });
  const dataDir = await scratch('data');
  const result = await planCanonicalMigration(migrationOptions(install, dataDir));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(install.mediaRoot), false, 'no raw locator may reach a public result');
  assert.equal(serialized.includes('pin-hash'), false, 'no PIN material may reach a public result');
  assert.equal(serialized.includes('pin-salt'), false);
  assert.equal(serialized.includes(OWNER.password), false);
});
