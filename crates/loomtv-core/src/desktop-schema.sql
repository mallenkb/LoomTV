-- Generated from Electron databaseMigrations.ts at e5907d2b for fresh stores.
CREATE TABLE app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE artwork_cache (
      source_url TEXT PRIMARY KEY,
      data_url TEXT NOT NULL,
      cache_path TEXT,
      mime_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    , content_hash TEXT NOT NULL DEFAULT '');

CREATE TABLE custom_artwork (
      media_id TEXT NOT NULL,
      target TEXT NOT NULL,
      data_url TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (media_id, target)
    );

CREATE TABLE device_profile_selection_revisions (
        device_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0
      );

CREATE TABLE device_profile_selections (
        device_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        selected_at INTEGER NOT NULL
      , automatic_sign_in INTEGER NOT NULL DEFAULT 0, selection_revision INTEGER NOT NULL DEFAULT 0);

CREATE TABLE episode_files (
      media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      title TEXT,
      thumbnail TEXT NOT NULL DEFAULT '',
      still TEXT NOT NULL DEFAULT '',
      subtitles_json TEXT NOT NULL DEFAULT '[]',
      local_metadata_json TEXT,
      PRIMARY KEY (media_id, season, episode, file_path)
    );

CREATE TABLE episodes (
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

CREATE TABLE iptv_channels (
        source_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        tvg_id TEXT NOT NULL DEFAULT '',
        tvg_name TEXT NOT NULL DEFAULT '',
        logo_url TEXT NOT NULL DEFAULT '',
        group_title TEXT NOT NULL DEFAULT '',
        is_geo_blocked INTEGER NOT NULL DEFAULT 0,
        stream_url TEXT NOT NULL,
        search_text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, channel_id)
      );

CREATE TABLE iptv_programmes (
        source_id TEXT NOT NULL,
        tvg_id TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, tvg_id, start_ms)
      );

CREATE TABLE iptv_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon_id TEXT NOT NULL DEFAULT 'general',
        playlist_url TEXT NOT NULL,
        epg_url TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        channel_count INTEGER NOT NULL DEFAULT 0,
        programme_count INTEGER NOT NULL DEFAULT 0,
        skipped_insecure INTEGER NOT NULL DEFAULT 0,
        skipped_malformed INTEGER NOT NULL DEFAULT 0,
        refreshed_at INTEGER NOT NULL DEFAULT 0,
        refresh_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE library_folders (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('movies', 'tvShows', 'anime', 'others')),
      added_at INTEGER NOT NULL
    );

CREATE TABLE media_auxiliary_fingerprints (
      file_revision TEXT NOT NULL,
      audio_track INTEGER NOT NULL,
      window_type TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      fingerprint_json TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (file_revision, audio_track, window_type, algorithm_version)
    );

CREATE TABLE media_fingerprints (
      file_revision TEXT NOT NULL,
      audio_track INTEGER NOT NULL,
      window_type TEXT NOT NULL CHECK (window_type IN ('intro', 'credits')),
      algorithm_version TEXT NOT NULL,
      fingerprint_json TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (file_revision, audio_track, window_type, algorithm_version)
    );

CREATE TABLE media_items (
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
      content_rating TEXT NOT NULL DEFAULT '',
      trailer_url TEXT NOT NULL DEFAULT '',
      runtime TEXT NOT NULL DEFAULT '',
      season_count INTEGER,
      episode_count INTEGER,
      provider_ratings_json TEXT NOT NULL DEFAULT '{}',
      file_path TEXT NOT NULL,
      file_size INTEGER,
      last_played INTEGER,
      genres_json TEXT NOT NULL DEFAULT '[]',
      cast_json TEXT NOT NULL DEFAULT '[]',
      subtitles_json TEXT NOT NULL DEFAULT '[]',
      local_metadata_json TEXT,
      provider_ids_json TEXT,
      streaming_providers_json TEXT,
      origin_platform_json TEXT,
      poster_candidates_json TEXT NOT NULL DEFAULT '[]',
      backdrop_candidates_json TEXT NOT NULL DEFAULT '[]',
      logo_candidates_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    , content_ratings_json TEXT NOT NULL DEFAULT '{}');

CREATE TABLE media_metadata_refresh_state (
      media_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('core', 'cast', 'artwork', 'ratings', 'episodes', 'streaming-providers')),
      refreshed_at INTEGER,
      attempted_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
      PRIMARY KEY (media_id, category)
    );

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
      expires_at INTEGER
    , analysis_metadata_json TEXT);

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

CREATE TABLE "playback_progress" (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        position REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        watched INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, file_path)
      );

CREATE TABLE "playback_progress_legacy" (
      file_path TEXT PRIMARY KEY,
      position REAL NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      watched INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE "playback_track_preferences" (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        preferences_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, scope)
      );

CREATE TABLE "playback_track_preferences_legacy" (
      scope TEXT PRIMARY KEY,
      preferences_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

CREATE TABLE plugin_artwork_objects (
      content_hash TEXT PRIMARY KEY CHECK (length(content_hash) = 64),
      cache_path TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL CHECK (mime_type = 'image/png'),
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      ref_count INTEGER NOT NULL CHECK (ref_count >= 0),
      updated_at INTEGER NOT NULL
    );

CREATE TABLE plugin_artwork_references (
      addon_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      content_hash TEXT NOT NULL REFERENCES plugin_artwork_objects(content_hash) ON DELETE RESTRICT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (addon_id, source_url)
    );

CREATE TABLE plugin_secret_revisions (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );

CREATE TABLE plugin_secret_store_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ciphertext TEXT NOT NULL CHECK (length(ciphertext) <= 4096),
        created_at INTEGER NOT NULL
      );

CREATE TABLE plugin_secrets (
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

CREATE TABLE profile_library_access (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          folder_path TEXT NOT NULL,
          PRIMARY KEY (profile_id, folder_path)
        );

CREATE TABLE profile_media_lists (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          media_id TEXT NOT NULL,
          list_kind TEXT NOT NULL CHECK (list_kind IN ('watchlist', 'favorite', 'watched')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (profile_id, media_id, list_kind)
        );

CREATE TABLE profile_preferences (
          profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
          preferences_json TEXT NOT NULL DEFAULT '{}',
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

CREATE TABLE profile_restrictions (
          profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
          country TEXT NOT NULL DEFAULT 'US' CHECK (country IN ('US', 'GB', 'CA', 'AU')),
          maximum_age INTEGER,
          allow_unrated INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

CREATE TABLE profile_stremio_access (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        addon_id TEXT NOT NULL REFERENCES stremio_addons(addon_id) ON DELETE CASCADE,
        granted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, addon_id)
      );

CREATE TABLE "profiles" (
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

CREATE TABLE scan_cache (
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

CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

CREATE TABLE seasons (
      media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      episode_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (media_id, number)
    );

CREATE TABLE segment_analysis_inventory (
      file_revision TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      config_hash TEXT NOT NULL,
      fingerprint_version TEXT NOT NULL,
      analyzed_at INTEGER NOT NULL
    );

CREATE TABLE segment_analysis_jobs (
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

CREATE TABLE segment_analysis_state (
      job_key TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      state TEXT NOT NULL,
      detail TEXT,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE segment_manual_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id TEXT NOT NULL,
      action TEXT NOT NULL,
      snapshot_json TEXT,
      changed_at INTEGER NOT NULL
    );

CREATE TABLE segment_source_cache (
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

CREATE TABLE stremio_addons (
        addon_id TEXT PRIMARY KEY CHECK (length(addon_id) BETWEEN 1 AND 240),
        record_json TEXT NOT NULL CHECK (length(record_json) <= 1048576),
        state TEXT NOT NULL CHECK (state IN ('pending-review', 'enabled', 'disabled', 'broken')),
        updated_at INTEGER NOT NULL
      , record_revision INTEGER NOT NULL DEFAULT 0, integrity_mac TEXT NOT NULL DEFAULT '', manifest_secret_ref TEXT, manifest_url_redacted TEXT NOT NULL DEFAULT '', trust_state TEXT NOT NULL DEFAULT 'review-required', last_successful_request INTEGER, manifest_last_checked INTEGER);

CREATE TABLE stremio_plugin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        addon_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
        detail_json TEXT NOT NULL CHECK (length(detail_json) <= 16384),
        created_at INTEGER NOT NULL
      , actor TEXT NOT NULL DEFAULT 'host:migration', prior_revision INTEGER, new_revision INTEGER, outcome TEXT NOT NULL DEFAULT 'success');

CREATE TABLE stremio_plugin_state_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_version INTEGER NOT NULL CHECK (state_version = 2),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        updated_at INTEGER NOT NULL
      );

CREATE TABLE thumbnail_cache (
      cache_key TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      image_bytes BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX idx_artwork_cache_updated_at
      ON artwork_cache(updated_at);

CREATE INDEX idx_episode_files_file_path ON episode_files(file_path);

CREATE INDEX idx_iptv_channels_group
        ON iptv_channels(source_id, group_title, position);

CREATE INDEX idx_iptv_channels_position
        ON iptv_channels(source_id, position);

CREATE INDEX idx_iptv_channels_tvg
        ON iptv_channels(source_id, tvg_id);

CREATE INDEX idx_iptv_programmes_window
        ON iptv_programmes(source_id, tvg_id, end_ms);

CREATE INDEX idx_media_items_file_path ON media_items(file_path);

CREATE INDEX idx_media_items_type ON media_items(type);

CREATE INDEX idx_media_segment_candidates_episode
      ON media_segment_candidates(media_id, season, episode, source);

CREATE INDEX idx_media_segment_candidates_release
      ON media_segment_candidates(release_key, source);

CREATE INDEX idx_media_segment_candidates_revision
      ON media_segment_candidates(file_revision, type, source);

CREATE INDEX idx_plugin_artwork_references_addon_updated
      ON plugin_artwork_references(addon_id, updated_at);

CREATE INDEX idx_plugin_artwork_references_hash
      ON plugin_artwork_references(content_hash);

CREATE INDEX idx_plugin_secrets_addon ON plugin_secrets(addon_id);

CREATE INDEX idx_profile_stremio_access_addon
        ON profile_stremio_access(addon_id);

CREATE INDEX idx_segment_analysis_inventory_media
      ON segment_analysis_inventory(media_id, season);

CREATE INDEX idx_segment_analysis_jobs_pending
      ON segment_analysis_jobs(state, kind, created_at);

CREATE INDEX idx_segment_source_cache_expiry
      ON segment_source_cache(expires_at);

CREATE INDEX idx_stremio_plugin_audit_addon
        ON stremio_plugin_audit(addon_id, id DESC);

CREATE INDEX idx_thumbnail_cache_updated_at
      ON thumbnail_cache(updated_at);

CREATE UNIQUE INDEX one_guest_per_device ON profiles(guest_device_id) WHERE is_guest = 1;

CREATE UNIQUE INDEX one_owner ON profiles(profile_type) WHERE profile_type = 'owner';
