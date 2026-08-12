import type BetterSqlite3 from 'better-sqlite3';
import type { LibraryData, LibraryFolderGroups, ScanCacheEntry } from './appContracts.ts';
import { customArtworkReference } from './artworkCache.ts';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './metadata/types.ts';
import {
  lanCastMemberSchema,
  lanContentRatingSchema,
  lanLocalMediaDetailsSchema,
  lanOriginPlatformSchema,
  lanStreamingProviderSchema,
  lanSubtitleRecordSchema,
} from '@loom-media-server/lan-protocol';
import { z } from 'zod';
import { parseStoredJson } from './runtimeValidation.ts';

type SeasonEntry = { number: number; title: string; episodeCount: number };

type MediaItemRow = {
  id: string;
  type: string;
  format: string;
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
  streaming_providers_json: string | null;
  origin_platform_json: string | null;
  poster_candidates_json: string | null;
  backdrop_candidates_json: string | null;
  logo_candidates_json: string | null;
  content_ratings_json: string | null;
};

type SeasonRow = { media_id: string; number: number; title: string; episode_count: number };
type EpisodeRow = {
  media_id: string;
  season: number;
  number: number;
  title: string;
  summary: string;
  still: string;
  rating: number;
  air_date: string;
  local_metadata_json: string | null;
};
type EpisodeFileRow = {
  media_id: string;
  season: number;
  episode: number;
  file_path: string;
  title: string | null;
  subtitles_json: string | null;
  local_metadata_json: string | null;
};
type ScanCacheRow = {
  folder_path: string;
  version: number;
  folder_kind: string;
  signature: string;
  subtitle_profile: string | null;
  file_count: number;
  item_count: number;
  scanned_at: number;
  ratings_refreshed_at: number;
};

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
  const row = database.prepare('SELECT COUNT(*) AS count FROM media_items').get() as { count: number };
  const folders = database.prepare('SELECT COUNT(*) AS count FROM library_folders').get() as { count: number };
  return row.count > 0 || folders.count > 0;
}

export function loadLibrary(
  database: BetterSqlite3.Database,
  custom: Map<string, Map<string, string>>,
): LibraryData | null {
  if (!hasLibraryData(database)) return null;

  const folderRows = database.prepare('SELECT path, kind FROM library_folders ORDER BY added_at ASC').all() as Array<{ path: string; kind: string }>;
  const folderGroups = folderGroupsFromRows(folderRows);
  const rows = database.prepare('SELECT * FROM media_items ORDER BY title COLLATE NOCASE ASC').all() as MediaItemRow[];

  const seasonsByMedia = new Map<string, SeasonEntry[]>();
  for (const row of database.prepare('SELECT * FROM seasons ORDER BY number ASC').all() as SeasonRow[]) {
    appendToMap(seasonsByMedia, row.media_id, {
      number: row.number,
      title: row.title,
      episodeCount: row.episode_count,
    });
  }

  const episodesByMedia = new Map<string, EpisodeMeta[]>();
  for (const row of database.prepare('SELECT * FROM episodes ORDER BY season ASC, number ASC').all() as EpisodeRow[]) {
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
  for (const row of database.prepare('SELECT * FROM episode_files ORDER BY season ASC, episode ASC').all() as EpisodeFileRow[]) {
    appendToMap(episodeFilesByMedia, row.media_id, {
      season: row.season,
      episode: row.episode,
      filePath: row.file_path,
      title: row.title || undefined,
      subtitles: parseStoredJson(row.subtitles_json, z.array(lanSubtitleRecordSchema), []),
      localMetadata: parseStoredJson(row.local_metadata_json, lanLocalMediaDetailsSchema.optional(), undefined),
    });
  }

  const scanCache = Object.fromEntries((database.prepare('SELECT * FROM scan_cache').all() as ScanCacheRow[]).map((row): [string, ScanCacheEntry] => [
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
        id, type, format, title, year, poster, backdrop, logo, summary, rating, file_path, file_size, last_played,
        genres_json, cast_json, subtitles_json, local_metadata_json, provider_ids_json, streaming_providers_json, origin_platform_json, poster_candidates_json, backdrop_candidates_json, logo_candidates_json, content_ratings_json, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
  });
  tx();
}
