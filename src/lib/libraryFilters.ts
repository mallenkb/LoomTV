import type { MediaItem, TVShow } from '@/contexts/LibraryContext';
import type { StoredProgress } from '@/lib/desktopApi';

export type LibraryFilter = 'all' | 'in-progress' | 'unwatched' | 'watched' | 'missing-metadata' | 'missing-artwork';

export const libraryFilterOptions: Array<{ id: LibraryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'unwatched', label: 'Unwatched' },
  { id: 'watched', label: 'Watched' },
  { id: 'missing-metadata', label: 'Missing Metadata' },
  { id: 'missing-artwork', label: 'Missing Artwork' },
];

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

function movieProgressState(movie: MediaItem, progress: Record<string, StoredProgress>) {
  const stored = progressFor(movie.filePath, progress);
  const fraction = progressFraction(stored, movie.localMetadata?.durationSeconds);
  return {
    inProgress: (stored?.position || 0) > 10 && fraction > 0 && fraction < WATCHED_THRESHOLD,
    watched: Boolean(stored?.watched) || fraction >= WATCHED_THRESHOLD,
  };
}

function showProgressState(show: TVShow, progress: Record<string, StoredProgress>) {
  const episodeFiles = show.episodeFiles || [];
  const episodeStates = episodeFiles.map((file) => {
    const stored = progressFor(file.filePath, progress);
    const fraction = progressFraction(stored, file.localMetadata?.durationSeconds);
    return {
      inProgress: (stored?.position || 0) > 10 && fraction > 0 && fraction < WATCHED_THRESHOLD,
      watched: Boolean(stored?.watched) || fraction >= WATCHED_THRESHOLD,
    };
  });

  const watchedCount = episodeStates.filter((state) => state.watched).length;
  return {
    inProgress: episodeStates.some((state) => state.inProgress),
    watched: episodeFiles.length > 0 && watchedCount === episodeFiles.length,
    partiallyWatched: watchedCount > 0,
  };
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
): boolean {
  if (filter === 'all') return true;
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
