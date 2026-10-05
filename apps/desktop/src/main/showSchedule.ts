import type BetterSqlite3 from 'better-sqlite3';
import { fetchTVEpisodesById, lookupTvmazeShowId } from './metadata/tvmaze.ts';
import { fetchAniListAiringSchedules, type AnimeAiring } from './metadata/anilist.ts';
import type { EpisodeMeta, MediaItem } from './metadata/types.ts';

/**
 * Each show's full episode list, including episodes not on disk, so LoomTV
 * can tell what is missing and what airs next. The library itself only keeps
 * metadata for episodes it has files for.
 *
 * TV shows use TVmaze. Anime uses AniList by MAL ID per season, because
 * TVmaze numbers anime seasons differently from the AniList/MAL seasons
 * LoomTV matches anime against and would report episodes missing that are
 * not. All anime is fetched in one batched AniList request.
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
  tv: (item: MediaItem) => Promise<Scheduled[] | null>;
  anime: (malIds: readonly number[]) => Promise<Map<number, AnimeAiring[]>>;
};

/** MAL ID for each season of an anime that has files, when known. */
export function animeSeasonMalIds(item: MediaItem): Array<{ season: number; malId: number }> {
  const ids = item.providerIds || {};
  const seasons = [...new Set((item.episodeFiles || []).map((file) => file.season).filter((season) => season > 0))].sort((a, b) => a - b);
  return seasons.flatMap((season) => {
    // The show-level MAL ID is season one's. Another season without its own
    // MAL ID gets no schedule rather than season one's episode list.
    const malId = Number(ids.malIdBySeason?.[String(season)] || (season === 1 ? ids.malId : 0));
    return Number.isSafeInteger(malId) && malId > 0 ? [{ season, malId }] : [];
  });
}

function cacheKey(item: MediaItem): string | null {
  const ids = item.providerIds;
  if (item.type === 'anime') {
    const seasons = animeSeasonMalIds(item);
    return seasons.length ? `anilist:${seasons.map(({ season, malId }) => `${season}=${malId}`).join(',')}` : null;
  }
  if (item.type !== 'tv') return null;
  if (ids?.tvmazeId) return `tvmaze:${ids.tvmazeId}`;
  if (ids?.tvdbId) return `tvdb:${ids.tvdbId}`;
  if (ids?.imdbId) return `imdb:${ids.imdbId}`;
  return null;
}

async function fetchTvSchedule(item: MediaItem): Promise<Scheduled[] | null> {
  const ids = item.providerIds || {};
  const showId = Number(ids.tvmazeId) || await lookupTvmazeShowId({ tvdbId: ids.tvdbId, imdbId: ids.imdbId });
  if (!showId) return null;
  const episodes = await fetchTVEpisodesById(showId);
  return episodes.map(({ season, number, title, airDate, summary, still }) => ({ season, number, title, airDate, summary, still }));
}

export const defaultScheduleFetchers: ScheduleFetchers = { tv: fetchTvSchedule, anime: fetchAniListAiringSchedules };

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

  const anime = stale.filter(({ item }) => item.type === 'anime');
  if (anime.length) {
    try {
      const airings = await fetchers.anime(anime.flatMap(({ item }) => animeSeasonMalIds(item).map(({ malId }) => malId)));
      for (const { item, key } of anime) {
        const schedule = animeSeasonMalIds(item).flatMap(({ season, malId }) => (airings.get(malId) || [])
          .map(({ episode, airDate }) => ({ season, number: episode, title: '', airDate })));
        if (schedule.length) save(key, schedule);
      }
    } catch (error) {
      console.warn('[schedule] Could not refresh anime airing schedules:', error instanceof Error ? error.message : error);
    }
  }

  const tv = stale.filter(({ item }) => item.type === 'tv');
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, tv.length) }, async () => {
    while (next < tv.length) {
      const { item, key } = tv[next++];
      try {
        const schedule = await fetchers.tv(item);
        if (schedule?.length) save(key, schedule);
      } catch (error) {
        console.warn(`[schedule] Could not refresh the episode list for ${item.title}:`, error instanceof Error ? error.message : error);
      }
    }
  }));
  return changed;
}
