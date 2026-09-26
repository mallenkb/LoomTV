import type BetterSqlite3 from 'better-sqlite3';
import { fetchTVEpisodesById, lookupTvmazeShowId } from './metadata/tvmaze.ts';
import type { EpisodeMeta, MediaItem } from './metadata/types.ts';

/**
 * Each TV show's full episode list from TVmaze, including episodes not on
 * disk, so LoomTV can tell what is missing and what airs next. The library
 * itself only keeps metadata for episodes it has files for.
 *
 * Anime is left out on purpose: TVmaze numbers anime seasons differently from
 * the AniList/MAL seasons LoomTV matches anime against, which would report
 * episodes as missing that are not.
 */

const SCHEDULE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_CONCURRENCY = 4;

type Scheduled = Pick<EpisodeMeta, 'season' | 'number' | 'title' | 'airDate'>;

function cacheKey(item: MediaItem): string | null {
  const ids = item.providerIds;
  if (ids?.tvmazeId) return `tvmaze:${ids.tvmazeId}`;
  if (ids?.tvdbId) return `tvdb:${ids.tvdbId}`;
  if (ids?.imdbId) return `imdb:${ids.imdbId}`;
  return null;
}

async function fetchSchedule(item: MediaItem): Promise<Scheduled[] | null> {
  const ids = item.providerIds || {};
  const showId = Number(ids.tvmazeId) || await lookupTvmazeShowId({ tvdbId: ids.tvdbId, imdbId: ids.imdbId });
  if (!showId) return null;
  const episodes = await fetchTVEpisodesById(showId);
  return episodes.map(({ season, number, title, airDate }) => ({ season, number, title, airDate }));
}

/**
 * Full episode lists by media ID for the TV shows given. Cached lists are
 * reused for 12 hours; with `offline` set, only the cache is read. A show
 * whose list cannot be fetched is simply absent, and callers fall back to the
 * episodes the library already has.
 */
export async function loadShowSchedules(
  database: BetterSqlite3.Database,
  items: readonly MediaItem[],
  options: { offline: boolean; now?: number },
): Promise<Map<string, Scheduled[]>> {
  const now = options.now ?? Date.now();
  const schedules = new Map<string, Scheduled[]>();
  const read = database.prepare('SELECT episodes_json, fetched_at FROM show_schedule_cache WHERE cache_key = ?');
  const write = database.prepare('INSERT OR REPLACE INTO show_schedule_cache (cache_key, episodes_json, fetched_at) VALUES (?, ?, ?)');
  const stale: Array<{ item: MediaItem; key: string }> = [];

  for (const item of items) {
    if (item.type !== 'tv') continue;
    const key = cacheKey(item);
    if (!key) continue;
    const row = read.get(key) as { episodes_json: string; fetched_at: number } | undefined;
    if (row) schedules.set(item.id, JSON.parse(row.episodes_json) as Scheduled[]);
    if (!options.offline && (!row || now - row.fetched_at > SCHEDULE_TTL_MS)) stale.push({ item, key });
  }

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, stale.length) }, async () => {
    while (next < stale.length) {
      const { item, key } = stale[next++];
      try {
        const schedule = await fetchSchedule(item);
        if (!schedule?.length) continue;
        write.run(key, JSON.stringify(schedule), now);
        schedules.set(item.id, schedule);
      } catch (error) {
        console.warn(`[schedule] Could not refresh the episode list for ${item.title}:`, error instanceof Error ? error.message : error);
      }
    }
  }));
  return schedules;
}
