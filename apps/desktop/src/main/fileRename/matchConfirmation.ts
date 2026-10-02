import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { MediaItem } from '../metadata/types.ts';
import { cleanMediaTitle, remoteMatchesAnyLocalTitle, seriesTitleFromEpisodeFileName } from '../metadata/helpers.ts';
import { titleAgrees } from './renamePlanner.ts';

/**
 * Before a file is renamed, every metadata source that covers its kind of
 * title is searched with the file's own name, independently of the match the
 * library already holds. The match counts as confirmed when at least two
 * sources land on the same title (the same IMDb, TMDB, TVDB, TVmaze or
 * MyAnimeList ID, with the year within one) and none lands somewhere else.
 * A source without a key, without the title, or offline neither confirms
 * nor contradicts.
 */

export type SourceName = 'tmdb' | 'omdb' | 'tvdb' | 'tvmaze' | 'anilist' | 'mal';

export const SOURCE_LABELS: Record<SourceName, string> = {
  tmdb: 'TMDB', omdb: 'OMDb', tvdb: 'TVDB', tvmaze: 'TVmaze', anilist: 'AniList', mal: 'MyAnimeList',
};

type Ids = { imdbId?: string; tmdbId?: string; tvdbId?: string; tvmazeId?: string; malId?: string };
const ID_KEYS = ['imdbId', 'tmdbId', 'tvdbId', 'tvmazeId', 'malId'] as const;

export type SourceRecord = {
  source: SourceName;
  ids: Ids;
  title: string;
  titles?: string[];
  year?: number;
};

export type MatchConfirmation = {
  checkedAt: number;
  /** The provider IDs the library held when this was checked. */
  anchor: string;
  searchedTitle: string;
  searchedYear?: number;
  asked: SourceName[];
  records: SourceRecord[];
};

export type MatchVerdict = {
  status: 'confirmed' | 'waiting' | 'conflict';
  confirmedBy: SourceName[];
  conflicts: SourceRecord[];
  /** Titles the confirming sources know the item by, for the title check. */
  knownTitles: string[];
  /** One line for the organize preview. */
  note: string;
};

type Identity = Pick<MediaItem, 'type' | 'title' | 'year' | 'providerIds'>;

function anchorIds(item: Identity): Ids {
  const ids = item.providerIds || {};
  return {
    imdbId: ids.imdbId || undefined,
    tmdbId: ids.tmdbId || undefined,
    tvdbId: ids.tvdbId || undefined,
    tvmazeId: ids.tvmazeId || undefined,
    malId: ids.malId || undefined,
  };
}

export function confirmationAnchor(item: Identity): string {
  const ids = anchorIds(item);
  return `${item.type}|${ID_KEYS.map((key) => ids[key] || '').join('|')}`;
}

function sourceList(sources: readonly SourceName[]): string {
  const labels = sources.map((source) => SOURCE_LABELS[source]);
  return labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export function evaluateConfirmation(item: Identity, confirmation: MatchConfirmation): MatchVerdict {
  const anchor = anchorIds(item);
  const confirmedBy: SourceName[] = [];
  const conflicts: SourceRecord[] = [];
  const knownTitles = new Set<string>();
  for (const record of confirmation.records) {
    const comparable = ID_KEYS.filter((key) => record.ids[key] && anchor[key]);
    const same = comparable.filter((key) => String(record.ids[key]) === String(anchor[key]));
    const yearAgrees = !record.year || !item.year || Math.abs(record.year - item.year) <= 1;
    let confirms = false;
    if (same.length > 0) {
      if (yearAgrees) confirms = true;
      else conflicts.push(record);
    } else if (comparable.length > 0) {
      conflicts.push(record);
    } else if ((record.source === 'anilist' || record.source === 'mal') && record.year && yearAgrees
      && [record.title, ...(record.titles || [])].some((title) => titleAgrees(title, [item.title]))) {
      // Anime databases share no IDs with the western ones; title and year must both agree.
      confirms = true;
    }
    if (confirms && !confirmedBy.includes(record.source)) {
      confirmedBy.push(record.source);
      for (const title of [record.title, ...(record.titles || [])]) if (title) knownTitles.add(title);
    }
  }
  const status = conflicts.length ? 'conflict' : confirmedBy.length >= 2 ? 'confirmed' : 'waiting';
  const note = status === 'conflict'
    ? conflicts.map((record) => `${SOURCE_LABELS[record.source]} found "${record.title}"${record.year ? ` (${record.year})` : ''} for this file instead.`).join(' ')
    : status === 'confirmed'
      ? `Confirmed by ${sourceList(confirmedBy)}.`
      : confirmedBy.length === 1
        ? `Only ${SOURCE_LABELS[confirmedBy[0]]} confirmed this match. It waits for a second source, or for your approval.`
        : 'No metadata source confirmed this match yet. It waits, or you can approve it.';
  return { status, confirmedBy, conflicts, knownTitles: [...knownTitles], note };
}

/** Which sources can know this kind of title. */
export function sourcesFor(item: Identity, likelyAnime: boolean): SourceName[] {
  if (item.type === 'movie') return likelyAnime ? ['tmdb', 'omdb', 'tvdb', 'anilist', 'mal'] : ['tmdb', 'omdb', 'tvdb'];
  return item.type === 'anime' || likelyAnime
    ? ['tmdb', 'omdb', 'tvdb', 'tvmaze', 'anilist', 'mal']
    : ['tmdb', 'omdb', 'tvdb', 'tvmaze'];
}

/**
 * The title and year to search with, taken from the file or folder as named
 * on disk rather than from the library's match. A movie's own folder is used
 * when the file name holds no title; a show uses its folder, or the series
 * name in a loose episode's file name.
 */
export function searchTermsFor(item: Pick<MediaItem, 'type' | 'filePath' | 'title' | 'year'>, libraryRoots: readonly string[]): { title: string; year?: number } {
  const isRoot = (folder: string) => libraryRoots.some((root) => path.resolve(root) === path.resolve(folder));
  const name = path.basename(item.filePath);
  const stem = name.replace(/\.[a-z0-9]{2,4}$/i, '');
  const fromName = (value: string) => {
    const cleaned = cleanMediaTitle(value);
    return cleaned.title.trim() ? { title: cleaned.title.trim(), year: cleaned.year || undefined } : null;
  };
  if (item.type === 'movie') {
    const parent = path.dirname(item.filePath);
    return fromName(stem) || (isRoot(parent) ? null : fromName(path.basename(parent))) || { title: item.title, year: item.year || undefined };
  }
  const series = /\.[a-z0-9]{2,4}$/i.test(name) ? seriesTitleFromEpisodeFileName(name) : null;
  return (series && fromName(series)) || fromName(name) || { title: item.title, year: item.year || undefined };
}

type Found = Partial<Pick<MediaItem, 'title' | 'year' | 'providerIds'>> & { aliases?: string[]; malId?: number };

export type ConfirmationSources = {
  tmdbMovie?: (title: string, year?: number) => Promise<Found | null>;
  tmdbShow?: (title: string, year?: number) => Promise<Found | null>;
  omdb?: (title: string, year: number | undefined, type: 'movie' | 'series') => Promise<{ Title?: string; Year?: string; imdbID?: string } | null>;
  tvdb?: (title: string, year: number | undefined, type: 'movie' | 'series') => Promise<{ title: string; titles: string[]; year?: number; providerIds: MediaItem['providerIds'] } | null>;
  tvmaze?: (title: string, year?: number) => Promise<Found | null>;
  anilist?: (title: string) => Promise<Found | null>;
  mal?: (title: string) => Promise<Found | null>;
};

function idsOf(providerIds: MediaItem['providerIds'] | undefined, extra: Ids = {}): Ids {
  const ids = providerIds || {};
  return {
    imdbId: ids.imdbId || extra.imdbId,
    tmdbId: ids.tmdbId || extra.tmdbId,
    tvdbId: ids.tvdbId || extra.tvdbId,
    tvmazeId: ids.tvmazeId || extra.tvmazeId,
    malId: ids.malId || extra.malId,
  };
}

/** Search every applicable source. A failing source is left out, never fatal. */
export async function gatherConfirmation(
  item: Identity,
  search: { title: string; year?: number },
  sources: ConfirmationSources,
  options: { likelyAnime?: boolean; now?: number } = {},
): Promise<MatchConfirmation> {
  const asked = sourcesFor(item, Boolean(options.likelyAnime));
  const kind = item.type === 'movie' ? 'movie' : 'series';
  const searched = [search.title];
  // A source's answer only counts when it is about the searched title.
  const about = (titles: Array<string | undefined>) => titles.some((title) => remoteMatchesAnyLocalTitle(searched, title || ''));
  const lookups: Record<SourceName, () => Promise<SourceRecord | null>> = {
    tmdb: async () => {
      const found = await (kind === 'movie' ? sources.tmdbMovie : sources.tmdbShow)?.(search.title, search.year);
      return found?.title && about([found.title]) ? { source: 'tmdb', ids: idsOf(found.providerIds), title: found.title, year: found.year || undefined } : null;
    },
    omdb: async () => {
      const found = await sources.omdb?.(search.title, search.year, kind);
      const year = Number(found?.Year?.slice(0, 4)) || undefined;
      return found?.Title && found.imdbID && about([found.Title]) ? { source: 'omdb', ids: { imdbId: found.imdbID }, title: found.Title, year } : null;
    },
    tvdb: async () => {
      const found = await sources.tvdb?.(search.title, search.year, kind);
      return found ? { source: 'tvdb', ids: idsOf(found.providerIds), title: found.title, titles: found.titles, year: found.year } : null;
    },
    tvmaze: async () => {
      const found = kind === 'series' ? await sources.tvmaze?.(search.title, search.year) : null;
      return found?.title && about([found.title]) ? { source: 'tvmaze', ids: idsOf(found.providerIds), title: found.title, year: found.year || undefined } : null;
    },
    anilist: async () => {
      const found = await sources.anilist?.(search.title);
      if (!found?.title || !about([found.title, ...(found.aliases || [])])) return null;
      return { source: 'anilist', ids: { malId: found.malId ? String(found.malId) : found.providerIds?.malId }, title: found.title, titles: found.aliases, year: found.year || undefined };
    },
    mal: async () => {
      const found = await sources.mal?.(search.title);
      if (!found?.title || !about([found.title, ...(found.aliases || [])])) return null;
      return { source: 'mal', ids: { malId: found.malId ? String(found.malId) : found.providerIds?.malId }, title: found.title, titles: found.aliases, year: found.year || undefined };
    },
  };
  const records = await Promise.all(asked.map(async (source) => {
    try {
      return await lookups[source]();
    } catch {
      return null;
    }
  }));
  return {
    checkedAt: options.now ?? Date.now(),
    anchor: confirmationAnchor(item),
    searchedTitle: search.title,
    searchedYear: search.year,
    asked,
    records: records.filter((record): record is SourceRecord => Boolean(record)),
  };
}

/** How long a stored check stays valid before the sources are asked again. */
export function confirmationIsFresh(confirmation: MatchConfirmation, item: Identity, now = Date.now()): boolean {
  if (confirmation.anchor !== confirmationAnchor(item)) return false;
  const verdict = evaluateConfirmation(item, confirmation);
  // A confirmed match stays confirmed; an unconfirmed one is asked again
  // daily, since databases add new titles after release.
  return verdict.status === 'confirmed' || now - confirmation.checkedAt < 24 * 60 * 60 * 1000;
}

/** Stored source checks, one per library item. */
export function createMatchConfirmationStore(getDatabase: () => BetterSqlite3.Database) {
  function get(mediaId: string): MatchConfirmation | null {
    const row = getDatabase().prepare('SELECT result_json FROM media_match_confirmations WHERE media_id = ?').get(mediaId) as { result_json?: string } | undefined;
    if (!row?.result_json) return null;
    try {
      const parsed = JSON.parse(row.result_json) as MatchConfirmation;
      return Array.isArray(parsed.records) && typeof parsed.anchor === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  function set(mediaId: string, confirmation: MatchConfirmation): void {
    getDatabase()
      .prepare('INSERT OR REPLACE INTO media_match_confirmations (media_id, checked_at, result_json) VALUES (?, ?, ?)')
      .run(mediaId, confirmation.checkedAt, JSON.stringify(confirmation));
  }
  return { get, set };
}
