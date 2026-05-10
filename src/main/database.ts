import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

type JsonValue = unknown;

export type StoredProgress = {
  position: number;
  duration: number;
  updatedAt: number;
  watched: boolean;
};

type LibraryData = {
  movies: any[];
  tvShows: any[];
  animeShows: any[];
  libraryFolders: string[];
  libraryFolderGroups?: { movies: string[]; tvShows: string[]; anime: string[] };
  scanCache?: Record<string, any>;
};

type SettingsData = Record<string, unknown>;

let db: Database.Database | null = null;

export function databasePath(): string {
  return path.join(app.getPath('userData'), 'loomtv.sqlite');
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

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_folders (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('movies', 'tvShows', 'anime')),
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('movie', 'tv', 'anime')),
      title TEXT NOT NULL,
      year INTEGER NOT NULL DEFAULT 0,
      poster TEXT NOT NULL DEFAULT '',
      backdrop TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      rating REAL NOT NULL DEFAULT 0,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      last_played INTEGER,
      genres_json TEXT NOT NULL DEFAULT '[]',
      cast_json TEXT NOT NULL DEFAULT '[]',
      subtitles_json TEXT NOT NULL DEFAULT '[]',
      local_metadata_json TEXT,
      poster_candidates_json TEXT NOT NULL DEFAULT '[]',
      backdrop_candidates_json TEXT NOT NULL DEFAULT '[]',
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
      local_metadata_json TEXT,
      PRIMARY KEY (media_id, season, episode, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_episode_files_file_path ON episode_files(file_path);

    CREATE TABLE IF NOT EXISTS scan_cache (
      folder_path TEXT PRIMARY KEY,
      version INTEGER,
      folder_kind TEXT NOT NULL,
      signature TEXT NOT NULL,
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
      mime_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

export function hasLibraryData(): boolean {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM media_items').get() as { count: number };
  const folders = getDb().prepare('SELECT COUNT(*) AS count FROM library_folders').get() as { count: number };
  return row.count > 0 || folders.count > 0;
}

function folderGroupsFromRows(rows: Array<{ path: string; kind: string }>) {
  const groups = { movies: [] as string[], tvShows: [] as string[], anime: [] as string[] };
  for (const row of rows) {
    if (row.kind === 'tvShows') groups.tvShows.push(row.path);
    else if (row.kind === 'anime') groups.anime.push(row.path);
    else groups.movies.push(row.path);
  }
  return groups;
}

function flattenFolders(groups: { movies: string[]; tvShows: string[]; anime: string[] }): string[] {
  return [...groups.movies, ...groups.tvShows, ...groups.anime];
}

function mapArtworkSource(source: string, cache: Map<string, string>): string {
  return source && cache.has(source) ? cache.get(source)! : source;
}

function applyDurableState(item: any, progress: Map<string, StoredProgress>, custom: Map<string, Map<string, string>>, cache: Map<string, string>): any {
  const next = { ...item };
  const itemCustom = custom.get(item.id);
  const itemProgress = progress.get(item.filePath);
  let lastPlayed = itemProgress?.updatedAt || item.lastPlayed || 0;

  next.poster = mapArtworkSource(next.poster || '', cache);
  next.backdrop = mapArtworkSource(next.backdrop || '', cache);
  next.posterCandidates = (next.posterCandidates || []).map((source: string) => mapArtworkSource(source, cache));
  next.backdropCandidates = (next.backdropCandidates || []).map((source: string) => mapArtworkSource(source, cache));
  next.episodes = (next.episodes || []).map((episode: any) => ({
    ...episode,
    still: mapArtworkSource(episode.still || '', cache),
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
      next.backdrop = cover;
      next.backdropCandidates = [cover, ...(next.backdropCandidates || []).filter((source: string) => source !== cover)];
    }
    if (poster || thumbnail) {
      const primary = poster || thumbnail || '';
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
  const cache = getArtworkCacheMap();
  const rows = database.prepare('SELECT * FROM media_items ORDER BY title COLLATE NOCASE ASC').all() as any[];

  const seasonsByMedia = new Map<string, any[]>();
  for (const row of database.prepare('SELECT * FROM seasons ORDER BY number ASC').all() as any[]) {
    seasonsByMedia.set(row.media_id, [...(seasonsByMedia.get(row.media_id) || []), {
      number: row.number,
      title: row.title,
      episodeCount: row.episode_count,
    }]);
  }

  const episodesByMedia = new Map<string, any[]>();
  for (const row of database.prepare('SELECT * FROM episodes ORDER BY season ASC, number ASC').all() as any[]) {
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

  const episodeFilesByMedia = new Map<string, any[]>();
  for (const row of database.prepare('SELECT * FROM episode_files ORDER BY season ASC, episode ASC').all() as any[]) {
    episodeFilesByMedia.set(row.media_id, [...(episodeFilesByMedia.get(row.media_id) || []), {
      season: row.season,
      episode: row.episode,
      filePath: row.file_path,
      title: row.title || undefined,
      localMetadata: jsonParse(row.local_metadata_json, undefined),
    }]);
  }

  const scanCache = Object.fromEntries((database.prepare('SELECT * FROM scan_cache').all() as any[]).map((row) => [
    row.folder_path,
    {
      version: row.version,
      folderKind: row.folder_kind,
      signature: row.signature,
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
      type: row.type,
      title: row.title,
      year: row.year,
      poster: row.poster,
      backdrop: row.backdrop,
      posterCandidates: jsonParse(row.poster_candidates_json, []),
      backdropCandidates: jsonParse(row.backdrop_candidates_json, []),
      summary: row.summary,
      rating: row.rating,
      genres: jsonParse(row.genres_json, []),
      cast: jsonParse(row.cast_json, []),
      filePath: row.file_path,
      fileSize: row.file_size || undefined,
      lastPlayed: row.last_played || undefined,
      subtitles: jsonParse(row.subtitles_json, []),
      localMetadata: jsonParse(row.local_metadata_json, undefined),
      seasons: seasonsByMedia.get(row.id) || undefined,
      episodes: episodesByMedia.get(row.id) || undefined,
      episodeFiles: episodeFilesByMedia.get(row.id) || undefined,
    }, progress, custom, cache);

    if (item.type === 'movie') data.movies.push(item);
    else if (item.type === 'anime') data.animeShows.push(item);
    else data.tvShows.push(item);
  }

  return data;
}

export function saveLibraryToDatabase(data: LibraryData): void {
  const database = getDb();
  const now = Date.now();
  const folderGroups = data.libraryFolderGroups || { movies: [], tvShows: [], anime: [] };
  const tx = database.transaction(() => {
    database.exec('DELETE FROM episode_files; DELETE FROM episodes; DELETE FROM seasons; DELETE FROM media_items; DELETE FROM library_folders; DELETE FROM scan_cache;');

    const insertFolder = database.prepare('INSERT OR REPLACE INTO library_folders (path, kind, added_at) VALUES (?, ?, ?)');
    for (const folder of folderGroups.movies || []) insertFolder.run(folder, 'movies', now);
    for (const folder of folderGroups.tvShows || []) insertFolder.run(folder, 'tvShows', now);
    for (const folder of folderGroups.anime || []) insertFolder.run(folder, 'anime', now);

    const insertItem = database.prepare(`
      INSERT OR REPLACE INTO media_items (
        id, type, title, year, poster, backdrop, summary, rating, file_path, file_size, last_played,
        genres_json, cast_json, subtitles_json, local_metadata_json, poster_candidates_json, backdrop_candidates_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSeason = database.prepare('INSERT OR REPLACE INTO seasons (media_id, number, title, episode_count) VALUES (?, ?, ?, ?)');
    const insertEpisode = database.prepare(`
      INSERT OR REPLACE INTO episodes (media_id, season, number, title, summary, still, rating, air_date, local_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEpisodeFile = database.prepare(`
      INSERT OR REPLACE INTO episode_files (media_id, season, episode, file_path, title, local_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const item of [...(data.movies || []), ...(data.tvShows || []), ...(data.animeShows || [])]) {
      insertItem.run(
        item.id,
        item.type,
        item.title || '',
        item.year || 0,
        item.poster || '',
        item.backdrop || '',
        item.summary || '',
        item.rating || 0,
        item.filePath || '',
        item.fileSize || null,
        item.lastPlayed || null,
        jsonString(item.genres || []),
        jsonString(item.cast || []),
        jsonString(item.subtitles || []),
        item.localMetadata ? jsonString(item.localMetadata) : null,
        jsonString(item.posterCandidates || []),
        jsonString(item.backdropCandidates || []),
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
          episode.still || '',
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
          episodeFile.localMetadata ? jsonString(episodeFile.localMetadata) : null,
        );
      }
    }

    const insertScanCache = database.prepare(`
      INSERT OR REPLACE INTO scan_cache (folder_path, version, folder_kind, signature, file_count, item_count, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [folder, entry] of Object.entries(data.scanCache || {})) {
      insertScanCache.run(folder, entry.version || null, entry.folderKind || '', entry.signature || '', entry.fileCount || 0, entry.itemCount || 0, entry.scannedAt || now);
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
  const row = getDb().prepare('SELECT * FROM playback_progress WHERE file_path = ?').get(filePath) as any;
  if (!row) return null;
  return { position: row.position, duration: row.duration, updatedAt: row.updated_at, watched: Boolean(row.watched) };
}

export function getAllProgress(): Record<string, StoredProgress> {
  return Object.fromEntries((getDb().prepare('SELECT * FROM playback_progress').all() as any[]).map((row) => [
    row.file_path,
    { position: row.position, duration: row.duration, updatedAt: row.updated_at, watched: Boolean(row.watched) },
  ]));
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
  return Object.fromEntries((getDb().prepare('SELECT target, data_url FROM custom_artwork WHERE media_id = ?').all(mediaId) as any[])
    .map((row) => [row.target, row.data_url]));
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
  for (const row of getDb().prepare('SELECT media_id, target, data_url FROM custom_artwork').all() as any[]) {
    if (!result.has(row.media_id)) result.set(row.media_id, new Map());
    result.get(row.media_id)!.set(row.target, row.data_url);
  }
  return result;
}

function getArtworkCacheMap(): Map<string, string> {
  return new Map((getDb().prepare('SELECT source_url, data_url FROM artwork_cache').all() as any[])
    .map((row) => [row.source_url, row.data_url]));
}

function isRemoteArtworkSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function collectArtworkSources(data: LibraryData): string[] {
  const sources = new Set<string>();
  const add = (source?: string) => {
    if (source && isRemoteArtworkSource(source)) sources.add(source);
  };

  for (const item of [...(data.movies || []), ...(data.tvShows || []), ...(data.animeShows || [])]) {
    add(item.poster);
    add(item.backdrop);
    (item.posterCandidates || []).forEach(add);
    (item.backdropCandidates || []).forEach(add);
    (item.episodes || []).forEach((episode: any) => add(episode.still));
  }
  return Array.from(sources);
}

async function fetchArtworkAsDataUrl(sourceUrl: string): Promise<{ dataUrl: string; mimeType: string; byteLength: number } | null> {
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
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
      mimeType,
      byteLength: bytes.byteLength,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function cacheLibraryArtwork(data: LibraryData): Promise<void> {
  const sources = collectArtworkSources(data);
  if (sources.length === 0) return;

  const database = getDb();
  const existing = new Set((database.prepare('SELECT source_url FROM artwork_cache').all() as any[]).map((row) => row.source_url));
  const pending = sources.filter((source) => !existing.has(source));
  const insert = database.prepare(`
    INSERT OR REPLACE INTO artwork_cache (source_url, data_url, mime_type, byte_length, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  let index = 0;
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (index < pending.length) {
      const source = pending[index++];
      const cached = await fetchArtworkAsDataUrl(source);
      if (cached) insert.run(source, cached.dataUrl, cached.mimeType, cached.byteLength, Date.now());
    }
  });
  await Promise.all(workers);
}

export async function backupDatabase(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const source = databasePath();
  const result = await dialog.showSaveDialog({
    title: 'Back Up LoomTV Database',
    defaultPath: `loomtv-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
    filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(source, result.filePath);
  return { ok: true, path: result.filePath };
}
