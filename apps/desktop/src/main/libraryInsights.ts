import path from 'node:path';
import type { MediaItem } from './metadata/types.ts';
import { episodeSeenKeys, lookupFirstSeen, titleSeenKeys, type FirstSeen } from './libraryFirstSeen.ts';

/**
 * What changed in the library and what needs attention, for the active
 * profile: new and upcoming episodes, missing episodes, and the Library
 * health report. Pure over its inputs so it can be
 * checked without Electron.
 */

export type EpisodeRef = {
  season: number;
  episode: number;
  title: string;
  airDate?: string;
  addedAt?: number;
  summary?: string;
  still?: string;
};

export type ShowEpisodeUpdates = {
  mediaId: string;
  title: string;
  type: MediaItem['type'];
  /** Unstarted episodes that arrived in the last 14 days, for a show this profile follows. */
  newEpisodes: EpisodeRef[];
  /** A season that arrived in the last 21 days that this profile hasn't started, for a show it follows. */
  newSeason: number | null;
  /** The next episode with a future air date. */
  nextAirs: EpisodeRef | null;
  /** Aired episodes missing from seasons you have at least one episode of. */
  missing: EpisodeRef[];
};

export type EpisodeUpdates = {
  shows: ShowEpisodeUpdates[];
  /** Movies and shows LoomTV first saw in the last 7 days that this profile hasn't started. */
  newlyAdded: string[];
};

export type InsightInputs = {
  /** Watched state per file path for the active profile. */
  progress: Record<string, { position: number; duration: number; watched: boolean }>;
  now: number;
  /** When LoomTV first saw each title and episode (see libraryFirstSeen). */
  seen: ReadonlyMap<string, FirstSeen>;
  /** A show's full episode list (not just episodes on disk), by media ID. */
  schedules?: ReadonlyMap<string, ReadonlyArray<{ season: number; number: number; title: string; airDate: string; summary?: string; still?: string }>>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long each badge lasts at most; each also ends once you start watching. */
export const NEW_EPISODE_WINDOW_MS = 14 * DAY_MS;
export const NEW_SEASON_WINDOW_MS = 21 * DAY_MS;
export const NEWLY_ADDED_WINDOW_MS = 7 * DAY_MS;

export function localDate(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startedOrWatched(progress: InsightInputs['progress'], filePath: string): boolean {
  const entry = progress[filePath];
  return Boolean(entry && (entry.watched || entry.position > 0));
}

const episodeCode = (season: number, episode: number) => `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

export function computeEpisodeUpdates(items: readonly MediaItem[], inputs: InsightInputs): EpisodeUpdates {
  const today = localDate(inputs.now);
  const shows: ShowEpisodeUpdates[] = [];
  const newlyAdded: string[] = [];
  const recent = (seen: FirstSeen | null, window: number): seen is FirstSeen => Boolean(seen && !seen.bulk && inputs.now - seen.at <= window);

  for (const item of items) {
    const titleSeen = lookupFirstSeen(inputs.seen, titleSeenKeys(item));
    if (item.type === 'movie') {
      if (recent(titleSeen, NEWLY_ADDED_WINDOW_MS) && !startedOrWatched(inputs.progress, item.filePath)) newlyAdded.push(item.id);
      continue;
    }

    const files = item.episodeFiles || [];
    // Following a show means having started at least one of its episodes.
    const following = files.some((file) => startedOrWatched(inputs.progress, file.filePath));
    if (!following && recent(titleSeen, NEWLY_ADDED_WINDOW_MS)) newlyAdded.push(item.id);

    const metaTitle = new Map((item.episodes || []).map((episode) => [`${episode.season}:${episode.number}`, episode.title || '']));
    const episodeSeen = new Map(files.map((file) => [file, lookupFirstSeen(inputs.seen, episodeSeenKeys(item, file.season, file.episode))]));
    const newEpisodes: EpisodeRef[] = [];
    if (following) {
      for (const file of files) {
        const seen = episodeSeen.get(file) || null;
        if (recent(seen, NEW_EPISODE_WINDOW_MS) && !startedOrWatched(inputs.progress, file.filePath)) {
          newEpisodes.push({ season: file.season, episode: file.episode, title: metaTitle.get(`${file.season}:${file.episode}`) || '', addedAt: seen.at });
        }
      }
    }

    // A new season: every episode of it arrived recently, the show was in the
    // library before that, and none of the season has been started.
    let newSeason: number | null = null;
    if (following) {
      for (const season of [...new Set(files.map((file) => file.season))].filter((number) => number > 0).sort((a, b) => b - a)) {
        const seasonFiles = files.filter((file) => file.season === season);
        const arrivedRecently = seasonFiles.every((file) => recent(episodeSeen.get(file) || null, NEW_SEASON_WINDOW_MS));
        const earliest = Math.min(...seasonFiles.map((file) => episodeSeen.get(file)?.at ?? inputs.now));
        const hadShowBefore = files.some((file) => file.season !== season && (episodeSeen.get(file)?.at ?? inputs.now) < earliest);
        if (arrivedRecently && hadShowBefore && !seasonFiles.some((file) => startedOrWatched(inputs.progress, file.filePath))) {
          newSeason = season;
          break;
        }
      }
    }

    const have = new Set(files.map((file) => `${file.season}:${file.episode}`));
    const seasonsHeld = new Set(files.map((file) => file.season).filter((season) => season > 0));
    // The library only keeps episodes it has files for; the full list, when
    // known, is what reveals gaps and what airs next.
    const allEpisodes = inputs.schedules?.get(item.id) || item.episodes || [];
    const upcoming = allEpisodes
      // An episode airing today is still "next" until its file arrives; it
      // only counts as missing from tomorrow, since release times vary.
      .filter((episode) => episode.season > 0 && episode.airDate
        && (episode.airDate > today || (episode.airDate === today && !have.has(`${episode.season}:${episode.number}`))))
      .sort((left, right) => left.airDate.localeCompare(right.airDate) || left.season - right.season || left.number - right.number)[0];
    const missing = allEpisodes
      .filter((episode) => seasonsHeld.has(episode.season)
        && episode.airDate && episode.airDate < today
        && !have.has(`${episode.season}:${episode.number}`))
      .sort((left, right) => left.season - right.season || left.number - right.number)
      .map((episode) => ({ season: episode.season, episode: episode.number, title: episode.title || '', airDate: episode.airDate, summary: episode.summary || '', still: episode.still || '' }));

    newEpisodes.sort((left, right) => left.season - right.season || left.episode - right.episode);
    if (newEpisodes.length || newSeason !== null || upcoming || missing.length) {
      shows.push({
        mediaId: item.id,
        title: item.title,
        type: item.type,
        newEpisodes,
        newSeason,
        nextAirs: upcoming ? { season: upcoming.season, episode: upcoming.number, title: upcoming.title || '', airDate: upcoming.airDate } : null,
        missing,
      });
    }
  }

  return { shows, newlyAdded };
}

export type LibraryHealthReport = {
  /** Titles LoomTV could not match to metadata. */
  unmatched: Array<{ mediaId: string; title: string; type: MediaItem['type']; fileName: string }>;
  /** Shows found in more than one folder. */
  splitShows: Array<{ title: string; folders: string[] }>;
  /** Movies and episodes with no subtitles at all, grouped by title. */
  noSubtitles: Array<{ mediaId: string; title: string; type: MediaItem['type']; files: number }>;
  /** Shows with aired episodes missing, from computeEpisodeUpdates. */
  missingEpisodes: Array<{ mediaId: string; title: string; count: number; examples: string[] }>;
  /** Files the rename preview leaves alone, with why. */
  renameSkipped: Array<{ title: string; fileName: string; reason: string }>;
};

function hasMatch(item: MediaItem): boolean {
  const ids = item.providerIds;
  return Boolean(ids?.tmdbId || ids?.imdbId || ids?.tvdbId || ids?.tvmazeId || ids?.malId || Object.keys(ids?.malIdBySeason || {}).length);
}

function subtitleCount(details: MediaItem['localMetadata'], sidecars: readonly unknown[] | undefined): number {
  const embedded = details?.subtitleTracks ?? details?.tracks?.filter((track) => track.type === 'subtitle').length ?? 0;
  return embedded + (sidecars?.length || 0);
}

export function computeLibraryHealth(
  items: readonly MediaItem[],
  updates: EpisodeUpdates,
  renameSkipped: LibraryHealthReport['renameSkipped'],
): LibraryHealthReport {
  const unmatched = items
    .filter((item) => !hasMatch(item))
    .map((item) => ({ mediaId: item.id, title: item.title, type: item.type, fileName: path.basename(item.filePath) }));

  const byShowId = new Map<string, MediaItem[]>();
  for (const item of items) {
    if (item.type === 'movie') continue;
    const ids = item.providerIds;
    const key = ids?.tvdbId ? `tvdb:${ids.tvdbId}` : ids?.tmdbId ? `tmdb:${ids.tmdbId}` : ids?.tvmazeId ? `tvmaze:${ids.tvmazeId}` : '';
    if (key) byShowId.set(`${item.type}:${key}`, [...(byShowId.get(`${item.type}:${key}`) || []), item]);
  }
  const splitShows = [...byShowId.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ title: group[0].title, folders: group.map((item) => item.filePath) }));

  const noSubtitles: LibraryHealthReport['noSubtitles'] = [];
  for (const item of items) {
    if (item.type === 'movie') {
      // Unknown track details are not evidence of missing subtitles.
      if (item.localMetadata && subtitleCount(item.localMetadata, item.subtitles) === 0) {
        noSubtitles.push({ mediaId: item.id, title: item.title, type: item.type, files: 1 });
      }
      continue;
    }
    const without = (item.episodeFiles || []).filter((file) => file.localMetadata && subtitleCount(file.localMetadata, file.subtitles) === 0).length;
    if (without) noSubtitles.push({ mediaId: item.id, title: item.title, type: item.type, files: without });
  }

  const missingEpisodes = updates.shows
    .filter((show) => show.missing.length)
    .map((show) => ({
      mediaId: show.mediaId,
      title: show.title,
      count: show.missing.length,
      examples: show.missing.slice(0, 4).map((episode) => episodeCode(episode.season, episode.episode)),
    }));

  return { unmatched, splitShows, noSubtitles, missingEpisodes, renameSkipped };
}
