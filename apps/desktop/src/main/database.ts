import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { artworkCacheFileName, collectArtworkSourcesForCache, customArtworkReference } from './artworkCache';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './metadata/types';
import { resolveCandidates } from './skipSegments/normalize';
import type {
  MediaSegment,
  MediaSegmentCandidate,
  MediaSegmentSource,
  ProviderCacheEntry,
} from './skipSegments/types';

type JsonValue = unknown;

export type StoredProgress = {
  position: number;
  duration: number;
  updatedAt: number;
  watched: boolean;
};

export type TrackPreference = {
  enabled: boolean;
  index?: number;
  language?: string;
  title?: string;
  codec?: string;
  forced?: boolean;
};

export type PlaybackTrackPreferences = {
  audio?: TrackPreference;
  subtitle?: TrackPreference;
};

type ScanCacheFolderKind = 'movies' | 'tv' | 'anime' | 'auto';

type ScanCacheEntry = {
  version?: number;
  folderKind: ScanCacheFolderKind;
  signature: string;
  subtitleProfile?: string;
  fileCount: number;
  itemCount: number;
  scannedAt: number;
};

type LibraryData = {
  movies: MediaItem[];
  tvShows: MediaItem[];
  animeShows: MediaItem[];
  libraryFolders: string[];
  libraryFolderGroups?: { movies: string[]; tvShows: string[]; anime: string[]; others: string[] };
  scanCache?: Record<string, ScanCacheEntry>;
};

type SettingsData = Record<string, unknown>;

type SeasonEntry = { number: number; title: string; episodeCount: number };

interface MediaItemRow {
  id: string;
  type: string;
  title: string;
  year: number;
  poster: string;
  backdrop: string;
  logo: string;
  summary: string;
  rating: number;
  file_path: string;
  file_size: number | null;
  last_played: number | null;
  genres_json: string | null;
  cast_json: string | null;
  subtitles_json: string | null;
  local_metadata_json: string | null;
  provider_ids_json: string | null;
  poster_candidates_json: string | null;
  backdrop_candidates_json: string | null;
  logo_candidates_json: string | null;
}

interface SeasonRow {
  media_id: string;
  number: number;
  title: string;
  episode_count: number;
}

interface EpisodeRow {
  media_id: string;
  season: number;
  number: number;
  title: string;
  summary: string;
  still: string;
  rating: number;
  air_date: string;
  local_metadata_json: string | null;
}

interface EpisodeFileRow {
  media_id: string;
  season: number;
  episode: number;
  file_path: string;
  title: string | null;
  subtitles_json: string | null;
  local_metadata_json: string | null;
}

interface ScanCacheRow {
  folder_path: string;
  version: number;
  folder_kind: string;
  signature: string;
  subtitle_profile: string | null;
  file_count: number;
  item_count: number;
  scanned_at: number;
}

interface ProgressRow {
  file_path: string;
  position: number;
  duration: number;
  updated_at: number;
  watched: number;
}

interface PlaybackTrackPreferenceRow {
  scope: string;
  preferences_json: string;
  updated_at: number;
}

let db: Database.Database | null = null;

function databasePath(): string {
  return path.join(app.getPath('userData'), 'loomtv.sqlite');
}

function artworkCacheDirectory(): string {
  return path.join(app.getPath('userData'), 'artwork-cache');
}

function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jsonString(value: JsonValue): string {
  return JSON.stringify(value ?? null);
}

function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  db = new Database(databasePath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function ensureColumn(database: Database.Database, tableName: string, columnName: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function migrate(database: Database.Database): void {
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
  migrateArtworkCacheColumns(database);
  migrateLibraryFoldersKind(database);
  migrateMediaSegmentsPrimaryKey(database);
}

function migrateMediaSegmentsPrimaryKey(database: Database.Database): void {
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

function migrateMediaItemArtworkColumns(database: Database.Database): void {
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

function migrateArtworkCacheColumns(database: Database.Database): void {
  const columns = new Set((database.prepare('PRAGMA table_info(artwork_cache)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has('cache_path')) {
    database.exec('ALTER TABLE artwork_cache ADD COLUMN cache_path TEXT;');
  }
}

function migrateLibraryFoldersKind(database: Database.Database): void {
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

function hasLibraryData(): boolean {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM media_items').get() as { count: number };
  const folders = getDb().prepare('SELECT COUNT(*) AS count FROM library_folders').get() as { count: number };
  return row.count > 0 || folders.count > 0;
}

function folderGroupsFromRows(rows: Array<{ path: string; kind: string }>) {
  const groups = { movies: [] as string[], tvShows: [] as string[], anime: [] as string[], others: [] as string[] };
  for (const row of rows) {
    if (row.kind === 'tvShows') groups.tvShows.push(row.path);
    else if (row.kind === 'anime') groups.anime.push(row.path);
    else if (row.kind === 'others') groups.others.push(row.path);
    else groups.movies.push(row.path);
  }
  return groups;
}

function flattenFolders(groups: { movies: string[]; tvShows: string[]; anime: string[]; others?: string[] }): string[] {
  return [...groups.movies, ...groups.tvShows, ...groups.anime, ...(groups.others || [])];
}

function isInlineArtworkSource(source?: string | null): boolean {
  return /^data:/i.test(source || '');
}

function durableArtworkSource(source?: string | null): string {
  return isInlineArtworkSource(source) ? '' : (source || '').trim();
}

function durableArtworkSources(sources?: string[]): string[] {
  return Array.from(new Set((sources || []).map(durableArtworkSource).filter(Boolean)));
}

function applyDurableState(item: MediaItem, progress: Map<string, StoredProgress>, custom: Map<string, Map<string, string>>): MediaItem {
  const next = { ...item };
  const itemCustom = custom.get(item.id);
  const itemProgress = progress.get(item.filePath);
  let lastPlayed = itemProgress?.updatedAt || item.lastPlayed || 0;

  next.poster = durableArtworkSource(next.poster);
  next.backdrop = durableArtworkSource(next.backdrop);
  next.logo = durableArtworkSource(next.logo);
  next.posterCandidates = durableArtworkSources(next.posterCandidates);
  next.backdropCandidates = durableArtworkSources(next.backdropCandidates);
  next.logoCandidates = durableArtworkSources(next.logoCandidates);
  next.episodes = (next.episodes || []).map((episode) => ({
    ...episode,
    still: durableArtworkSource(episode.still),
  }));

  if (Array.isArray(next.episodeFiles)) {
    for (const episodeFile of next.episodeFiles) {
      const episodeProgress = progress.get(episodeFile.filePath);
      if (episodeProgress?.updatedAt && episodeProgress.updatedAt > lastPlayed) {
        lastPlayed = episodeProgress.updatedAt;
      }
    }
  }
  if (lastPlayed) next.lastPlayed = lastPlayed;

  if (itemCustom) {
    const cover = itemCustom.get('cover');
    const poster = itemCustom.get('poster');
    const thumbnail = itemCustom.get('thumbnail');
    if (cover) {
      const coverReference = customArtworkReference(item.id, 'cover');
      next.backdrop = coverReference;
      next.backdropCandidates = [coverReference, ...(next.backdropCandidates || []).filter((source: string) => source !== coverReference)];
    }
    if (poster || thumbnail) {
      const primaryTarget = poster ? 'poster' : 'thumbnail';
      const primary = customArtworkReference(item.id, primaryTarget);
      next.poster = primary;
      next.posterCandidates = [primary, ...(next.posterCandidates || []).filter((source: string) => source !== primary)];
    }
  }

  return next;
}

export function loadLibraryFromDatabase(): LibraryData | null {
  if (!hasLibraryData()) return null;

  const database = getDb();
  const folderRows = database.prepare('SELECT path, kind FROM library_folders ORDER BY added_at ASC').all() as Array<{ path: string; kind: string }>;
  const folderGroups = folderGroupsFromRows(folderRows);
  const progress = getProgressMap();
  const custom = getCustomArtworkMap();
  const rows = database.prepare('SELECT * FROM media_items ORDER BY title COLLATE NOCASE ASC').all() as MediaItemRow[];

  const seasonsByMedia = new Map<string, SeasonEntry[]>();
  for (const row of database.prepare('SELECT * FROM seasons ORDER BY number ASC').all() as SeasonRow[]) {
    seasonsByMedia.set(row.media_id, [...(seasonsByMedia.get(row.media_id) || []), {
      number: row.number,
      title: row.title,
      episodeCount: row.episode_count,
    }]);
  }

  const episodesByMedia = new Map<string, EpisodeMeta[]>();
  for (const row of database.prepare('SELECT * FROM episodes ORDER BY season ASC, number ASC').all() as EpisodeRow[]) {
    episodesByMedia.set(row.media_id, [...(episodesByMedia.get(row.media_id) || []), {
      season: row.season,
      number: row.number,
      title: row.title,
      summary: row.summary,
      still: row.still,
      rating: row.rating,
      airDate: row.air_date,
      localMetadata: jsonParse(row.local_metadata_json, undefined),
    }]);
  }

  const episodeFilesByMedia = new Map<string, EpisodeFile[]>();
  for (const row of database.prepare('SELECT * FROM episode_files ORDER BY season ASC, episode ASC').all() as EpisodeFileRow[]) {
    episodeFilesByMedia.set(row.media_id, [...(episodeFilesByMedia.get(row.media_id) || []), {
      season: row.season,
      episode: row.episode,
      filePath: row.file_path,
      title: row.title || undefined,
      subtitles: jsonParse(row.subtitles_json, []),
      localMetadata: jsonParse(row.local_metadata_json, undefined),
    }]);
  }

  const scanCache = Object.fromEntries((database.prepare('SELECT * FROM scan_cache').all() as ScanCacheRow[]).map((row): [string, ScanCacheEntry] => [
    row.folder_path,
    {
      version: row.version,
      folderKind: row.folder_kind as ScanCacheFolderKind,
      signature: row.signature,
      subtitleProfile: row.subtitle_profile || '',
      fileCount: row.file_count,
      itemCount: row.item_count,
      scannedAt: row.scanned_at,
    },
  ]));

  const data: LibraryData = {
    movies: [],
    tvShows: [],
    animeShows: [],
    libraryFolders: flattenFolders(folderGroups),
    libraryFolderGroups: folderGroups,
    scanCache,
  };

  for (const row of rows) {
    const item = applyDurableState({
      id: row.id,
      type: row.type as MediaItem['type'],
      title: row.title,
      year: row.year,
      poster: row.poster,
      backdrop: row.backdrop,
      logo: row.logo,
      posterCandidates: jsonParse(row.poster_candidates_json, []),
      backdropCandidates: jsonParse(row.backdrop_candidates_json, []),
      logoCandidates: jsonParse(row.logo_candidates_json, []),
      summary: row.summary,
      rating: row.rating,
      genres: jsonParse(row.genres_json, []),
      cast: jsonParse(row.cast_json, []),
      filePath: row.file_path,
      fileSize: row.file_size || undefined,
      lastPlayed: row.last_played || undefined,
      subtitles: jsonParse(row.subtitles_json, []),
      localMetadata: jsonParse(row.local_metadata_json, undefined),
      providerIds: jsonParse(row.provider_ids_json, undefined),
      seasons: seasonsByMedia.get(row.id) || undefined,
      episodes: episodesByMedia.get(row.id) || undefined,
      episodeFiles: episodeFilesByMedia.get(row.id) || undefined,
    }, progress, custom);

    if (item.type === 'movie') data.movies.push(item);
    else if (item.type === 'anime') data.animeShows.push(item);
    else data.tvShows.push(item);
  }

  return data;
}

export function saveLibraryToDatabase(data: LibraryData): void {
  const database = getDb();
  const now = Date.now();
  const folderGroups = data.libraryFolderGroups || { movies: [], tvShows: [], anime: [], others: [] };
  const tx = database.transaction(() => {
    database.exec('DELETE FROM episode_files; DELETE FROM episodes; DELETE FROM seasons; DELETE FROM media_items; DELETE FROM library_folders; DELETE FROM scan_cache;');

    const insertFolder = database.prepare('INSERT OR REPLACE INTO library_folders (path, kind, added_at) VALUES (?, ?, ?)');
    for (const folder of folderGroups.movies || []) insertFolder.run(folder, 'movies', now);
    for (const folder of folderGroups.tvShows || []) insertFolder.run(folder, 'tvShows', now);
    for (const folder of folderGroups.anime || []) insertFolder.run(folder, 'anime', now);
    for (const folder of folderGroups.others || []) insertFolder.run(folder, 'others', now);

    const insertItem = database.prepare(`
      INSERT OR REPLACE INTO media_items (
        id, type, title, year, poster, backdrop, logo, summary, rating, file_path, file_size, last_played,
        genres_json, cast_json, subtitles_json, local_metadata_json, provider_ids_json, poster_candidates_json, backdrop_candidates_json, logo_candidates_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSeason = database.prepare('INSERT OR REPLACE INTO seasons (media_id, number, title, episode_count) VALUES (?, ?, ?, ?)');
    const insertEpisode = database.prepare(`
      INSERT OR REPLACE INTO episodes (media_id, season, number, title, summary, still, rating, air_date, local_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEpisodeFile = database.prepare(`
      INSERT OR REPLACE INTO episode_files (media_id, season, episode, file_path, title, subtitles_json, local_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of [...(data.movies || []), ...(data.tvShows || []), ...(data.animeShows || [])]) {
      insertItem.run(
        item.id,
        item.type,
        item.title || '',
        item.year || 0,
        durableArtworkSource(item.poster),
        durableArtworkSource(item.backdrop),
        durableArtworkSource(item.logo),
        item.summary || '',
        item.rating || 0,
        item.filePath || '',
        item.fileSize || null,
        item.lastPlayed || null,
        jsonString(item.genres || []),
        jsonString(item.cast || []),
        jsonString(item.subtitles || []),
        item.localMetadata ? jsonString(item.localMetadata) : null,
        item.providerIds ? jsonString(item.providerIds) : null,
        jsonString(durableArtworkSources(item.posterCandidates || [])),
        jsonString(durableArtworkSources(item.backdropCandidates || [])),
        jsonString(durableArtworkSources(item.logoCandidates || [])),
        now,
      );

      for (const season of item.seasons || []) {
        insertSeason.run(item.id, season.number, season.title || '', season.episodeCount || 0);
      }
      for (const episode of item.episodes || []) {
        insertEpisode.run(
          item.id,
          episode.season,
          episode.number,
          episode.title || '',
          episode.summary || '',
          durableArtworkSource(episode.still),
          episode.rating || 0,
          episode.airDate || '',
          episode.localMetadata ? jsonString(episode.localMetadata) : null,
        );
      }
      for (const episodeFile of item.episodeFiles || []) {
        insertEpisodeFile.run(
          item.id,
          episodeFile.season,
          episodeFile.episode,
          episodeFile.filePath,
          episodeFile.title || null,
          jsonString(episodeFile.subtitles || []),
          episodeFile.localMetadata ? jsonString(episodeFile.localMetadata) : null,
        );
      }
    }

    const insertScanCache = database.prepare(`
      INSERT OR REPLACE INTO scan_cache (folder_path, version, folder_kind, signature, subtitle_profile, file_count, item_count, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [folder, entry] of Object.entries(data.scanCache || {})) {
      insertScanCache.run(
        folder,
        entry.version || null,
        entry.folderKind || '',
        entry.signature || '',
        entry.subtitleProfile || '',
        entry.fileCount || 0,
        entry.itemCount || 0,
        entry.scannedAt || now,
      );
    }
  });
  tx();
}

export function loadSettingsFromDatabase(): SettingsData | null {
  const row = getDb().prepare('SELECT data_json FROM app_settings WHERE id = 1').get() as { data_json: string } | undefined;
  return row ? jsonParse(row.data_json, {}) : null;
}

export function saveSettingsToDatabase(settings: SettingsData): void {
  getDb().prepare('INSERT OR REPLACE INTO app_settings (id, data_json, updated_at) VALUES (1, ?, ?)').run(jsonString(settings), Date.now());
}

export function getProgress(filePath: string): StoredProgress | null {
  const row = getDb().prepare('SELECT * FROM playback_progress WHERE file_path = ?').get(filePath) as ProgressRow | undefined;
  if (!row) return null;
  return { position: row.position, duration: row.duration, updatedAt: row.updated_at, watched: Boolean(row.watched) };
}

export function getAllProgress(): Record<string, StoredProgress> {
  return Object.fromEntries((getDb().prepare('SELECT * FROM playback_progress').all() as ProgressRow[]).map((row): [string, StoredProgress] => [
    row.file_path,
    { position: row.position, duration: row.duration, updatedAt: row.updated_at, watched: Boolean(row.watched) },
  ]));
}

function normalizeTrackPreference(value: unknown): TrackPreference | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const preference = value as TrackPreference;
  return {
    enabled: Boolean(preference.enabled),
    ...(typeof preference.index === 'number' && Number.isFinite(preference.index) ? { index: preference.index } : {}),
    ...(typeof preference.language === 'string' ? { language: preference.language.trim().toLowerCase() } : {}),
    ...(typeof preference.title === 'string' ? { title: preference.title.trim().toLowerCase() } : {}),
    ...(typeof preference.codec === 'string' ? { codec: preference.codec.trim().toLowerCase() } : {}),
    ...(typeof preference.forced === 'boolean' ? { forced: preference.forced } : {}),
  };
}

function normalizeTrackPreferences(value: unknown): PlaybackTrackPreferences {
  const preferences = value && typeof value === 'object' ? value as PlaybackTrackPreferences : {};
  return {
    ...(preferences.audio ? { audio: normalizeTrackPreference(preferences.audio) } : {}),
    ...(preferences.subtitle ? { subtitle: normalizeTrackPreference(preferences.subtitle) } : {}),
  };
}

export function getPlaybackTrackPreferences(scope?: string): PlaybackTrackPreferences | Record<string, PlaybackTrackPreferences> {
  if (scope) {
    const row = getDb().prepare('SELECT preferences_json FROM playback_track_preferences WHERE scope = ?').get(scope) as Pick<PlaybackTrackPreferenceRow, 'preferences_json'> | undefined;
    return row ? normalizeTrackPreferences(jsonParse(row.preferences_json, {})) : {};
  }

  return Object.fromEntries((getDb().prepare('SELECT * FROM playback_track_preferences').all() as PlaybackTrackPreferenceRow[])
    .map((row): [string, PlaybackTrackPreferences] => [row.scope, normalizeTrackPreferences(jsonParse(row.preferences_json, {}))]));
}

export function savePlaybackTrackPreferences(scope: string, preferences: PlaybackTrackPreferences): PlaybackTrackPreferences {
  const safeScope = String(scope || '').trim();
  if (!safeScope) return {};
  const stored = normalizeTrackPreferences(preferences);
  getDb().prepare(`
    INSERT OR REPLACE INTO playback_track_preferences (scope, preferences_json, updated_at)
    VALUES (?, ?, ?)
  `).run(safeScope, jsonString(stored), Date.now());
  return stored;
}

type SegmentCandidateRow = {
  id: string;
  media_id: string;
  season: number;
  episode: number;
  file_path: string;
  file_revision: string;
  release_key: string | null;
  type: MediaSegmentCandidate['type'];
  start_ms: number;
  end_ms: number | null;
  confidence: number;
  source: MediaSegmentCandidate['source'];
  status: MediaSegmentCandidate['status'];
  media_duration_ms: number;
  updated_at: number;
  expires_at: number | null;
};

function candidateFromRow(row: SegmentCandidateRow): MediaSegmentCandidate {
  return {
    id: row.id,
    mediaId: row.media_id,
    season: row.season,
    episode: row.episode,
    filePath: row.file_path,
    fileRevision: row.file_revision,
    releaseKey: row.release_key || undefined,
    type: row.type,
    startMs: row.start_ms,
    endMs: row.end_ms,
    confidence: row.confidence,
    source: row.source,
    status: row.status,
    mediaDurationMs: row.media_duration_ms,
    updatedAt: new Date(row.updated_at).toISOString(),
    expiresAt: row.expires_at || undefined,
  };
}

function insertSegmentCandidate(database: Database.Database, candidate: MediaSegmentCandidate): void {
  database.prepare(`
    INSERT OR REPLACE INTO media_segment_candidates (
      id, media_id, season, episode, file_path, file_revision, release_key,
      type, start_ms, end_ms, confidence, source, status, media_duration_ms,
      updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.id,
    candidate.mediaId,
    candidate.season,
    candidate.episode,
    candidate.filePath,
    candidate.fileRevision,
    candidate.releaseKey || null,
    candidate.type,
    candidate.startMs,
    candidate.endMs,
    candidate.confidence,
    candidate.source,
    candidate.status,
    candidate.mediaDurationMs,
    Date.parse(candidate.updatedAt) || Date.now(),
    candidate.expiresAt || null,
  );
}

export function getSegmentSourceCache(
  provider: ProviderCacheEntry['provider'],
  lookupKey: string,
  durationBucket: number,
): ProviderCacheEntry | null {
  const row = getDb().prepare(`
    SELECT provider, lookup_key, duration_bucket, status, segments_json, fetched_at, expires_at, stale_until
    FROM segment_source_cache
    WHERE provider = ? AND lookup_key = ? AND duration_bucket = ?
  `).get(provider, lookupKey, durationBucket) as {
    provider: ProviderCacheEntry['provider'];
    lookup_key: string;
    duration_bucket: number;
    status: ProviderCacheEntry['status'];
    segments_json: string;
    fetched_at: number;
    expires_at: number;
    stale_until: number;
  } | undefined;
  if (!row) return null;
  return {
    provider: row.provider,
    lookupKey: row.lookup_key,
    durationBucket: row.duration_bucket,
    status: row.status,
    segments: jsonParse(row.segments_json, []),
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    staleUntil: row.stale_until,
  };
}

export function saveSegmentSourceCache(entry: ProviderCacheEntry): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO segment_source_cache (
      provider, lookup_key, duration_bucket, status, segments_json, fetched_at, expires_at, stale_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.provider,
    entry.lookupKey,
    entry.durationBucket,
    entry.status,
    jsonString(entry.segments),
    entry.fetchedAt,
    entry.expiresAt,
    entry.staleUntil,
  );
}

export function getSegmentCandidates(fileRevision: string): MediaSegmentCandidate[] {
  const rows = getDb().prepare(`
    SELECT * FROM media_segment_candidates
    WHERE file_revision = ? AND (expires_at IS NULL OR expires_at > ?)
  `).all(fileRevision, Date.now()) as SegmentCandidateRow[];
  return rows.map(candidateFromRow);
}

export function getManualSegmentCandidates(mediaId: string, season: number, episode: number): MediaSegmentCandidate[] {
  const rows = getDb().prepare(`
    SELECT * FROM media_segment_candidates
    WHERE media_id = ? AND season = ? AND episode = ? AND source = 'manual'
  `).all(mediaId, season, episode) as SegmentCandidateRow[];
  return rows.map(candidateFromRow);
}

export function replaceSegmentCandidatesForSource(
  fileRevision: string,
  source: Exclude<MediaSegmentSource, 'manual'>,
  candidates: MediaSegmentCandidate[],
): MediaSegment[] {
  const database = getDb();
  const existing = (database.prepare(`
    SELECT * FROM media_segment_candidates WHERE file_revision = ? AND source = ?
  `).all(fileRevision, source) as SegmentCandidateRow[]).map(candidateFromRow);
  const comparable = (candidate: MediaSegmentCandidate) => JSON.stringify({
    id: candidate.id,
    mediaId: candidate.mediaId,
    season: candidate.season,
    episode: candidate.episode,
    filePath: candidate.filePath,
    fileRevision: candidate.fileRevision,
    releaseKey: candidate.releaseKey || null,
    type: candidate.type,
    startMs: candidate.startMs,
    endMs: candidate.endMs,
    confidence: candidate.confidence,
    source: candidate.source,
    status: candidate.status,
    mediaDurationMs: candidate.mediaDurationMs,
    expiresAt: candidate.expiresAt || null,
  });
  if (existing.length === candidates.length
    && existing.map(comparable).sort().join('\n') === candidates.map(comparable).sort().join('\n')) {
    return getResolvedMediaSegments(fileRevision);
  }
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM media_segment_candidates WHERE file_revision = ? AND source = ?').run(fileRevision, source);
    for (const candidate of candidates) insertSegmentCandidate(database, candidate);
    return refreshResolvedSegments(fileRevision, database);
  });
  return tx();
}

export function saveManualSegmentCandidate(candidate: MediaSegmentCandidate): MediaSegment[] {
  const database = getDb();
  const tx = database.transaction(() => {
    const existing = database.prepare(`
      SELECT * FROM media_segment_candidates
      WHERE file_revision = ? AND type = ? AND source = 'manual'
    `).all(candidate.fileRevision, candidate.type) as SegmentCandidateRow[];
    for (const row of existing) {
      database.prepare(`
        INSERT INTO segment_manual_history (candidate_id, action, snapshot_json, changed_at)
        VALUES (?, 'replace', ?, ?)
      `).run(row.id, jsonString(candidateFromRow(row)), Date.now());
      database.prepare('DELETE FROM media_segment_candidates WHERE id = ?').run(row.id);
      if (row.file_revision !== candidate.fileRevision) refreshResolvedSegments(row.file_revision, database);
    }
    insertSegmentCandidate(database, candidate);
    return refreshResolvedSegments(candidate.fileRevision, database);
  });
  return tx();
}

export function deleteManualSegmentCandidate(
  fileRevision: string,
  type: MediaSegmentCandidate['type'],
): MediaSegment[] {
  const database = getDb();
  const tx = database.transaction(() => {
    const rows = database.prepare(`
      SELECT * FROM media_segment_candidates
      WHERE file_revision = ? AND type = ? AND source = 'manual'
    `).all(fileRevision, type) as SegmentCandidateRow[];
    const revisions = new Set(rows.map((row) => row.file_revision));
    for (const row of rows) {
      database.prepare(`
        INSERT INTO segment_manual_history (candidate_id, action, snapshot_json, changed_at)
        VALUES (?, 'delete', ?, ?)
      `).run(row.id, jsonString(candidateFromRow(row)), Date.now());
      database.prepare('DELETE FROM media_segment_candidates WHERE id = ?').run(row.id);
    }
    let resolved: MediaSegment[] = [];
    for (const revision of revisions) resolved = refreshResolvedSegments(revision, database);
    return resolved;
  });
  return tx();
}

export function undoManualSegmentCandidate(
  fileRevision: string,
  type: MediaSegmentCandidate['type'],
): MediaSegment[] {
  const database = getDb();
  const tx = database.transaction(() => {
    const history = database.prepare(`
      SELECT history_id, snapshot_json FROM segment_manual_history
      WHERE snapshot_json IS NOT NULL ORDER BY changed_at DESC, history_id DESC LIMIT 200
    `).all() as Array<{ history_id: number; snapshot_json: string }>;
    const match = history.map((row) => ({
      row,
      candidate: jsonParse<MediaSegmentCandidate | null>(row.snapshot_json, null),
    })).find(({ candidate }) => candidate?.fileRevision === fileRevision && candidate.type === type && candidate.source === 'manual');
    if (!match?.candidate) return getResolvedMediaSegments(fileRevision);
    database.prepare(`DELETE FROM media_segment_candidates WHERE file_revision = ? AND type = ? AND source = 'manual'`).run(fileRevision, type);
    insertSegmentCandidate(database, { ...match.candidate, updatedAt: new Date().toISOString() });
    database.prepare('DELETE FROM segment_manual_history WHERE history_id = ?').run(match.row.history_id);
    return refreshResolvedSegments(fileRevision, database);
  });
  return tx();
}

export function reassociateManualSegmentCandidate(
  candidateId: string,
  fileRevision: string,
  filePath: string,
): MediaSegment[] {
  const database = getDb();
  const tx = database.transaction(() => {
    database.prepare(`
      UPDATE media_segment_candidates SET file_revision = ?, file_path = ?, updated_at = ?
      WHERE id = ? AND source = 'manual'
    `).run(fileRevision, filePath, Date.now(), candidateId);
    return refreshResolvedSegments(fileRevision, database);
  });
  return tx();
}

export function markManualSegmentCandidateForReview(candidateId: string): void {
  getDb().prepare(`
    UPDATE media_segment_candidates SET status = 'review', updated_at = ?
    WHERE id = ? AND source = 'manual' AND status != 'review'
  `).run(Date.now(), candidateId);
}

function refreshResolvedSegments(fileRevision: string, database = getDb()): MediaSegment[] {
  const candidates = (database.prepare(`
    SELECT * FROM media_segment_candidates
    WHERE file_revision = ? AND (expires_at IS NULL OR expires_at > ?)
  `).all(fileRevision, Date.now()) as SegmentCandidateRow[]).map(candidateFromRow);
  const segments = resolveCandidates(candidates);
  database.prepare('DELETE FROM media_segments WHERE file_revision = ?').run(fileRevision);
  const insert = database.prepare(`
    INSERT INTO media_segments (
      file_revision, type, id, start_ms, end_ms, confidence, source,
      media_duration_ms, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const segment of segments) {
    insert.run(
      fileRevision,
      segment.type,
      segment.id,
      segment.startMs,
      segment.endMs,
      segment.confidence,
      segment.source,
      segment.mediaDurationMs,
      Date.parse(segment.updatedAt) || Date.now(),
    );
  }
  return segments;
}

export function getResolvedMediaSegments(fileRevision: string): MediaSegment[] {
  return resolveCandidates(getSegmentCandidates(fileRevision));
}

export type StoredMediaFingerprint = {
  fileRevision: string;
  audioTrack: number;
  windowType: 'intro' | 'credits';
  algorithmVersion: string;
  fingerprintJson: string;
  durationMs: number;
  updatedAt: number;
};

export function getMediaFingerprint(
  fileRevision: string,
  audioTrack: number,
  windowType: StoredMediaFingerprint['windowType'],
  algorithmVersion: string,
): StoredMediaFingerprint | null {
  const row = getDb().prepare(`
    SELECT file_revision, audio_track, window_type, algorithm_version, fingerprint_json, duration_ms, updated_at
    FROM media_fingerprints
    WHERE file_revision = ? AND audio_track = ? AND window_type = ? AND algorithm_version = ?
  `).get(fileRevision, audioTrack, windowType, algorithmVersion) as {
    file_revision: string; audio_track: number; window_type: StoredMediaFingerprint['windowType'];
    algorithm_version: string; fingerprint_json: string; duration_ms: number; updated_at: number;
  } | undefined;
  return row ? {
    fileRevision: row.file_revision,
    audioTrack: row.audio_track,
    windowType: row.window_type,
    algorithmVersion: row.algorithm_version,
    fingerprintJson: row.fingerprint_json,
    durationMs: row.duration_ms,
    updatedAt: row.updated_at,
  } : null;
}

export function saveMediaFingerprint(value: StoredMediaFingerprint): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO media_fingerprints (
      file_revision, audio_track, window_type, algorithm_version, fingerprint_json, duration_ms, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.fileRevision,
    value.audioTrack,
    value.windowType,
    value.algorithmVersion,
    value.fingerprintJson,
    value.durationMs,
    value.updatedAt,
  );
}

export function saveSegmentAnalysisState(
  jobKey: string,
  mediaId: string,
  season: number,
  state: string,
  detail = '',
): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO segment_analysis_state (job_key, media_id, season, state, detail, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(jobKey, mediaId, season, state, detail, Date.now());
}

export function getSegmentAnalysisStates(mediaId?: string): Array<{
  jobKey: string; mediaId: string; season: number; state: string; detail: string; updatedAt: number;
}> {
  const rows = (mediaId
    ? getDb().prepare('SELECT * FROM segment_analysis_state WHERE media_id = ? ORDER BY updated_at DESC').all(mediaId)
    : getDb().prepare('SELECT * FROM segment_analysis_state ORDER BY updated_at DESC').all()) as Array<{
      job_key: string; media_id: string; season: number; state: string; detail: string; updated_at: number;
    }>;
  return rows.map((row) => ({
    jobKey: row.job_key,
    mediaId: row.media_id,
    season: row.season,
    state: row.state,
    detail: row.detail,
    updatedAt: row.updated_at,
  }));
}

export function cleanupOrphanedAutomaticSegments(limit = 250): number {
  const database = getDb();
  const rows = database.prepare(`
    SELECT id, file_revision FROM media_segment_candidates
    WHERE source != 'manual'
      AND file_path NOT IN (SELECT file_path FROM episode_files)
    LIMIT ?
  `).all(Math.max(1, Math.min(1000, limit))) as Array<{ id: string; file_revision: string }>;
  if (!rows.length) return 0;
  const tx = database.transaction(() => {
    const remove = database.prepare('DELETE FROM media_segment_candidates WHERE id = ?');
    for (const row of rows) remove.run(row.id);
    for (const revision of new Set(rows.map((row) => row.file_revision))) refreshResolvedSegments(revision, database);
  });
  tx();
  return rows.length;
}

export function saveProgress(filePath: string, position: number, duration: number): StoredProgress {
  const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const watched = safeDuration > 0 && safePosition / safeDuration >= 0.9;
  const stored: StoredProgress = {
    position: watched ? safeDuration : safePosition,
    duration: safeDuration,
    updatedAt: Date.now(),
    watched,
  };
  getDb().prepare(`
    INSERT OR REPLACE INTO playback_progress (file_path, position, duration, updated_at, watched)
    VALUES (?, ?, ?, ?, ?)
  `).run(filePath, stored.position, stored.duration, stored.updatedAt, stored.watched ? 1 : 0);
  return stored;
}

export function importProgress(progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>): void {
  const tx = getDb().transaction(() => {
    for (const [filePath, value] of Object.entries(progress || {})) {
      const position = typeof value === 'number' ? value : Number(value.position || 0);
      const duration = typeof value === 'object' ? Number(value.duration || 0) : 0;
      const updatedAt = typeof value === 'object' && value.updatedAt ? Number(value.updatedAt) : Date.now();
      const watched = duration > 0 && position / duration >= 0.9;
      getDb().prepare(`
        INSERT OR REPLACE INTO playback_progress (file_path, position, duration, updated_at, watched)
        VALUES (?, ?, ?, ?, ?)
      `).run(filePath, watched ? duration : position, duration, updatedAt, watched ? 1 : 0);
    }
  });
  tx();
}

export function saveCustomArtwork(mediaId: string, target: string, dataUrl: string): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO custom_artwork (media_id, target, data_url, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(mediaId, target, dataUrl, Date.now());
}

export function getCustomArtwork(mediaId: string): Record<string, string> {
  return Object.fromEntries((getDb().prepare('SELECT target, data_url FROM custom_artwork WHERE media_id = ?').all(mediaId) as Array<{ target: string; data_url: string }>)
    .map((row): [string, string] => [row.target, row.data_url]));
}

export function getCustomArtworkData(mediaId: string, target: string): { dataUrl: string; updatedAt: number } | null {
  const row = getDb().prepare('SELECT data_url, updated_at FROM custom_artwork WHERE media_id = ? AND target = ?').get(mediaId, target) as
    | { data_url: string; updated_at: number }
    | undefined;
  return row ? { dataUrl: row.data_url, updatedAt: row.updated_at } : null;
}

export function importCustomArtwork(entries: Record<string, Record<string, string>>): void {
  const tx = getDb().transaction(() => {
    for (const [mediaId, targets] of Object.entries(entries || {})) {
      for (const [target, dataUrl] of Object.entries(targets || {})) {
        if (dataUrl) saveCustomArtwork(mediaId, target, dataUrl);
      }
    }
  });
  tx();
}

function getProgressMap(): Map<string, StoredProgress> {
  return new Map(Object.entries(getAllProgress()));
}

function getCustomArtworkMap(): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  const rows = getDb()
    .prepare('SELECT media_id, target, data_url FROM custom_artwork')
    .all() as Array<{ media_id: string; target: string; data_url: string }>;
  for (const row of rows) {
    let targetMap = result.get(row.media_id);
    if (!targetMap) {
      targetMap = new Map();
      result.set(row.media_id, targetMap);
    }
    targetMap.set(row.target, row.data_url);
  }
  return result;
}

export type CachedArtwork = {
  dataUrl?: string;
  cachePath?: string;
  mimeType: string;
  byteLength: number;
};

export function getCachedArtwork(sourceUrl: string): CachedArtwork | null {
  const row = getDb().prepare('SELECT data_url, cache_path, mime_type, byte_length FROM artwork_cache WHERE source_url = ?').get(sourceUrl) as
    | { data_url: string; cache_path?: string | null; mime_type: string; byte_length: number }
    | undefined;
  if (!row) return null;
  const cachePath = row.cache_path || undefined;
  if (cachePath && fs.existsSync(cachePath)) {
    return { cachePath, mimeType: row.mime_type, byteLength: row.byte_length };
  }
  return row.data_url ? { dataUrl: row.data_url, mimeType: row.mime_type, byteLength: row.byte_length } : null;
}

async function fetchArtworkBytes(sourceUrl: string): Promise<{ bytes: Buffer; mimeType: string; byteLength: number } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal });
    if (!response.ok) return null;
    const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    if (!mimeType.startsWith('image/')) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024) return null;
    return {
      bytes,
      mimeType,
      byteLength: bytes.byteLength,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// The desktop is the LAN artwork source. When an older library entry has not
// been pre-cached yet, fetch and persist the image here instead of making a
// paired device follow a redirect to the metadata provider.
export async function cacheArtworkSource(sourceUrl: string): Promise<CachedArtwork | null> {
  const existing = getCachedArtwork(sourceUrl);
  if (existing) return existing;

  const cached = await fetchArtworkBytes(sourceUrl);
  if (!cached) return null;

  const cachePath = path.join(artworkCacheDirectory(), artworkCacheFileName(sourceUrl, cached.mimeType));
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, cached.bytes);
  getDb().prepare(`
    INSERT OR REPLACE INTO artwork_cache (source_url, data_url, cache_path, mime_type, byte_length, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sourceUrl, '', cachePath, cached.mimeType, cached.byteLength, Date.now());

  return {
    cachePath,
    mimeType: cached.mimeType,
    byteLength: cached.byteLength,
  };
}

export async function cacheLibraryArtwork(data: LibraryData): Promise<void> {
  const sources = collectArtworkSourcesForCache(data);

  const database = getDb();
  const cacheDir = artworkCacheDirectory();
  fs.mkdirSync(cacheDir, { recursive: true });
  const sourceSet = new Set(sources);
  const rows = database.prepare('SELECT source_url, cache_path FROM artwork_cache').all() as Array<{ source_url: string; cache_path?: string | null }>;
  const deleteStale = database.prepare('DELETE FROM artwork_cache WHERE source_url = ?');
  const pruneStale = database.transaction(() => {
    for (const row of rows) {
      if (!sourceSet.has(row.source_url)) {
        if (row.cache_path) {
          try {
            if (fs.existsSync(row.cache_path)) fs.unlinkSync(row.cache_path);
          } catch {
            // Cache file cleanup is best-effort; the database row is authoritative.
          }
        }
        deleteStale.run(row.source_url);
      }
    }
  });
  pruneStale();

  if (sources.length === 0) return;

  const existing = new Set(rows.map((row) => row.source_url).filter((source) => sourceSet.has(source)));
  const pending = sources.filter((source) => !existing.has(source));
  const insert = database.prepare(`
    INSERT OR REPLACE INTO artwork_cache (source_url, data_url, cache_path, mime_type, byte_length, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let index = 0;
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (index < pending.length) {
      const source = pending[index++];
      const cached = await fetchArtworkBytes(source);
      if (cached) {
        const cachePath = path.join(cacheDir, artworkCacheFileName(source, cached.mimeType));
        fs.writeFileSync(cachePath, cached.bytes);
        insert.run(source, '', cachePath, cached.mimeType, cached.byteLength, Date.now());
      }
    }
  });
  await Promise.all(workers);
}

export async function backupDatabase(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const source = databasePath();
  const result = await dialog.showSaveDialog({
    title: 'Back Up Loom Media Server Database',
    defaultPath: `loomtv-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
    filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(source, result.filePath);
  return { ok: true, path: result.filePath };
}

export function clearDatabase(): void {
  const database = getDb();
  database.exec(`
    DELETE FROM segment_manual_history;
    DELETE FROM media_segments;
    DELETE FROM media_segment_candidates;
    DELETE FROM segment_source_cache;
    DELETE FROM media_fingerprints;
    DELETE FROM segment_analysis_state;
    DELETE FROM artwork_cache;
    DELETE FROM custom_artwork;
    DELETE FROM playback_progress;
    DELETE FROM episode_files;
    DELETE FROM episodes;
    DELETE FROM seasons;
    DELETE FROM media_items;
    DELETE FROM library_folders;
    DELETE FROM scan_cache;
    DELETE FROM app_settings;
  `);
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.exec('VACUUM;');
}
