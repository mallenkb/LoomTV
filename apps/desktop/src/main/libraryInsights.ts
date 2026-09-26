import path from 'node:path';
import type { MediaItem } from './metadata/types.ts';

/**
 * What changed in the library and what needs attention, for the active
 * profile: new and upcoming episodes, missing episodes, recently added
 * titles, and the Library health report. Pure over its inputs so it can be
 * checked without Electron.
 */

export type EpisodeRef = {
  season: number;
  episode: number;
  title: string;
  airDate?: string;
  addedAt?: number;
};

export type ShowEpisodeUpdates = {
  mediaId: string;
  title: string;
  type: MediaItem['type'];
  /** Episode files added in the last week that this profile has not watched. */
  newEpisodes: EpisodeRef[];
  /** The next episode with a future air date. */
  nextAirs: EpisodeRef | null;
  /** Aired episodes missing from seasons you have at least one episode of. */
  missing: EpisodeRef[];
};

export type RecentlyAddedEntry = {
  mediaId: string;
  title: string;
  type: MediaItem['type'];
  addedAt: number;
  /** "S01E03" for an episode; empty for a movie. */
  label: string;
};

export type EpisodeUpdates = {
  shows: ShowEpisodeUpdates[];
  recentlyAdded: RecentlyAddedEntry[];
};

export type InsightInputs = {
  /** Watched state per file path for the active profile. */
  progress: Record<string, { position: number; duration: number; watched: boolean }>;
  now: number;
  /** When a file arrived in the library (creation time on disk), or null. */
  addedAt: (filePath: string) => number | null;
  /** A show's full episode list (not just episodes on disk), by media ID. */
  schedules?: ReadonlyMap<string, ReadonlyArray<{ season: number; number: number; title: string; airDate: string }>>;
};

const NEW_EPISODE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENTLY_ADDED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const RECENTLY_ADDED_LIMIT = 30;
const WATCHED_FRACTION = 0.9;

export function localDate(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function watched(progress: InsightInputs['progress'], filePath: string): boolean {
  const entry = progress[filePath];
  return Boolean(entry && (entry.watched || (entry.duration > 0 && entry.position / entry.duration >= WATCHED_FRACTION)));
}

const episodeCode = (season: number, episode: number) => `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

export function computeEpisodeUpdates(items: readonly MediaItem[], inputs: InsightInputs): EpisodeUpdates {
  const today = localDate(inputs.now);
  const shows: ShowEpisodeUpdates[] = [];
  const recentlyAdded: RecentlyAddedEntry[] = [];

  for (const item of items) {
    if (item.type === 'movie') {
      const addedAt = inputs.addedAt(item.filePath);
      if (addedAt && inputs.now - addedAt <= RECENTLY_ADDED_WINDOW_MS) {
        recentlyAdded.push({ mediaId: item.id, title: item.title, type: item.type, addedAt, label: '' });
      }
      continue;
    }

    const files = item.episodeFiles || [];
    const metaTitle = new Map((item.episodes || []).map((episode) => [`${episode.season}:${episode.number}`, episode.title || '']));
    const newEpisodes: EpisodeRef[] = [];
    let newestAdded = 0;
    let newestFile: (typeof files)[number] | null = null;
    for (const file of files) {
      const addedAt = inputs.addedAt(file.filePath);
      if (!addedAt) continue;
      if (addedAt > newestAdded) {
        newestAdded = addedAt;
        newestFile = file;
      }
      if (inputs.now - addedAt <= NEW_EPISODE_WINDOW_MS && !watched(inputs.progress, file.filePath)) {
        newEpisodes.push({ season: file.season, episode: file.episode, title: metaTitle.get(`${file.season}:${file.episode}`) || '', addedAt });
      }
    }
    if (newestFile && inputs.now - newestAdded <= RECENTLY_ADDED_WINDOW_MS) {
      recentlyAdded.push({ mediaId: item.id, title: item.title, type: item.type, addedAt: newestAdded, label: episodeCode(newestFile.season, newestFile.episode) });
    }

    const have = new Set(files.map((file) => `${file.season}:${file.episode}`));
    const seasonsHeld = new Set(files.map((file) => file.season).filter((season) => season > 0));
    // The library only keeps episodes it has files for; the full list, when
    // known, is what reveals gaps and what airs next.
    const allEpisodes = inputs.schedules?.get(item.id) || item.episodes || [];
    const upcoming = allEpisodes
      .filter((episode) => episode.season > 0 && episode.airDate && episode.airDate > today)
      .sort((left, right) => left.airDate.localeCompare(right.airDate) || left.season - right.season || left.number - right.number)[0];
    const missing = allEpisodes
      .filter((episode) => seasonsHeld.has(episode.season)
        && episode.airDate && episode.airDate <= today
        && !have.has(`${episode.season}:${episode.number}`))
      .sort((left, right) => left.season - right.season || left.number - right.number)
      .map((episode) => ({ season: episode.season, episode: episode.number, title: episode.title || '', airDate: episode.airDate }));

    newEpisodes.sort((left, right) => left.season - right.season || left.episode - right.episode);
    if (newEpisodes.length || upcoming || missing.length) {
      shows.push({
        mediaId: item.id,
        title: item.title,
        type: item.type,
        newEpisodes,
        nextAirs: upcoming ? { season: upcoming.season, episode: upcoming.number, title: upcoming.title || '', airDate: upcoming.airDate } : null,
        missing,
      });
    }
  }

  recentlyAdded.sort((left, right) => right.addedAt - left.addedAt);
  return { shows, recentlyAdded: recentlyAdded.slice(0, RECENTLY_ADDED_LIMIT) };
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
