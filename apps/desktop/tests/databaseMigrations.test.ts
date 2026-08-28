import assert from 'node:assert/strict';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';

import { migrateDatabase } from '../src/main/databaseMigrations.ts';

function columns(database: BetterSqlite3.Database, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

test('database migrations create the complete schema and remain idempotent', () => {
  const database = new BetterSqlite3(':memory:');
  try {
    migrateDatabase(database);
    migrateDatabase(database);

    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name));
    for (const table of [
      'media_items',
      'segment_source_cache',
      'media_segment_candidates',
      'media_segments',
      'segment_manual_history',
      'media_fingerprints',
      'media_auxiliary_fingerprints',
      'segment_analysis_state',
      'segment_analysis_jobs',
      'segment_analysis_inventory',
      'profiles',
      'profile_preferences',
      'profile_restrictions',
      'profile_library_access',
      'profile_media_lists',
      'device_profile_selections',
      'device_profile_selection_revisions',
      'stremio_addons',
      'profile_stremio_access',
      'plugin_secret_revisions',
      'plugin_secret_store_keys',
      'plugin_secrets',
      'stremio_plugin_audit',
    ]) {
      assert.equal(tables.has(table), true, `Expected ${table} to exist.`);
    }
    assert.deepEqual(
      (database.prepare('PRAGMA table_info(media_segments)').all() as Array<{ name: string; pk: number }>)
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name),
      ['file_revision', 'id'],
    );
    assert.equal(columns(database, 'media_segment_candidates').includes('analysis_metadata_json'), true);
    assert.equal(columns(database, 'segment_analysis_jobs').includes('config_hash'), true);
    assert.equal(columns(database, 'segment_analysis_inventory').includes('fingerprint_version'), true);
    assert.equal(columns(database, 'media_items').includes('content_ratings_json'), true);
    assert.equal(columns(database, 'device_profile_selections').includes('automatic_sign_in'), true);
    assert.equal(columns(database, 'device_profile_selections').includes('selection_revision'), true);
    assert.equal(columns(database, 'artwork_cache').includes('content_hash'), true);
  } finally {
    database.close();
  }
});

test('database migrations upgrade legacy columns and preserve segment rows', () => {
  const database = new BetterSqlite3(':memory:');
  try {
    database.exec(`
      CREATE TABLE library_folders (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('movies', 'tvShows', 'anime')),
        added_at INTEGER NOT NULL
      );
      INSERT INTO library_folders VALUES ('/shows', 'tvShows', 1);

      CREATE TABLE episode_files (
        media_id TEXT NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        title TEXT,
        local_metadata_json TEXT,
        PRIMARY KEY (media_id, season, episode, file_path)
      );
      CREATE TABLE scan_cache (
        folder_path TEXT PRIMARY KEY,
        version INTEGER,
        folder_kind TEXT NOT NULL,
        signature TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        item_count INTEGER NOT NULL DEFAULT 0,
        scanned_at INTEGER NOT NULL
      );
      CREATE TABLE artwork_cache (
        source_url TEXT PRIMARY KEY,
        data_url TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE media_segments (
        file_revision TEXT NOT NULL,
        type TEXT NOT NULL,
        id TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        media_duration_ms INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (file_revision, type)
      );
      INSERT INTO media_segments VALUES ('revision', 'intro', 'segment', 1000, 5000, 1, 'manual', 60000, 1);
    `);

    migrateDatabase(database);

    assert.equal(columns(database, 'episode_files').includes('subtitles_json'), true);
    assert.equal(columns(database, 'scan_cache').includes('subtitle_profile'), true);
    assert.equal(columns(database, 'artwork_cache').includes('cache_path'), true);
    assert.equal(
      (database.prepare('SELECT id FROM media_segments WHERE file_revision = ?').get('revision') as { id: string }).id,
      'segment',
    );
    database.prepare(`
      INSERT INTO media_segment_candidates (
        id, media_id, season, episode, file_path, file_revision, type, start_ms, end_ms,
        confidence, source, status, media_duration_ms, updated_at, expires_at
      ) VALUES ('provider', 'show', 1, 1, '/episode.mkv', 'revision', 'intro', 1000, 5000,
        0.9, 'theintrodb', 'active', 60000, 1, 2)
    `).run();
    migrateDatabase(database);
    assert.equal(
      (database.prepare('SELECT expires_at FROM media_segment_candidates WHERE id = ?').get('provider') as { expires_at: number | null }).expires_at,
      null,
    );
  } finally {
    database.close();
  }
});

test('the profiles migration backfills legacy viewer state onto the Owner exactly once', () => {
  const database = new BetterSqlite3(':memory:');
  database.pragma('foreign_keys = ON');
  try {
    database.exec(`
      CREATE TABLE playback_progress (
        file_path TEXT PRIMARY KEY,
        position REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        watched INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO playback_progress VALUES ('/library/a.mkv', 10, 100, 1000, 0);
      INSERT INTO playback_progress VALUES ('/library/b.mkv', 95, 100, 2000, 1);

      CREATE TABLE playback_track_preferences (
        scope TEXT PRIMARY KEY,
        preferences_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
      INSERT INTO playback_track_preferences VALUES ('show', '{"audio":{"enabled":true}}', 1000);
    `);

    migrateDatabase(database);

    const owner = database.prepare("SELECT id FROM profiles WHERE profile_type = 'owner'").get() as { id: string };
    assert.ok(owner?.id, 'an Owner profile exists after migration');

    const progressRows = database.prepare('SELECT * FROM playback_progress ORDER BY file_path').all() as Array<{ profile_id: string; file_path: string; position: number }>;
    assert.equal(progressRows.length, 2);
    assert.ok(progressRows.every((row) => row.profile_id === owner.id));
    assert.equal(progressRows[0].position, 10);

    const preferenceRows = database.prepare('SELECT * FROM playback_track_preferences').all() as Array<{ profile_id: string; scope: string }>;
    assert.deepEqual(preferenceRows.map((row) => [row.profile_id, row.scope]), [[owner.id, 'show']]);

    // The migration boot keeps the legacy tables; the next boot drops them.
    const tablesAfterFirstBoot = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    assert.equal(tablesAfterFirstBoot.has('playback_progress_legacy'), true);
    migrateDatabase(database);
    const tablesAfterSecondBoot = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    assert.equal(tablesAfterSecondBoot.has('playback_progress_legacy'), false);
    assert.equal(tablesAfterSecondBoot.has('playback_track_preferences_legacy'), false);

    // Re-running never duplicates the Owner or replays the backfill.
    const owners = database.prepare("SELECT COUNT(*) AS n FROM profiles WHERE profile_type = 'owner'").get() as { n: number };
    assert.equal(owners.n, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playback_progress').get() as { n: number }).n, 2);

    const ledger = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    assert.deepEqual(ledger.map((row) => row.version), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  } finally {
    database.close();
  }
});

test('mandatory LAN profile migration clears network selections and advances their URL revisions once', () => {
  const database = new BetterSqlite3(':memory:');
  database.pragma('foreign_keys = ON');
  try {
    migrateDatabase(database);
    const owner = database.prepare("SELECT id FROM profiles WHERE profile_type = 'owner'").get() as { id: string };
    database.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
    database.prepare(`
      INSERT INTO device_profile_selection_revisions (device_id, revision)
      VALUES ('desktop-primary', 3), ('paired-phone', 7)
    `).run();
    database.prepare(`
      INSERT INTO device_profile_selections (
        device_id, profile_id, selected_at, automatic_sign_in, selection_revision
      ) VALUES
        ('desktop-primary', ?, 1, 1, 3),
        ('paired-phone', ?, 1, 1, 7),
        ('paired-tablet', ?, 1, 1, 0)
    `).run(owner.id, owner.id, owner.id);

    migrateDatabase(database);

    const remaining = database.prepare(`
      SELECT device_id FROM device_profile_selections ORDER BY device_id
    `).all() as Array<{ device_id: string }>;
    assert.deepEqual(remaining.map(({ device_id: deviceId }) => deviceId), ['desktop-primary']);
    assert.equal(
      (database.prepare('SELECT revision FROM device_profile_selection_revisions WHERE device_id = ?').get('paired-phone') as { revision: number }).revision,
      8,
    );
    assert.equal(
      (database.prepare('SELECT revision FROM device_profile_selection_revisions WHERE device_id = ?').get('paired-tablet') as { revision: number }).revision,
      1,
    );
    assert.equal(
      (database.prepare('SELECT revision FROM device_profile_selection_revisions WHERE device_id = ?').get('desktop-primary') as { revision: number }).revision,
      3,
    );

    migrateDatabase(database);
    assert.equal(
      (database.prepare('SELECT revision FROM device_profile_selection_revisions WHERE device_id = ?').get('paired-phone') as { revision: number }).revision,
      8,
      'the one-time migration must not advance revisions again on later boots',
    );
  } finally {
    database.close();
  }
});

test('profile feature migration moves personal settings and removes abandoned Guest state', () => {
  const database = new BetterSqlite3(':memory:');
  database.pragma('foreign_keys = ON');
  try {
    database.exec(`
      CREATE TABLE playback_progress (
        file_path TEXT PRIMARY KEY,
        position REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        watched INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE playback_track_preferences (
        scope TEXT PRIMARY KEY,
        preferences_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO app_settings VALUES (
        1,
        '{"appThemeMode":"light","playbackSkipForwardSeconds":30,"localNetworkSharingEnabled":true}',
        1
      );
    `);

    migrateDatabase(database);
    const owner = database.prepare("SELECT id FROM profiles WHERE profile_type = 'owner'").get() as { id: string };
    const preferences = JSON.parse((database.prepare('SELECT preferences_json FROM profile_preferences WHERE profile_id = ?').get(owner.id) as { preferences_json: string }).preferences_json) as Record<string, unknown>;
    const settings = JSON.parse((database.prepare('SELECT data_json FROM app_settings WHERE id = 1').get() as { data_json: string }).data_json) as Record<string, unknown>;
    assert.equal(preferences.appThemeMode, 'light');
    assert.equal(preferences.playbackSkipForwardSeconds, 30);
    assert.equal(settings.appThemeMode, undefined);
    assert.equal(settings.localNetworkSharingEnabled, true);

    database.prepare(`
      INSERT INTO profiles (
        id, name, avatar_key, color_key, profile_type, created_at, updated_at,
        sort_order, is_guest, guest_device_id
      ) VALUES ('guest', 'Guest', 'weave-08', 'slate', 'standard', 1, 1, 9999, 1, 'tablet')
    `).run();
    migrateDatabase(database);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM profiles WHERE is_guest = 1').get() as { n: number }).n, 0);
  } finally {
    database.close();
  }
});
