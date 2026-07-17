import type BetterSqlite3 from 'better-sqlite3';

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
      scanned_at INTEGER NOT NULL
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
      type TEXT NOT NULL CHECK (type IN ('intro', 'recap', 'credits', 'preview')),
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
      type TEXT NOT NULL CHECK (type IN ('intro', 'recap', 'credits', 'preview')),
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
  `);

  migrateMediaItemArtworkColumns(database);
  ensureColumn(database, 'episode_files', 'subtitles_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'scan_cache', 'subtitle_profile', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'media_segment_candidates', 'analysis_metadata_json', 'TEXT');
  migrateArtworkCacheColumns(database);
  migrateLibraryFoldersKind(database);
  migrateMediaSegmentsPrimaryKey(database);
  makeProviderSegmentsDurable(database);
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
      type TEXT NOT NULL CHECK (type IN ('intro', 'recap', 'credits', 'preview')),
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
