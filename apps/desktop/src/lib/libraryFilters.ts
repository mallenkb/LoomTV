import type { MediaItem, TVShow } from '@/contexts/LibraryContext';
import type { StoredProgress } from '@/lib/desktopApi';

export type LibraryFilter = 'all' | 'my-list' | 'favorites' | 'in-progress' | 'unwatched' | 'watched' | 'missing-metadata' | 'missing-artwork';

export interface LibraryFilterOption {
  id: LibraryFilter;
  label: string;
}

export interface LibraryListEntryLike {
  mediaId: string;
  kind: string;
}

export interface LibraryListState {
  myListIds: ReadonlySet<string>;
  favoriteIds: ReadonlySet<string>;
}

export const CONTINUE_WATCHING_LIMIT = 5;

export const primaryLibraryFilterOptions: LibraryFilterOption[] = [
  { id: 'all', label: 'All' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'unwatched', label: 'Unwatched' },
  { id: 'watched', label: 'Watched' },
];

export const personalLibraryFilterOptions: LibraryFilterOption[] = [
  { id: 'my-list', label: 'My List' },
  { id: 'favorites', label: 'Favorites' },
];

export const issueLibraryFilterOptions: LibraryFilterOption[] = [
  { id: 'missing-metadata', label: 'Missing Metadata' },
  { id: 'missing-artwork', label: 'Missing Artwork' },
];

export const libraryFilterOptions: LibraryFilterOption[] = [
  ...primaryLibraryFilterOptions,
  ...personalLibraryFilterOptions,
  ...issueLibraryFilterOptions,
];

export function createLibraryListState(entries: readonly LibraryListEntryLike[]): LibraryListState {
  return {
    myListIds: new Set(entries
      .filter((entry) => entry.kind === 'watchlist' || entry.kind === 'favorite')
      .map((entry) => entry.mediaId)),
    favoriteIds: new Set(entries
      .filter((entry) => entry.kind === 'favorite')
      .map((entry) => entry.mediaId)),
  };
}

const WATCHED_THRESHOLD = 0.9;

function progressFor(filePath: string | undefined, progress: Record<string, StoredProgress>): StoredProgress | null {
  if (!filePath) return null;
  return progress[filePath] || null;
}

function progressFraction(stored: StoredProgress | null, durationHint = 0): number {
  const position = stored?.position || 0;
  const duration = durationHint > 0 ? durationHint : stored?.duration || 0;
  return position > 0 && duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
}

function isProgressWatched(stored: StoredProgress | null, durationHint = 0): boolean {
  return Boolean(stored?.watched) || progressFraction(stored, durationHint) >= WATCHED_THRESHOLD;
}

function movieProgressState(movie: MediaItem, progress: Record<string, StoredProgress>) {
  const stored = progressFor(movie.filePath, progress);
  const fraction = progressFraction(stored, movie.localMetadata?.durationSeconds);
  return {
    inProgress: (stored?.position || 0) > 10 && fraction > 0 && fraction < WATCHED_THRESHOLD,
    watched: isProgressWatched(stored, movie.localMetadata?.durationSeconds),
  };
}

function showProgressState(show: TVShow, progress: Record<string, StoredProgress>) {
  const episodeFiles = show.episodeFiles || [];
  const episodeStates = episodeFiles.map((file) => {
    const stored = progressFor(file.filePath, progress);
    const fraction = progressFraction(stored, file.localMetadata?.durationSeconds);
    return {
      inProgress: (stored?.position || 0) > 10 && fraction > 0 && fraction < WATCHED_THRESHOLD,
      watched: isProgressWatched(stored, file.localMetadata?.durationSeconds),
    };
  });

  const watchedCount = episodeStates.filter((state) => state.watched).length;
  return {
    inProgress: episodeStates.some((state) => state.inProgress),
    watched: episodeFiles.length > 0 && watchedCount === episodeFiles.length,
    partiallyWatched: watchedCount > 0,
  };
}

/**
 * Return the five most recently played titles whose latest playback file is
 * still unfinished. A completed movie or episode leaves Continue Watching;
 * the title returns once playback resumes in another file.
 */
export function selectContinueWatchingItems(
  items: readonly MediaItem[],
  progress: Record<string, StoredProgress>,
): MediaItem[] {
  return items
    .map((item) => {
      const candidates = [
        { filePath: item.filePath, durationHint: item.localMetadata?.durationSeconds || 0 },
        ...(item.episodeFiles || []).map((episode) => ({
          filePath: episode.filePath,
          durationHint: episode.localMetadata?.durationSeconds || 0,
        })),
      ];
      const latest = candidates
        .map((candidate) => ({ ...candidate, stored: progress[candidate.filePath] }))
        .filter((candidate): candidate is typeof candidate & { stored: StoredProgress } => Boolean(candidate.stored))
        .sort((left, right) => (right.stored.updatedAt || 0) - (left.stored.updatedAt || 0))[0];
      if (!latest || (latest.stored.updatedAt || 0) <= 0) return null;
      if ((latest.stored.position || 0) <= 10 || isProgressWatched(latest.stored, latest.durationHint)) return null;
      return { item, updatedAt: latest.stored.updatedAt || 0 };
    })
    .filter((entry): entry is { item: MediaItem; updatedAt: number } => Boolean(entry))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, CONTINUE_WATCHING_LIMIT)
    .map(({ item }) => item);
}

function hasMetadata(item: MediaItem | TVShow): boolean {
  return Boolean(
    item.summary?.trim()
    || item.rating > 0
    || item.genres?.length
    || ('episodes' in item && item.episodes?.some((episode) => episode.title || episode.airDate || episode.rating > 0))
  );
}

function hasArtwork(item: MediaItem | TVShow): boolean {
  return Boolean(
    item.poster
    || item.backdrop
    || item.posterCandidates?.length
    || item.backdropCandidates?.length
  );
}

export function matchesLibraryFilter(
  item: MediaItem | TVShow,
  filter: LibraryFilter,
  progress: Record<string, StoredProgress>,
  listState?: LibraryListState,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'my-list') return Boolean(listState?.myListIds.has(item.id));
  if (filter === 'favorites') return Boolean(listState?.favoriteIds.has(item.id));
  if (filter === 'missing-metadata') return !hasMetadata(item);
  if (filter === 'missing-artwork') return !hasArtwork(item);

  if (item.type === 'movie') {
    const state = movieProgressState(item, progress);
    if (filter === 'in-progress') return state.inProgress;
    if (filter === 'watched') return state.watched;
    if (filter === 'unwatched') return !state.inProgress && !state.watched;
    return true;
  }

  const state = showProgressState(item as TVShow, progress);
  if (filter === 'in-progress') return state.inProgress;
  if (filter === 'watched') return state.watched;
  if (filter === 'unwatched') return !state.inProgress && !state.partiallyWatched;
  return true;
}
