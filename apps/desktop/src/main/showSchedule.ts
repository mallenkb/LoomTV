import type BetterSqlite3 from 'better-sqlite3';
import { fetchTVEpisodesById, lookupTvmazeShowId } from './metadata/tvmaze.ts';
import { fetchAniListAiringSchedules, type AnimeAiring } from './metadata/anilist.ts';
import { fetchTVDBMetadataById } from './metadata/tvdb.ts';
import { fetchTMDBTVMetadataById } from './metadata/tmdb.ts';
import { fetchCinemetaMeta } from './metadata/cinemeta.ts';
import type { EpisodeMeta, MediaItem } from './metadata/types.ts';

/**
 * Each show's full episode list, including episodes not on disk, so LoomTV
 * can tell what is missing and what airs next. The library itself only keeps
 * metadata for episodes it has files for.
 *
 * Shows use the first of TVmaze, TheTVDB (one request), TMDB (one request per
 * season) and Cinemeta (no key) that has the show. Anime seasons with a MAL
 * ID use AniList, all anime in one batched request. Other anime seasons use
 * that same provider chain, but a provider's season is used only when it
 * contains every episode number on disk for that season: providers number
 * anime seasons differently, and a mismatched list would report episodes
 * missing that are not.
 *
 * Reading never waits on the network: `readShowSchedules` returns what is
 * cached plus what is stale, and `refreshShowSchedules` updates the stale
 * ones in the background.
 */

const SCHEDULE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_CONCURRENCY = 4;

export type Scheduled = Pick<EpisodeMeta, 'season' | 'number' | 'title' | 'airDate'> & Partial<Pick<EpisodeMeta, 'summary' | 'still'>>;
export type StaleSchedule = { item: MediaItem; key: string };

export type ScheduleFetchers = {
  /** The first provider's full episode list for a show, or `null` when none has it. */
  tv: (item: MediaItem) => Promise<Scheduled[] | null>;
  anime: (malIds: readonly number[]) => Promise<Map<number, AnimeAiring[]>>;
};

function localNumbersBySeason(item: MediaItem): Map<number, Set<number>> {
  const seasons = new Map<number, Set<number>>();
  for (const file of item.episodeFiles || []) {
    if (file.season <= 0 || file.episode <= 0) continue;
    const numbers = seasons.get(file.season) ?? new Set<number>();
    numbers.add(file.episode);
    seasons.set(file.season, numbers);
  }
  return seasons;
}

/** MAL ID for each season of an anime that has files, when known. */
export function animeSeasonMalIds(item: MediaItem): Array<{ season: number; malId: number }> {
  const ids = item.providerIds || {};
  return [...localNumbersBySeason(item).keys()].sort((a, b) => a - b).flatMap((season) => {
    // The show-level MAL ID is season one's. Another season without its own
    // MAL ID gets no AniList list rather than season one's episodes.
    const malId = Number(ids.malIdBySeason?.[String(season)] || (season === 1 ? ids.malId : 0));
    return Number.isSafeInteger(malId) && malId > 0 ? [{ season, malId }] : [];
  });
}

/** Anime seasons on disk that AniList cannot cover. */
function animeOtherSeasons(item: MediaItem): number[] {
  const covered = new Set(animeSeasonMalIds(item).map(({ season }) => season));
  return [...localNumbersBySeason(item).keys()].filter((season) => !covered.has(season)).sort((a, b) => a - b);
}

function providerKey(item: MediaItem): string | null {
  const ids = item.providerIds;
  if (ids?.tvmazeId) return `tvmaze:${ids.tvmazeId}`;
  if (ids?.tvdbId) return `tvdb:${ids.tvdbId}`;
  if (ids?.imdbId) return `imdb:${ids.imdbId}`;
  if (ids?.tmdbId) return `tmdb:${ids.tmdbId}`;
  return null;
}

function cacheKey(item: MediaItem): string | null {
  if (item.type === 'tv') return providerKey(item);
  if (item.type !== 'anime') return null;
  const mal = animeSeasonMalIds(item);
  const others = animeOtherSeasons(item);
  const provider = others.length ? providerKey(item) : null;
  if (!mal.length && !provider) return null;
  return [
    mal.length ? `anilist:${mal.map(({ season, malId }) => `${season}=${malId}`).join(',')}` : '',
    provider ? `${provider}@${others.join(',')}` : '',
  ].filter(Boolean).join('|');
}

const toScheduled = (episodes: readonly EpisodeMeta[]): Scheduled[] => episodes
  .filter((episode) => episode.season > 0 && episode.number > 0)
  .map(({ season, number, title, airDate, summary, still }) => ({ season, number, title, airDate, summary, still }));

/** Episode lists from TVmaze, then TVDB, then TMDB, then Cinemeta. Keys are read per call. */
export function createScheduleFetchers(keys: { tvdb: () => string; tmdb: () => string }): ScheduleFetchers {
  const tv = async (item: MediaItem): Promise<Scheduled[] | null> => {
    const ids = item.providerIds || {};
    const dated = (episodes: Scheduled[]) => episodes.some((episode) => episode.airDate);
    const showId = Number(ids.tvmazeId) || await lookupTvmazeShowId({ tvdbId: ids.tvdbId, imdbId: ids.imdbId }).catch(() => null);
    if (showId) {
      const episodes = toScheduled(await fetchTVEpisodesById(showId));
      if (dated(episodes)) return episodes;
    }
    if (ids.tvdbId && keys.tvdb()) {
      const episodes = toScheduled((await fetchTVDBMetadataById(ids.tvdbId, keys.tvdb()))?.episodes || []);
      if (dated(episodes)) return episodes;
    }
    if (ids.tmdbId && keys.tmdb()) {
      const episodes = toScheduled((await fetchTMDBTVMetadataById(ids.tmdbId, keys.tmdb()))?.episodes || []);
      if (dated(episodes)) return episodes;
    }
    const episodes = toScheduled((await fetchCinemetaMeta('series', ids.imdbId))?.episodes || []);
    return dated(episodes) ? episodes : null;
  };
  return { tv, anime: fetchAniListAiringSchedules };
}

export const defaultScheduleFetchers: ScheduleFetchers = createScheduleFetchers({ tvdb: () => '', tmdb: () => '' });

/**
 * A provider's episodes for the given anime seasons, each season kept only
 * when it lists every episode number on disk for that season.
 */
export function consistentAnimeSeasons(item: MediaItem, seasons: readonly number[], episodes: readonly Scheduled[]): Scheduled[] {
  const local = localNumbersBySeason(item);
  return seasons.flatMap((season) => {
    const listed = episodes.filter((episode) => episode.season === season);
    const numbers = new Set(listed.map((episode) => episode.number));
    const onDisk = local.get(season) || new Set<number>();
    return listed.length && [...onDisk].every((number) => numbers.has(number)) ? listed : [];
  });
}

/** Cached episode lists by media ID, and which shows are due a refresh. No network. */
export function readShowSchedules(
  database: BetterSqlite3.Database,
  items: readonly MediaItem[],
  options: { offline: boolean; now?: number },
): { schedules: Map<string, Scheduled[]>; stale: StaleSchedule[] } {
  const now = options.now ?? Date.now();
  const schedules = new Map<string, Scheduled[]>();
  const read = database.prepare('SELECT episodes_json, fetched_at FROM show_schedule_cache WHERE cache_key = ?');
  const stale: StaleSchedule[] = [];
  for (const item of items) {
    const key = cacheKey(item);
    if (!key) continue;
    const row = read.get(key) as { episodes_json: string; fetched_at: number } | undefined;
    let cached: Scheduled[] | null;
    try { cached = row ? JSON.parse(row.episodes_json) as Scheduled[] : null; } catch { cached = null; }
    if (cached) schedules.set(item.id, cached);
    // TV lists cached before summaries and stills were kept are refreshed once.
    const lacksDetails = item.type === 'tv' && Boolean(cached?.length) && !cached?.some((episode) => 'summary' in episode);
    if (!options.offline && (!cached || lacksDetails || now - (row?.fetched_at ?? 0) > SCHEDULE_TTL_MS)) stale.push({ item, key });
  }
  return { schedules, stale };
}

/**
 * Fetches the stale lists and saves them. Returns how many changed. A show
 * whose list cannot be fetched keeps its cached list; callers fall back to
 * the episodes the library already has.
 */
export async function refreshShowSchedules(
  database: BetterSqlite3.Database,
  stale: readonly StaleSchedule[],
  options: { now?: number; fetchers?: ScheduleFetchers } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const fetchers = options.fetchers ?? defaultScheduleFetchers;
  const read = database.prepare('SELECT episodes_json FROM show_schedule_cache WHERE cache_key = ?');
  const write = database.prepare('INSERT OR REPLACE INTO show_schedule_cache (cache_key, episodes_json, fetched_at) VALUES (?, ?, ?)');
  let changed = 0;
  const save = (key: string, schedule: Scheduled[]) => {
    const json = JSON.stringify(schedule);
    const previous = (read.get(key) as { episodes_json: string } | undefined)?.episodes_json;
    write.run(key, json, now);
    if (previous !== json) changed += 1;
  };

  // AniList first, one batched request for every anime season with a MAL ID.
  const fromAniList = new Map<string, Scheduled[]>();
  const anime = stale.filter(({ item }) => item.type === 'anime');
  const malIds = anime.flatMap(({ item }) => animeSeasonMalIds(item).map(({ malId }) => malId));
  if (malIds.length) {
    try {
      const airings = await fetchers.anime(malIds);
      for (const { item } of anime) {
        fromAniList.set(item.id, animeSeasonMalIds(item).flatMap(({ season, malId }) => (airings.get(malId) || [])
          .map(({ episode, airDate }) => ({ season, number: episode, title: '', airDate }))));
      }
    } catch (error) {
      console.warn('[schedule] Could not refresh anime airing schedules:', error instanceof Error ? error.message : error);
    }
  }

  // Then every show and every remaining anime season, four shows at a time.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, stale.length) }, async () => {
    while (next < stale.length) {
      const { item, key } = stale[next++];
      try {
        if (item.type === 'tv') {
          const schedule = await fetchers.tv(item);
          if (schedule?.length) save(key, schedule);
          continue;
        }
        const others = animeOtherSeasons(item);
        const provider = others.length && providerKey(item) ? await fetchers.tv(item) : null;
        const schedule = [...(fromAniList.get(item.id) || []), ...(provider ? consistentAnimeSeasons(item, others, provider) : [])];
        if (schedule.length) save(key, schedule);
      } catch (error) {
        console.warn(`[schedule] Could not refresh the episode list for ${item.title}:`, error instanceof Error ? error.message : error);
      }
    }
  }));
  return changed;
}
