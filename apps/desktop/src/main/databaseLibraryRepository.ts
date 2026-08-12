import type BetterSqlite3 from 'better-sqlite3';
import type { LibraryData, LibraryFolderGroups, ScanCacheEntry } from './appContracts.ts';
import { customArtworkReference } from './artworkCache.ts';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './metadata/types.ts';
import {
  lanCastMemberSchema,
  lanContentRatingSchema,
  lanLocalMediaDetailsSchema,
  lanOriginPlatformSchema,
  lanProviderRatingsSchema,
  lanStreamingProviderSchema,
  lanSubtitleRecordSchema,
} from '@loom-media-server/lan-protocol';
import { z } from 'zod';
import { parseStoredJson } from './runtimeValidation.ts';
import { parseDatabaseRow, parseDatabaseRows } from './databaseRows.ts';

type SeasonEntry = { number: number; title: string; episodeCount: number };

const stringArraySchema = z.array(z.string());
const providerIdsSchema = z.object({
  tmdbId: z.string().optional(),
  imdbId: z.string().optional(),
  tvdbId: z.string().optional(),
  tvmazeId: z.string().optional(),
  malId: z.string().optional(),
  malIdBySeason: z.record(z.string(), z.string()).optional(),
});
const contentRatingsSchema = z.record(z.string(), lanContentRatingSchema);
const mediaTypeSchema = z.enum(['movie', 'tv', 'anime']);
const scanCacheFolderKindSchema = z.enum(['movies', 'tv', 'anime', 'auto']);
const nullableString = z.string().nullable();
const nullableNumber = z.number().finite().nullable();
const mediaItemRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  format: z.string(),
  title: z.string(),
  year: z.number().finite(),
  poster: z.string(),
  backdrop: z.string(),
  logo: z.string(),
  summary: z.string(),
  rating: z.number().finite(),
  provider_ratings_json: nullableString,
  file_path: z.string(),
  file_size: nullableNumber,
  last_played: nullableNumber,
  genres_json: nullableString,
  cast_json: nullableString,
  subtitles_json: nullableString,
  local_metadata_json: nullableString,
  provider_ids_json: nullableString,
  streaming_providers_json: nullableString,
  origin_platform_json: nullableString,
  poster_candidates_json: nullableString,
  backdrop_candidates_json: nullableString,
  logo_candidates_json: nullableString,
  content_ratings_json: nullableString,
});
const folderRowSchema = z.object({ path: z.string(), kind: z.string() });
const countRowSchema = z.object({ count: z.number().finite().nonnegative() });
const seasonRowSchema = z.object({
  media_id: z.string(),
  number: z.number().finite(),
  title: z.string(),
  episode_count: z.number().finite().nonnegative(),
});
const episodeRowSchema = z.object({
  media_id: z.string(),
  season: z.number().finite(),
  number: z.number().finite(),
  title: z.string(),
  summary: z.string(),
  still: z.string(),
  rating: z.number().finite(),
  air_date: z.string(),
  local_metadata_json: nullableString,
});
const episodeFileRowSchema = z.object({
  media_id: z.string(),
  season: z.number().finite(),
  episode: z.number().finite(),
  file_path: z.string(),
  title: nullableString,
  subtitles_json: nullableString,
  local_metadata_json: nullableString,
});
const scanCacheRowSchema = z.object({
  folder_path: z.string(),
  version: z.number().finite(),
  folder_kind: z.string(),
  signature: z.string(),
  subtitle_profile: nullableString,
  file_count: z.number().finite().nonnegative(),
  item_count: z.number().finite().nonnegative(),
  scanned_at: z.number().finite().nonnegative(),
  ratings_refreshed_at: z.number().finite().nonnegative(),
});

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function folderGroupsFromRows(rows: Array<{ path: string; kind: string }>): LibraryFolderGroups {
  const groups: LibraryFolderGroups = { movies: [], tvShows: [], anime: [], others: [] };
  for (const row of rows) {
    if (row.kind === 'tvShows') groups.tvShows.push(row.path);
    else if (row.kind === 'anime') groups.anime.push(row.path);
    else if (row.kind === 'others') groups.others.push(row.path);
    else groups.movies.push(row.path);
  }
  return groups;
}

function flattenFolders(groups: LibraryFolderGroups): string[] {
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

function applyDurableState(
  item: MediaItem,
  custom: Map<string, Map<string, string>>,
): MediaItem {
  const next = { ...item };
  const itemCustom = custom.get(item.id);

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

  delete next.lastPlayed;

  if (itemCustom) {
    const cover = itemCustom.get('cover');
    const poster = itemCustom.get('poster');
    const thumbnail = itemCustom.get('thumbnail');
    if (cover) {
      const coverReference = customArtworkReference(item.id, 'cover');
      next.backdrop = coverReference;
      next.backdropCandidates = [coverReference, ...(next.backdropCandidates || []).filter((source) => source !== coverReference)];
    }
    if (poster || thumbnail) {
      const primaryTarget = poster ? 'poster' : 'thumbnail';
      const primary = customArtworkReference(item.id, primaryTarget);
      next.poster = primary;
      next.posterCandidates = [primary, ...(next.posterCandidates || []).filter((source) => source !== primary)];
    }
  }

  return next;
}

function appendToMap<T>(map: Map<string, T[]>, mediaId: string, value: T): void {
  const existing = map.get(mediaId);
  if (existing) existing.push(value);
  else map.set(mediaId, [value]);
}

export function hasLibraryData(database: BetterSqlite3.Database): boolean {
  const row = parseDatabaseRow(database.prepare('SELECT COUNT(*) AS count FROM media_items').get(), countRowSchema, 'media count');
  const folders = parseDatabaseRow(database.prepare('SELECT COUNT(*) AS count FROM library_folders').get(), countRowSchema, 'folder count');
  return row.count > 0 || folders.count > 0;
}

export function loadLibrary(
  database: BetterSqlite3.Database,
  custom: Map<string, Map<string, string>>,
): LibraryData | null {
  if (!hasLibraryData(database)) return null;

  const folderRows = parseDatabaseRows(database.prepare('SELECT path, kind FROM library_folders ORDER BY added_at ASC').all(), folderRowSchema, 'library folder');
  const folderGroups = folderGroupsFromRows(folderRows);
  const rows = parseDatabaseRows(database.prepare('SELECT * FROM media_items ORDER BY title COLLATE NOCASE ASC').all(), mediaItemRowSchema, 'media item');

  const seasonsByMedia = new Map<string, SeasonEntry[]>();
  for (const row of parseDatabaseRows(database.prepare('SELECT * FROM seasons ORDER BY number ASC').all(), seasonRowSchema, 'season')) {
    appendToMap(seasonsByMedia, row.media_id, {
      number: row.number,
      title: row.title,
      episodeCount: row.episode_count,
    });
  }

  const episodesByMedia = new Map<string, EpisodeMeta[]>();
  for (const row of parseDatabaseRows(database.prepare('SELECT * FROM episodes ORDER BY season ASC, number ASC').all(), episodeRowSchema, 'episode')) {
    appendToMap(episodesByMedia, row.media_id, {
      season: row.season,
      number: row.number,
      title: row.title,
      summary: row.summary,
      still: row.still,
      rating: row.rating,
      airDate: row.air_date,
      localMetadata: parseStoredJson(row.local_metadata_json, lanLocalMediaDetailsSchema.optional(), undefined),
    });
  }

  const episodeFilesByMedia = new Map<string, EpisodeFile[]>();
  for (const row of parseDatabaseRows(database.prepare('SELECT * FROM episode_files ORDER BY season ASC, episode ASC').all(), episodeFileRowSchema, 'episode file')) {
    appendToMap(episodeFilesByMedia, row.media_id, {
      season: row.season,
      episode: row.episode,
      filePath: row.file_path,
      title: row.title || undefined,
      subtitles: parseStoredJson(row.subtitles_json, z.array(lanSubtitleRecordSchema), []),
      localMetadata: parseStoredJson(row.local_metadata_json, lanLocalMediaDetailsSchema.optional(), undefined),
    });
  }

  const scanCacheRows = parseDatabaseRows(database.prepare('SELECT * FROM scan_cache').all(), scanCacheRowSchema, 'scan cache');
  const scanCache = Object.fromEntries(scanCacheRows.map((row): [string, ScanCacheEntry] => [
    row.folder_path,
    {
      version: row.version,
      folderKind: scanCacheFolderKindSchema.parse(row.folder_kind),
      signature: row.signature,
      subtitleProfile: row.subtitle_profile || '',
      fileCount: row.file_count,
      itemCount: row.item_count,
      scannedAt: row.scanned_at,
      ratingsRefreshedAt: row.ratings_refreshed_at || row.scanned_at,
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
      type: mediaTypeSchema.parse(row.type),
      format: row.format || undefined,
      title: row.title,
      year: row.year,
      poster: row.poster,
      backdrop: row.backdrop,
      logo: row.logo,
      posterCandidates: parseStoredJson(row.poster_candidates_json, stringArraySchema, []),
      backdropCandidates: parseStoredJson(row.backdrop_candidates_json, stringArraySchema, []),
      logoCandidates: parseStoredJson(row.logo_candidates_json, stringArraySchema, []),
      summary: row.summary,
      rating: row.rating,
      providerRatings: parseStoredJson(row.provider_ratings_json, lanProviderRatingsSchema, {}),
      contentRatings: parseStoredJson(row.content_ratings_json, contentRatingsSchema, {}),
      streamingProviders: parseStoredJson(row.streaming_providers_json, z.array(lanStreamingProviderSchema).optional(), undefined),
      originPlatform: parseStoredJson(row.origin_platform_json, lanOriginPlatformSchema.optional(), undefined),
      genres: parseStoredJson(row.genres_json, stringArraySchema, []),
      cast: parseStoredJson(row.cast_json, z.array(lanCastMemberSchema), []),
      filePath: row.file_path,
      fileSize: row.file_size || undefined,
      subtitles: parseStoredJson(row.subtitles_json, z.array(lanSubtitleRecordSchema), []),
      localMetadata: parseStoredJson(row.local_metadata_json, lanLocalMediaDetailsSchema.optional(), undefined),
      providerIds: parseStoredJson(row.provider_ids_json, providerIdsSchema.optional(), undefined),
      seasons: seasonsByMedia.get(row.id) || undefined,
      episodes: episodesByMedia.get(row.id) || undefined,
      episodeFiles: episodeFilesByMedia.get(row.id) || undefined,
    }, custom);

    if (item.type === 'movie') data.movies.push(item);
    else if (item.type === 'anime') data.animeShows.push(item);
    else data.tvShows.push(item);
  }

  return data;
}

export function remapLibraryMediaReferences(
  database: BetterSqlite3.Database,
  aliases: ReadonlyMap<string, string>,
): void {
  if (aliases.size === 0) return;

  const tx = database.transaction(() => {
    const copyListEntries = database.prepare(`
      INSERT OR IGNORE INTO profile_media_lists (profile_id, media_id, list_kind, created_at)
      SELECT profile_id, ?, list_kind, created_at
      FROM profile_media_lists
      WHERE media_id = ?
    `);
    const deleteListEntries = database.prepare('DELETE FROM profile_media_lists WHERE media_id = ?');
    const copyCustomArtwork = database.prepare(`
      INSERT OR IGNORE INTO custom_artwork (media_id, target, data_url, updated_at)
      SELECT ?, target, data_url, updated_at
      FROM custom_artwork
      WHERE media_id = ?
    `);
    const deleteCustomArtwork = database.prepare('DELETE FROM custom_artwork WHERE media_id = ?');

    for (const [sourceId, targetId] of aliases) {
      if (!sourceId || !targetId || sourceId === targetId) continue;
      copyListEntries.run(targetId, sourceId);
      deleteListEntries.run(sourceId);
      copyCustomArtwork.run(targetId, sourceId);
      deleteCustomArtwork.run(sourceId);
    }
  });
  tx();
}

export function saveLibrary(database: BetterSqlite3.Database, data: LibraryData): void {
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
        id, type, format, title, year, poster, backdrop, logo, summary, rating, provider_ratings_json, file_path, file_size, last_played,
        genres_json, cast_json, subtitles_json, local_metadata_json, provider_ids_json, streaming_providers_json, origin_platform_json, poster_candidates_json, backdrop_candidates_json, logo_candidates_json, content_ratings_json, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
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
        item.format || '',
        item.title || '',
        item.year || 0,
        durableArtworkSource(item.poster),
        durableArtworkSource(item.backdrop),
        durableArtworkSource(item.logo),
        item.summary || '',
        item.rating || 0,
        jsonString(item.providerRatings || {}),
        item.filePath || '',
        item.fileSize || null,
        null,
        jsonString(item.genres || []),
        jsonString(item.cast || []),
        jsonString(item.subtitles || []),
        item.localMetadata ? jsonString(item.localMetadata) : null,
        item.providerIds ? jsonString(item.providerIds) : null,
        item.streamingProviders ? jsonString(item.streamingProviders) : null,
        item.originPlatform ? jsonString(item.originPlatform) : null,
        jsonString(durableArtworkSources(item.posterCandidates || [])),
        jsonString(durableArtworkSources(item.backdropCandidates || [])),
        jsonString(durableArtworkSources(item.logoCandidates || [])),
        jsonString(item.contentRatings || {}),
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
      INSERT OR REPLACE INTO scan_cache (folder_path, version, folder_kind, signature, subtitle_profile, file_count, item_count, scanned_at, ratings_refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        entry.ratingsRefreshedAt || entry.scannedAt || now,
      );
    }
    database.prepare(`
      DELETE FROM media_metadata_refresh_state
      WHERE media_id NOT IN (SELECT id FROM media_items)
    `).run();
  });
  tx();
}

/**
 * Persist one catalog item without rewriting unrelated titles or scan state.
 * Child rows are reconciled in the same transaction so readers never observe
 * a partially updated season or episode graph.
 */
export function saveLibraryItem(database: BetterSqlite3.Database, item: MediaItem): void {
  const now = Date.now();
  const tx = database.transaction(() => {
    database.prepare(`
      INSERT INTO media_items (
        id, type, format, title, year, poster, backdrop, logo, summary, rating, provider_ratings_json, file_path, file_size, last_played,
        genres_json, cast_json, subtitles_json, local_metadata_json, provider_ids_json, streaming_providers_json, origin_platform_json, poster_candidates_json, backdrop_candidates_json, logo_candidates_json, content_ratings_json, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        format = excluded.format,
        title = excluded.title,
        year = excluded.year,
        poster = excluded.poster,
        backdrop = excluded.backdrop,
        logo = excluded.logo,
        summary = excluded.summary,
        rating = excluded.rating,
        provider_ratings_json = excluded.provider_ratings_json,
        file_path = excluded.file_path,
        file_size = excluded.file_size,
        genres_json = excluded.genres_json,
        cast_json = excluded.cast_json,
        subtitles_json = excluded.subtitles_json,
        local_metadata_json = excluded.local_metadata_json,
        provider_ids_json = excluded.provider_ids_json,
        streaming_providers_json = excluded.streaming_providers_json,
        origin_platform_json = excluded.origin_platform_json,
        poster_candidates_json = excluded.poster_candidates_json,
        backdrop_candidates_json = excluded.backdrop_candidates_json,
        logo_candidates_json = excluded.logo_candidates_json,
        content_ratings_json = excluded.content_ratings_json,
        updated_at = excluded.updated_at
    `).run(
      item.id,
      item.type,
      item.format || '',
      item.title || '',
      item.year || 0,
      durableArtworkSource(item.poster),
      durableArtworkSource(item.backdrop),
      durableArtworkSource(item.logo),
      item.summary || '',
      item.rating || 0,
      jsonString(item.providerRatings || {}),
      item.filePath || '',
      item.fileSize || null,
      null,
      jsonString(item.genres || []),
      jsonString(item.cast || []),
      jsonString(item.subtitles || []),
      item.localMetadata ? jsonString(item.localMetadata) : null,
      item.providerIds ? jsonString(item.providerIds) : null,
      item.streamingProviders ? jsonString(item.streamingProviders) : null,
      item.originPlatform ? jsonString(item.originPlatform) : null,
      jsonString(durableArtworkSources(item.posterCandidates || [])),
      jsonString(durableArtworkSources(item.backdropCandidates || [])),
      jsonString(durableArtworkSources(item.logoCandidates || [])),
      jsonString(item.contentRatings || {}),
      now,
    );

    database.prepare('DELETE FROM episode_files WHERE media_id = ?').run(item.id);
    database.prepare('DELETE FROM episodes WHERE media_id = ?').run(item.id);
    database.prepare('DELETE FROM seasons WHERE media_id = ?').run(item.id);

    const insertSeason = database.prepare('INSERT INTO seasons (media_id, number, title, episode_count) VALUES (?, ?, ?, ?)');
    const insertEpisode = database.prepare(`
      INSERT INTO episodes (media_id, season, number, title, summary, still, rating, air_date, local_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEpisodeFile = database.prepare(`
      INSERT INTO episode_files (media_id, season, episode, file_path, title, subtitles_json, local_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

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
  });
  tx();
}
