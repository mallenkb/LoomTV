import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

// Ledger-versioned migrations begin with the profiles rebuild. The
// introspection-style migrations below predate the ledger and stay outside it.
export const PROFILES_MIGRATION_VERSION = 1;
export const PROFILE_FEATURES_MIGRATION_VERSION = 2;
export const PROFILE_SELECTION_LEDGER_MIGRATION_VERSION = 3;
export const PROFILE_GUEST_TYPE_MIGRATION_VERSION = 4;
export const PROFILE_GLYPH_AVATAR_MIGRATION_VERSION = 5;
export const PROFILE_AUTOMATIC_SIGN_IN_MIGRATION_VERSION = 6;
export const OUTRO_SEGMENT_MIGRATION_VERSION = 7;
export const STREMIO_PLUGIN_STATE_MIGRATION_VERSION = 8;
/** v9 is the transactional host secret/audit store migration. */
export const PLUGIN_SECRET_STORE_MIGRATION_VERSION = 9;
export const LAN_PROFILE_SELECTION_RESET_MIGRATION_VERSION = 10;
/** v11 binds lifecycle state, integrity metadata, and its audit ledger. */
export const STREMIO_TRUST_STATE_V2_MIGRATION_VERSION = 11;

const DESKTOP_DEVICE_ID = 'desktop-primary';

function ensureColumn(database: BetterSqlite3.Database, tableName: string, columnName: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

export function migrateDatabase(database: BetterSqlite3.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_folders (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('movies', 'tvShows', 'anime', 'others')),
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('movie', 'tv', 'anime')),
      format TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      year INTEGER NOT NULL DEFAULT 0,
      poster TEXT NOT NULL DEFAULT '',
      backdrop TEXT NOT NULL DEFAULT '',
      logo TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      rating REAL NOT NULL DEFAULT 0,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      last_played INTEGER,
      genres_json TEXT NOT NULL DEFAULT '[]',
      cast_json TEXT NOT NULL DEFAULT '[]',
      subtitles_json TEXT NOT NULL DEFAULT '[]',
      local_metadata_json TEXT,
      provider_ids_json TEXT,
      streaming_providers_json TEXT,
      poster_candidates_json TEXT NOT NULL DEFAULT '[]',
      backdrop_candidates_json TEXT NOT NULL DEFAULT '[]',
      logo_candidates_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_items_type ON media_items(type);
    CREATE INDEX IF NOT EXISTS idx_media_items_file_path ON media_items(file_path);

    CREATE TABLE IF NOT EXISTS seasons (
      media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      episode_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (media_id, number)
    );

    CREATE TABLE IF NOT EXISTS episodes (
      media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      still TEXT NOT NULL DEFAULT '',
      rating REAL NOT NULL DEFAULT 0,
      air_date TEXT NOT NULL DEFAULT '',
      local_metadata_json TEXT,
      PRIMARY KEY (media_id, season, number)
    );

    CREATE TABLE IF NOT EXISTS episode_files (
      media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      title TEXT,
      subtitles_json TEXT NOT NULL DEFAULT '[]',
      local_metadata_json TEXT,
      PRIMARY KEY (media_id, season, episode, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_episode_files_file_path ON episode_files(file_path);

    CREATE TABLE IF NOT EXISTS scan_cache (
      folder_path TEXT PRIMARY KEY,
      version INTEGER,
      folder_kind TEXT NOT NULL,
      signature TEXT NOT NULL,
      subtitle_profile TEXT NOT NULL DEFAULT '',
      file_count INTEGER NOT NULL DEFAULT 0,
      item_count INTEGER NOT NULL DEFAULT 0,
      scanned_at INTEGER NOT NULL,
      ratings_refreshed_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS playback_progress (
      file_path TEXT PRIMARY KEY,
      position REAL NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      watched INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS playback_track_preferences (
      scope TEXT PRIMARY KEY,
      preferences_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segment_source_cache (
      provider TEXT NOT NULL,
      lookup_key TEXT NOT NULL,
      duration_bucket INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'empty')),
      segments_json TEXT NOT NULL DEFAULT '[]',
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      stale_until INTEGER NOT NULL,
      PRIMARY KEY (provider, lookup_key, duration_bucket)
    );

    CREATE INDEX IF NOT EXISTS idx_segment_source_cache_expiry
      ON segment_source_cache(expires_at);

    CREATE TABLE IF NOT EXISTS media_segment_candidates (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      file_revision TEXT NOT NULL,
      release_key TEXT,
      type TEXT NOT NULL CHECK (type IN ('intro', 'recap', 'outro', 'credits', 'preview')),
      start_ms INTEGER NOT NULL,
      end_ms INTEGER,
      confidence REAL NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual', 'chapter', 'theintrodb', 'aniskip', 'chromaprint')),
      status TEXT NOT NULL CHECK (status IN ('active', 'review', 'rejected')),
      media_duration_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_media_segment_candidates_revision
      ON media_segment_candidates(file_revision, type, source);
    CREATE INDEX IF NOT EXISTS idx_media_segment_candidates_episode
      ON media_segment_candidates(media_id, season, episode, source);
    CREATE INDEX IF NOT EXISTS idx_media_segment_candidates_release
      ON media_segment_candidates(release_key, source);

    CREATE TABLE IF NOT EXISTS media_segments (
      file_revision TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('intro', 'recap', 'outro', 'credits', 'preview')),
      id TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      media_duration_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (file_revision, id)
    );

    CREATE TABLE IF NOT EXISTS segment_manual_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id TEXT NOT NULL,
      action TEXT NOT NULL,
      snapshot_json TEXT,
      changed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_fingerprints (
      file_revision TEXT NOT NULL,
      audio_track INTEGER NOT NULL,
      window_type TEXT NOT NULL CHECK (window_type IN ('intro', 'credits')),
      algorithm_version TEXT NOT NULL,
      fingerprint_json TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (file_revision, audio_track, window_type, algorithm_version)
    );

    CREATE TABLE IF NOT EXISTS segment_analysis_state (
      job_key TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      state TEXT NOT NULL,
      detail TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segment_analysis_jobs (
      job_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      media_id TEXT NOT NULL,
      season INTEGER NOT NULL DEFAULT 0,
      episode INTEGER NOT NULL DEFAULT 0,
      file_revision TEXT NOT NULL DEFAULT '',
      config_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_segment_analysis_jobs_pending
      ON segment_analysis_jobs(state, kind, created_at);

    CREATE TABLE IF NOT EXISTS segment_analysis_inventory (
      file_revision TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      config_hash TEXT NOT NULL,
      fingerprint_version TEXT NOT NULL,
      analyzed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_segment_analysis_inventory_media
      ON segment_analysis_inventory(media_id, season);

    CREATE TABLE IF NOT EXISTS media_auxiliary_fingerprints (
      file_revision TEXT NOT NULL,
      audio_track INTEGER NOT NULL,
      window_type TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      fingerprint_json TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (file_revision, audio_track, window_type, algorithm_version)
    );

    CREATE TABLE IF NOT EXISTS custom_artwork (
      media_id TEXT NOT NULL,
      target TEXT NOT NULL,
      data_url TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (media_id, target)
    );

    CREATE TABLE IF NOT EXISTS artwork_cache (
      source_url TEXT PRIMARY KEY,
      data_url TEXT NOT NULL,
      cache_path TEXT,
      mime_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plugin_artwork_objects (
      content_hash TEXT PRIMARY KEY CHECK (length(content_hash) = 64),
      cache_path TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL CHECK (mime_type = 'image/png'),
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      ref_count INTEGER NOT NULL CHECK (ref_count >= 0),
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plugin_artwork_references (
      addon_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      content_hash TEXT NOT NULL REFERENCES plugin_artwork_objects(content_hash) ON DELETE RESTRICT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (addon_id, source_url)
    );

    CREATE INDEX IF NOT EXISTS idx_plugin_artwork_references_hash
      ON plugin_artwork_references(content_hash);
    CREATE INDEX IF NOT EXISTS idx_plugin_artwork_references_addon_updated
      ON plugin_artwork_references(addon_id, updated_at);
  `);

  migrateMediaItemArtworkColumns(database);
  ensureColumn(database, 'media_items', 'format', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'episode_files', 'subtitles_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'scan_cache', 'subtitle_profile', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'scan_cache', 'ratings_refreshed_at', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'media_segment_candidates', 'analysis_metadata_json', 'TEXT');
  migrateArtworkCacheColumns(database);
  ensureColumn(database, 'artwork_cache', 'content_hash', "TEXT NOT NULL DEFAULT ''");
  migrateLibraryFoldersKind(database);
  migrateMediaSegmentsPrimaryKey(database);
  makeProviderSegmentsDurable(database);
  migrateProfiles(database);
  migrateProfileFeatures(database);
  migrateProfileMediaListsWatched(database);
  migrateProfileSelectionLedger(database);
  migrateProfileGuestType(database);
  migrateProfileGlyphAvatars(database);
  migrateProfileAutomaticSignIn(database);
  migrateOutroSegments(database);
  migrateStremioPluginState(database);
  migratePluginSecretStore(database);
  migrateStremioTrustStateV2(database);
  migrateLanProfileSelections(database);
}

function migrateStremioTrustStateV2(database: BetterSqlite3.Database): void {
  if (database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(STREMIO_TRUST_STATE_V2_MIGRATION_VERSION)) return;
  database.transaction(() => {
    ensureColumn(database, 'stremio_addons', 'record_revision', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(database, 'stremio_addons', 'integrity_mac', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(database, 'stremio_addons', 'manifest_secret_ref', 'TEXT');
    ensureColumn(database, 'stremio_addons', 'manifest_url_redacted', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(database, 'stremio_addons', 'trust_state', "TEXT NOT NULL DEFAULT 'review-required'");
    ensureColumn(database, 'stremio_addons', 'last_successful_request', 'INTEGER');
    ensureColumn(database, 'stremio_addons', 'manifest_last_checked', 'INTEGER');
    ensureColumn(database, 'stremio_plugin_audit', 'actor', "TEXT NOT NULL DEFAULT 'host:migration'");
    ensureColumn(database, 'stremio_plugin_audit', 'prior_revision', 'INTEGER');
    ensureColumn(database, 'stremio_plugin_audit', 'new_revision', 'INTEGER');
    ensureColumn(database, 'stremio_plugin_audit', 'outcome', "TEXT NOT NULL DEFAULT 'success'");
    database.exec(`
      CREATE TABLE IF NOT EXISTS stremio_plugin_state_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_version INTEGER NOT NULL CHECK (state_version = 2),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO stremio_plugin_state_metadata (id, state_version, revision, updated_at)
      VALUES (1, 2, 0, 0);
    `);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(STREMIO_TRUST_STATE_V2_MIGRATION_VERSION, Date.now());
  })();
}

function migratePluginSecretStore(database: BetterSqlite3.Database): void {
  const requiredTables = ['plugin_secret_revisions', 'plugin_secret_store_keys', 'plugin_secrets', 'stremio_plugin_audit'];
  const existingTables = new Set((database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('plugin_secret_revisions', 'plugin_secret_store_keys', 'plugin_secrets', 'stremio_plugin_audit')",
  ).all() as Array<{ name: string }>).map(({ name }) => name));
  if (requiredTables.every((table) => existingTables.has(table))) {
    database.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(PLUGIN_SECRET_STORE_MIGRATION_VERSION, Date.now());
    return;
  }
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS plugin_secret_revisions (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
      INSERT OR IGNORE INTO plugin_secret_revisions (id, revision) VALUES (1, 0);

      CREATE TABLE IF NOT EXISTS plugin_secret_store_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ciphertext TEXT NOT NULL CHECK (length(ciphertext) <= 4096),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_secrets (
        ref TEXT PRIMARY KEY CHECK (length(ref) BETWEEN 24 AND 160),
        addon_id TEXT NOT NULL REFERENCES stremio_addons(addon_id) ON DELETE CASCADE,
        field_key TEXT NOT NULL CHECK (length(field_key) BETWEEN 1 AND 128),
        ciphertext TEXT NOT NULL CHECK (length(ciphertext) <= 1048576),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        integrity_mac TEXT NOT NULL CHECK (length(integrity_mac) = 64),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (addon_id, field_key)
      );

      CREATE INDEX IF NOT EXISTS idx_plugin_secrets_addon ON plugin_secrets(addon_id);

      CREATE TABLE IF NOT EXISTS stremio_plugin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        addon_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
        detail_json TEXT NOT NULL CHECK (length(detail_json) <= 16384),
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_stremio_plugin_audit_addon
        ON stremio_plugin_audit(addon_id, id DESC);
    `);
    database.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(PLUGIN_SECRET_STORE_MIGRATION_VERSION, Date.now());
  })();
}

/**
 * Rows created before mandatory LAN profile selection have no provenance: an
 * Owner row written by the former fallback is indistinguishable from a profile
 * the user deliberately chose. Clear every network-device selection once and
 * advance its revision so previously issued profile-bound URLs are rejected.
 * The local desktop selection is explicit UI state and remains intact.
 */
function migrateLanProfileSelections(database: BetterSqlite3.Database): void {
  if (database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(LAN_PROFILE_SELECTION_RESET_MIGRATION_VERSION)) return;
  database.transaction(() => {
    const affectedDevices = database.prepare(`
      SELECT device_id
      FROM device_profile_selections
      WHERE device_id <> ?
    `).all(DESKTOP_DEVICE_ID) as Array<{ device_id: string }>;
    const advanceRevision = database.prepare(`
      INSERT INTO device_profile_selection_revisions (device_id, revision) VALUES (?, 1)
      ON CONFLICT(device_id) DO UPDATE SET revision = device_profile_selection_revisions.revision + 1
    `);
    for (const { device_id: deviceId } of affectedDevices) advanceRevision.run(deviceId);
    database.prepare('DELETE FROM device_profile_selections WHERE device_id <> ?').run(DESKTOP_DEVICE_ID);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(LAN_PROFILE_SELECTION_RESET_MIGRATION_VERSION, Date.now());
  })();
}

function migrateStremioPluginState(database: BetterSqlite3.Database): void {
  if (database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(STREMIO_PLUGIN_STATE_MIGRATION_VERSION)) return;
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS stremio_addons (
        addon_id TEXT PRIMARY KEY CHECK (length(addon_id) BETWEEN 1 AND 240),
        record_json TEXT NOT NULL CHECK (length(record_json) <= 1048576),
        state TEXT NOT NULL CHECK (state IN ('pending-review', 'enabled', 'disabled', 'broken')),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profile_stremio_access (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        addon_id TEXT NOT NULL REFERENCES stremio_addons(addon_id) ON DELETE CASCADE,
        granted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, addon_id)
      );

      CREATE INDEX IF NOT EXISTS idx_profile_stremio_access_addon
        ON profile_stremio_access(addon_id);
    `);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(STREMIO_PLUGIN_STATE_MIGRATION_VERSION, Date.now());
  })();
}

function migrateOutroSegments(database: BetterSqlite3.Database): void {
  if (database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(OUTRO_SEGMENT_MIGRATION_VERSION)) return;
  const candidatesSql = (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_segment_candidates'").get() as { sql?: string } | undefined)?.sql || '';
  const segmentsSql = (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_segments'").get() as { sql?: string } | undefined)?.sql || '';
  database.transaction(() => {
    if (!candidatesSql.includes("'outro'")) {
      database.exec(`
        ALTER TABLE media_segment_candidates RENAME TO media_segment_candidates_pre_outro;
        CREATE TABLE media_segment_candidates (
          id TEXT PRIMARY KEY,
          media_id TEXT NOT NULL,
          season INTEGER NOT NULL,
          episode INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          file_revision TEXT NOT NULL,
          release_key TEXT,
          type TEXT NOT NULL CHECK (type IN ('intro', 'recap', 'outro', 'credits', 'preview')),
          start_ms INTEGER NOT NULL,
          end_ms INTEGER,
          confidence REAL NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('manual', 'chapter', 'theintrodb', 'aniskip', 'chromaprint')),
          status TEXT NOT NULL CHECK (status IN ('active', 'review', 'rejected')),
          media_duration_ms INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER,
          analysis_metadata_json TEXT
        );
        INSERT INTO media_segment_candidates (
          id, media_id, season, episode, file_path, file_revision, release_key,
          type, start_ms, end_ms, confidence, source, status, media_duration_ms,
          updated_at, expires_at, analysis_metadata_json
        )
        SELECT
          id, media_id, season, episode, file_path, file_revision, release_key,
          CASE WHEN source = 'aniskip' AND type = 'credits' THEN 'outro' ELSE type END,
          start_ms, end_ms, confidence, source, status, media_duration_ms,
          updated_at, expires_at, analysis_metadata_json
        FROM media_segment_candidates_pre_outro;
        DROP TABLE media_segment_candidates_pre_outro;
        CREATE INDEX idx_media_segment_candidates_revision ON media_segment_candidates(file_revision, type, source);
        CREATE INDEX idx_media_segment_candidates_episode ON media_segment_candidates(media_id, season, episode, source);
        CREATE INDEX idx_media_segment_candidates_release ON media_segment_candidates(release_key, source);
      `);
    }
    if (!segmentsSql.includes("'outro'")) {
      database.exec(`
        ALTER TABLE media_segments RENAME TO media_segments_pre_outro;
        CREATE TABLE media_segments (
          file_revision TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('intro', 'recap', 'outro', 'credits', 'preview')),
          id TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER,
          confidence REAL NOT NULL,
          source TEXT NOT NULL,
          media_duration_ms INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (file_revision, id)
        );
        INSERT INTO media_segments (
          file_revision, type, id, start_ms, end_ms, confidence, source, media_duration_ms, updated_at
        )
        SELECT
          file_revision,
          CASE WHEN source = 'aniskip' AND type = 'credits' THEN 'outro' ELSE type END,
          id, start_ms, end_ms, confidence, source, media_duration_ms, updated_at
        FROM media_segments_pre_outro;
        DROP TABLE media_segments_pre_outro;
      `);
    }
    // Cached AniSkip payloads were normalized with the legacy ED -> credits
    // mapping. Force a fresh lookup using the new semantic model.
    database.prepare("DELETE FROM segment_source_cache WHERE provider = 'aniskip'").run();
    const settingsRow = database.prepare('SELECT data_json FROM app_settings WHERE id = 1').get() as { data_json: string } | undefined;
    if (settingsRow) {
      try {
        const settings = JSON.parse(settingsRow.data_json) as Record<string, unknown>;
        const skipAnalysis = settings.skipAnalysis && typeof settings.skipAnalysis === 'object'
          ? settings.skipAnalysis as Record<string, unknown>
          : {};
        const promptTypes = skipAnalysis.promptTypes && typeof skipAnalysis.promptTypes === 'object'
          ? skipAnalysis.promptTypes as Record<string, unknown>
          : {};
        settings.skipAnalysis = { ...skipAnalysis, promptTypes: { ...promptTypes, preview: true } };
        database.prepare('UPDATE app_settings SET data_json = ?, updated_at = ? WHERE id = 1')
          .run(JSON.stringify(settings), Date.now());
      } catch {
        // Leave malformed settings untouched; the regular settings loader will
        // recover them without blocking the marker schema migration.
      }
    }
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(OUTRO_SEGMENT_MIGRATION_VERSION, Date.now());
  })();
}

function migrateProfileAutomaticSignIn(database: BetterSqlite3.Database): void {
  if (database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(PROFILE_AUTOMATIC_SIGN_IN_MIGRATION_VERSION)) return;
  database.transaction(() => {
    database.exec(`
      UPDATE device_profile_selections
      SET automatic_sign_in = 1
      WHERE profile_id IN (
        SELECT id FROM profiles WHERE is_guest = 0 AND pin_hash IS NULL
      );
    `);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(PROFILE_AUTOMATIC_SIGN_IN_MIGRATION_VERSION, Date.now());
  })();
}

function migrateProfileGlyphAvatars(database: BetterSqlite3.Database): void {
  if (database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(PROFILE_GLYPH_AVATAR_MIGRATION_VERSION)) return;
  database.transaction(() => {
    database.prepare(`
      UPDATE profiles
      SET avatar_key = 'glyph-' || substr(avatar_key, -2), updated_at = ?
      WHERE avatar_key GLOB 'weave-0[1-8]'
    `).run(Date.now());
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(PROFILE_GLYPH_AVATAR_MIGRATION_VERSION, Date.now());
  })();
}

function migrateProfileGuestType(database: BetterSqlite3.Database): void {
  if (database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(PROFILE_GUEST_TYPE_MIGRATION_VERSION)) return;
  const foreignKeysEnabled = Boolean(database.pragma('foreign_keys', { simple: true }));
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE profiles_v4 (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          avatar_key TEXT NOT NULL,
          color_key TEXT NOT NULL,
          profile_type TEXT NOT NULL CHECK (profile_type IN ('owner', 'standard', 'kid', 'guest')),
          pin_hash TEXT,
          pin_salt TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_used_at INTEGER,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_guest INTEGER NOT NULL DEFAULT 0,
          guest_device_id TEXT
        );
        INSERT INTO profiles_v4 (
          id, name, avatar_key, color_key, profile_type, pin_hash, pin_salt,
          created_at, updated_at, last_used_at, sort_order, is_guest, guest_device_id
        )
        SELECT
          id, name, avatar_key, color_key,
          CASE WHEN is_guest = 1 THEN 'guest' ELSE profile_type END,
          pin_hash, pin_salt, created_at, updated_at, last_used_at, sort_order,
          is_guest, guest_device_id
        FROM profiles;
        DROP TABLE profiles;
        ALTER TABLE profiles_v4 RENAME TO profiles;
        CREATE UNIQUE INDEX one_owner ON profiles(profile_type) WHERE profile_type = 'owner';
        CREATE UNIQUE INDEX one_guest_per_device ON profiles(guest_device_id) WHERE is_guest = 1;
      `);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(PROFILE_GUEST_TYPE_MIGRATION_VERSION, Date.now());
    })();
  } finally {
    if (foreignKeysEnabled) database.pragma('foreign_keys = ON');
  }
  const violations = database.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) throw new Error('Guest profile migration aborted: foreign key check failed.');
}

function migrateProfileSelectionLedger(database: BetterSqlite3.Database): void {
  if (database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(PROFILE_SELECTION_LEDGER_MIGRATION_VERSION)) return;
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS device_profile_selection_revisions (
        device_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO device_profile_selection_revisions (device_id, revision)
      SELECT device_id, selection_revision FROM device_profile_selections;
    `);
    const settingsRow = database.prepare('SELECT data_json FROM app_settings WHERE id = 1').get() as { data_json: string } | undefined;
    const owner = database.prepare("SELECT id FROM profiles WHERE profile_type = 'owner'").get() as { id: string } | undefined;
    if (settingsRow && owner) {
      try {
        const settings = JSON.parse(settingsRow.data_json) as Record<string, unknown>;
        const keys = ['appThemeMode', 'appThemeColor', 'appDarkTheme', 'appLoaderStyle', 'sidebarNavOrder', 'playbackSkipBackSeconds', 'playbackSkipForwardSeconds'] as const;
        const row = database.prepare('SELECT preferences_json FROM profile_preferences WHERE profile_id = ?').get(owner.id) as { preferences_json: string } | undefined;
        const existing = row ? JSON.parse(row.preferences_json) as Record<string, unknown> : {};
        const legacy = Object.fromEntries(keys.flatMap((key) => settings[key] === undefined ? [] : [[key, settings[key]]]));
        database.prepare(`
          INSERT INTO profile_preferences (profile_id, preferences_json, revision, updated_at)
          VALUES (?, ?, 1, ?)
          ON CONFLICT(profile_id) DO UPDATE SET preferences_json = excluded.preferences_json, revision = profile_preferences.revision + 1, updated_at = excluded.updated_at
        `).run(owner.id, JSON.stringify({ ...legacy, ...existing }), Date.now());
        keys.forEach((key) => { delete settings[key]; });
        database.prepare('UPDATE app_settings SET data_json = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(settings), Date.now());
      } catch {
        // Invalid legacy settings retain the normal settings-loader fallback.
      }
    }
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(PROFILE_SELECTION_LEDGER_MIGRATION_VERSION, Date.now());
  })();
}

export function profilesMigrationPending(database: BetterSqlite3.Database): boolean {
  const ledger = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!ledger) return true;
  return !database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(PROFILES_MIGRATION_VERSION);
}

function migrateProfiles(database: BetterSqlite3.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  // Version 0 marks the detected pre-profile schema without replaying anything.
  database.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (0, ?)').run(Date.now());

  if (!profilesMigrationPending(database)) {
    // The legacy tables survive the migration boot so a crash before this boot
    // leaves the database recoverable; drop them once the app has come back up.
    database.exec(`
      DROP TABLE IF EXISTS playback_progress_legacy;
      DROP TABLE IF EXISTS playback_track_preferences_legacy;
    `);
    return;
  }

  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar_key TEXT NOT NULL,
        color_key TEXT NOT NULL,
        profile_type TEXT NOT NULL CHECK (profile_type IN ('owner', 'standard', 'kid')),
        pin_hash TEXT,
        pin_salt TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON profiles(profile_type)
        WHERE profile_type = 'owner';

      CREATE TABLE IF NOT EXISTS device_profile_selections (
        device_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        selected_at INTEGER NOT NULL
      );
    `);

    const owner = database.prepare("SELECT id FROM profiles WHERE profile_type = 'owner'").get() as { id: string } | undefined;
    let ownerId = owner?.id;
    if (!ownerId) {
      ownerId = randomUUID();
      const now = Date.now();
      database.prepare(`
        INSERT INTO profiles (id, name, avatar_key, color_key, profile_type, created_at, updated_at, sort_order)
        VALUES (?, 'Owner', 'weave-01', 'ember', 'owner', ?, ?, 0)
      `).run(ownerId, now, now);
    }

    database.exec(`
      CREATE TABLE playback_progress_v2 (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        position REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        watched INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, file_path)
      );

      CREATE TABLE playback_track_preferences_v2 (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        preferences_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, scope)
      );
    `);

    database.prepare(`
      INSERT INTO playback_progress_v2 (profile_id, file_path, position, duration, updated_at, watched)
      SELECT ?, file_path, position, duration, updated_at, watched FROM playback_progress
    `).run(ownerId);
    database.prepare(`
      INSERT INTO playback_track_preferences_v2 (profile_id, scope, preferences_json, updated_at)
      SELECT ?, scope, preferences_json, updated_at FROM playback_track_preferences
    `).run(ownerId);

    const countOf = (table: string): number =>
      (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    if (countOf('playback_progress') !== countOf('playback_progress_v2')) {
      throw new Error('Profile migration aborted: playback progress row counts differ.');
    }
    if (countOf('playback_track_preferences') !== countOf('playback_track_preferences_v2')) {
      throw new Error('Profile migration aborted: track preference row counts differ.');
    }

    database.exec(`
      ALTER TABLE playback_progress RENAME TO playback_progress_legacy;
      ALTER TABLE playback_progress_v2 RENAME TO playback_progress;
      ALTER TABLE playback_track_preferences RENAME TO playback_track_preferences_legacy;
      ALTER TABLE playback_track_preferences_v2 RENAME TO playback_track_preferences;
    `);

    const fkViolations = database.pragma('foreign_key_check(playback_progress)') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error('Profile migration aborted: foreign key check failed.');
    }

    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(PROFILES_MIGRATION_VERSION, Date.now());
  });
  migrate();
}

function migrateProfileFeatures(database: BetterSqlite3.Database): void {
  if (!database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(PROFILE_FEATURES_MIGRATION_VERSION)) {
    const migrate = database.transaction(() => {
      ensureColumn(database, 'profiles', 'is_guest', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(database, 'profiles', 'guest_device_id', 'TEXT');
      ensureColumn(database, 'device_profile_selections', 'automatic_sign_in', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(database, 'device_profile_selections', 'selection_revision', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(database, 'media_items', 'content_ratings_json', "TEXT NOT NULL DEFAULT '{}'");

      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS one_guest_per_device
          ON profiles(guest_device_id) WHERE is_guest = 1;

        CREATE TABLE IF NOT EXISTS profile_preferences (
          profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
          preferences_json TEXT NOT NULL DEFAULT '{}',
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profile_restrictions (
          profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
          country TEXT NOT NULL DEFAULT 'US' CHECK (country IN ('US', 'GB', 'CA', 'AU')),
          maximum_age INTEGER,
          allow_unrated INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profile_library_access (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          folder_path TEXT NOT NULL,
          PRIMARY KEY (profile_id, folder_path)
        );

        CREATE TABLE IF NOT EXISTS profile_media_lists (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          media_id TEXT NOT NULL,
          list_kind TEXT NOT NULL CHECK (list_kind IN ('watchlist', 'favorite', 'watched')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (profile_id, media_id, list_kind)
        );
      `);

      const owner = database.prepare("SELECT id FROM profiles WHERE profile_type = 'owner'").get() as { id: string } | undefined;
      const settingsRow = database.prepare('SELECT data_json FROM app_settings WHERE id = 1').get() as { data_json: string } | undefined;
      if (owner && settingsRow) {
        try {
          const settings = JSON.parse(settingsRow.data_json) as Record<string, unknown>;
          const keys = [
            'appThemeMode',
            'appThemeColor',
            'appDarkTheme',
            'appLoaderStyle',
            'sidebarNavOrder',
            'playbackSkipBackSeconds',
            'playbackSkipForwardSeconds',
          ] as const;
          const preferences = Object.fromEntries(keys.flatMap((key) => settings[key] === undefined ? [] : [[key, settings[key]]]));
          database.prepare(`
            INSERT OR IGNORE INTO profile_preferences (profile_id, preferences_json, revision, updated_at)
            VALUES (?, ?, 1, ?)
          `).run(owner.id, JSON.stringify(preferences), Date.now());
          keys.forEach((key) => { delete settings[key]; });
          database.prepare('UPDATE app_settings SET data_json = ?, updated_at = ? WHERE id = 1')
            .run(JSON.stringify(settings), Date.now());
        } catch {
          // Invalid legacy settings are ignored; the normal settings loader
          // already falls back safely and no migration data is destroyed.
        }
      }

      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(PROFILE_FEATURES_MIGRATION_VERSION, Date.now());
    });
    migrate();
  }

  // Guest data is intentionally crash-resilient only for the active boot.
  // Any abandoned guest rows from a previous process are purged on startup.
  database.prepare('DELETE FROM profiles WHERE is_guest = 1').run();
}

function migrateProfileMediaListsWatched(database: BetterSqlite3.Database): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profile_media_lists'").get() as { sql?: string } | undefined;
  if (!row || row.sql?.includes("'watched'")) return;

  const migrate = database.transaction(() => {
    database.exec(`
      ALTER TABLE profile_media_lists RENAME TO profile_media_lists_legacy;

      CREATE TABLE profile_media_lists (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL,
        list_kind TEXT NOT NULL CHECK (list_kind IN ('watchlist', 'favorite', 'watched')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, media_id, list_kind)
      );

      INSERT INTO profile_media_lists (profile_id, media_id, list_kind, created_at)
      SELECT profile_id, media_id, list_kind, created_at
      FROM profile_media_lists_legacy;

      DROP TABLE profile_media_lists_legacy;
    `);
  });
  migrate();
}

function makeProviderSegmentsDurable(database: BetterSqlite3.Database): void {
  // A provider cache expiry controls when Loom should refresh remote data; it
  // must not make a timestamp that was already matched to this exact file
  // disappear. File revisions invalidate stale matches when the media changes.
  database.prepare(`
    UPDATE media_segment_candidates
    SET expires_at = NULL
    WHERE source IN ('theintrodb', 'aniskip') AND expires_at IS NOT NULL
  `).run();
}

function migrateMediaSegmentsPrimaryKey(database: BetterSqlite3.Database): void {
  const columns = database.prepare('PRAGMA table_info(media_segments)').all() as Array<{ name: string; pk: number }>;
  const primaryKey = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  if (primaryKey.join(',') === 'file_revision,id') return;
  database.exec(`
    ALTER TABLE media_segments RENAME TO media_segments_old;

    CREATE TABLE media_segments (
      file_revision TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('intro', 'recap', 'outro', 'credits', 'preview')),
      id TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      media_duration_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (file_revision, id)
    );

    INSERT OR REPLACE INTO media_segments (
      file_revision, type, id, start_ms, end_ms, confidence, source, media_duration_ms, updated_at
    )
    SELECT file_revision, type, id, start_ms, end_ms, confidence, source, media_duration_ms, updated_at
    FROM media_segments_old;

    DROP TABLE media_segments_old;
  `);
}

function migrateMediaItemArtworkColumns(database: BetterSqlite3.Database): void {
  const columns = new Set((database.prepare('PRAGMA table_info(media_items)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has('logo')) {
    database.exec("ALTER TABLE media_items ADD COLUMN logo TEXT NOT NULL DEFAULT '';");
  }
  if (!columns.has('logo_candidates_json')) {
    database.exec("ALTER TABLE media_items ADD COLUMN logo_candidates_json TEXT NOT NULL DEFAULT '[]';");
  }
  if (!columns.has('provider_ids_json')) {
    database.exec('ALTER TABLE media_items ADD COLUMN provider_ids_json TEXT;');
  }
  if (!columns.has('streaming_providers_json')) {
    database.exec('ALTER TABLE media_items ADD COLUMN streaming_providers_json TEXT;');
  }
}

function migrateArtworkCacheColumns(database: BetterSqlite3.Database): void {
  const columns = new Set((database.prepare('PRAGMA table_info(artwork_cache)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has('cache_path')) {
    database.exec('ALTER TABLE artwork_cache ADD COLUMN cache_path TEXT;');
  }
}

function migrateLibraryFoldersKind(database: BetterSqlite3.Database): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'library_folders'").get() as { sql?: string } | undefined;
  if (row?.sql?.includes("'others'")) return;

  database.exec(`
    ALTER TABLE library_folders RENAME TO library_folders_old;

    CREATE TABLE library_folders (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('movies', 'tvShows', 'anime', 'others')),
      added_at INTEGER NOT NULL
    );

    INSERT OR REPLACE INTO library_folders (path, kind, added_at)
    SELECT
      path,
      CASE
        WHEN kind IN ('movies', 'tvShows', 'anime', 'others') THEN kind
        ELSE 'movies'
      END,
      added_at
    FROM library_folders_old;

    DROP TABLE library_folders_old;
  `);
}
