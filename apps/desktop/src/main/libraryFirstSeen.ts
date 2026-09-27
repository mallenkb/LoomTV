import type BetterSqlite3 from 'better-sqlite3';
import type { MediaItem } from './metadata/types.ts';

/**
 * When LoomTV first saw each title and episode, for the "New" badges.
 *
 * Keys come from what a thing is (its metadata IDs, season, and episode
 * number), not where its file is, so renaming, moving, or re-copying a file
 * does not make it look new while it remains in the library. A completed
 * scan confirming its absence allows a later addition to get a fresh date. The file's own dates are used only once, to
 * backfill a library that existed before this table did.
 *
 * A scan that brings in a lot at once (a first scan, a new drive) is marked
 * `bulk`, and nothing in it gets a badge.
 */

export type FirstSeen = { at: number; bulk: boolean };

/** More new titles than this in one pass counts as a bulk import. */
export const BULK_NEW_TITLES = 20;
/** More new episodes than this in one pass counts as a bulk import. */
export const BULK_NEW_EPISODES = 150;

/**
 * Every name a title goes by: each metadata ID it has, plus its name and
 * year. A title is known if any of them was seen, so gaining or changing a
 * match later doesn't make it look new.
 */
export function titleSeenKeys(item: Pick<MediaItem, 'type' | 'title' | 'year' | 'providerIds'>): string[] {
  const ids = item.providerIds || {};
  const keys = [
    ids.tmdbId && `tmdb:${ids.tmdbId}`,
    ids.tvdbId && `tvdb:${ids.tvdbId}`,
    ids.imdbId && `imdb:${ids.imdbId}`,
    ids.tvmazeId && `tvmaze:${ids.tvmazeId}`,
    ids.malId && `mal:${ids.malId}`,
    `name:${item.title.trim().toLowerCase()}:${item.year || ''}`,
  ].filter((key): key is string => Boolean(key));
  return keys.map((key) => `${item.type}|${key}`);
}

export function episodeSeenKeys(item: Pick<MediaItem, 'type' | 'title' | 'year' | 'providerIds'>, season: number, episode: number): string[] {
  return titleSeenKeys(item).map((key) => `${key}|s${season}e${episode}`);
}

/** The first-seen date under any of a thing's keys. */
export function lookupFirstSeen(seen: ReadonlyMap<string, FirstSeen>, keys: readonly string[]): FirstSeen | null {
  let found: FirstSeen | null = null;
  for (const key of keys) {
    const entry = seen.get(key);
    if (entry && (!found || entry.at < found.at)) found = entry;
  }
  return found;
}

type Candidate = { keys: string[]; title: boolean; fileTime: number | null };

function candidates(items: readonly MediaItem[], fileTime: (filePath: string) => number | null): Candidate[] {
  const out: Candidate[] = [];
  for (const item of items) {
    const files = item.type === 'movie' ? [] : item.episodeFiles || [];
    const times = files.map((file) => fileTime(file.filePath)).filter((time): time is number => Boolean(time));
    out.push({ keys: titleSeenKeys(item), title: true, fileTime: item.type === 'movie' ? fileTime(item.filePath) : times.length ? Math.min(...times) : null });
    for (const file of files) out.push({ keys: episodeSeenKeys(item, file.season, file.episode), title: false, fileTime: fileTime(file.filePath) });
  }
  return out;
}

/**
 * Records anything not seen before and returns every first-seen date.
 * Safe to call on every read: already-known keys are left untouched.
 */
export function recordFirstSeen(
  database: BetterSqlite3.Database,
  items: readonly MediaItem[],
  options: { now: number; fileTime: (filePath: string) => number | null; reconcilePresence?: boolean },
): Map<string, FirstSeen> {
  const known = new Map<string, FirstSeen>();
  const rows = database.prepare('SELECT seen_key, first_seen_at, bulk, present FROM library_first_seen').all() as Array<{ seen_key: string; first_seen_at: number; bulk: number; present: number }>;
  for (const row of rows) {
    if (row.present === 1) known.set(row.seen_key, { at: row.first_seen_at, bulk: row.bulk === 1 });
  }
  const backfill = rows.length === 0;
  const current = candidates(items, options.fileTime);
  const currentKeys = new Set(current.flatMap((candidate) => candidate.keys));
  // Only a completed scan can confirm absence. Reads and partial scans cannot.
  const absent = options.reconcilePresence
    ? [...known.keys()].filter((key) => !currentKeys.has(key))
    : [];
  // Things never seen under any key are new; things seen under some keys
  // just get their other keys filled in with the same date.
  const fresh: Candidate[] = [];
  const aliases: Array<{ key: string; seen: FirstSeen }> = [];
  const claimed = new Set<string>();
  for (const candidate of current) {
    const seen = lookupFirstSeen(known, candidate.keys);
    if (seen) {
      for (const key of candidate.keys) if (!known.has(key)) aliases.push({ key, seen });
    } else if (!candidate.keys.some((key) => claimed.has(key))) {
      candidate.keys.forEach((key) => claimed.add(key));
      fresh.push(candidate);
    }
  }
  if (!fresh.length && !aliases.length && !absent.length) return known;

  const newTitles = fresh.filter((candidate) => candidate.title).length;
  const bulk = !backfill && (newTitles > BULK_NEW_TITLES || fresh.length - newTitles > BULK_NEW_EPISODES);
  const insert = database.prepare(`INSERT INTO library_first_seen (seen_key, first_seen_at, bulk, present) VALUES (?, ?, ?, 1)
    ON CONFLICT(seen_key) DO UPDATE SET first_seen_at = excluded.first_seen_at, bulk = excluded.bulk, present = 1
    WHERE library_first_seen.present = 0`);
  const markAbsent = database.prepare('UPDATE library_first_seen SET present = 0 WHERE seen_key = ?');
  database.transaction(() => {
    for (const key of absent) {
      markAbsent.run(key);
      known.delete(key);
    }
    for (const { key, seen } of aliases) {
      insert.run(key, seen.at, seen.bulk ? 1 : 0);
      known.set(key, seen);
    }
    for (const candidate of fresh) {
      // A library from before this table keeps its files' dates, so what was
      // new last week still is; everything after is dated when LoomTV saw it.
      const at = backfill ? Math.min(candidate.fileTime || options.now, options.now) : options.now;
      for (const key of candidate.keys) {
        insert.run(key, at, bulk ? 1 : 0);
        known.set(key, { at, bulk });
      }
    }
  })();
  return known;
}
