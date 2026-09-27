import type { MediaItem } from '@/contexts/LibraryContext';
import type { LibraryEpisodeRef } from '@/shared/desktopProtocol';
import { getProgressState } from '@/lib/progress';
import { localEpisodeWatchedKey } from '@/lib/watched';

/**
 * The one "new" badge a poster shows, if any. New Season wins over New
 * Episodes, which wins over Newly Added. The main process decides what is
 * new (see libraryInsights); this re-checks watch state kept only in the
 * renderer, such as episodes marked watched by hand.
 */
export type NewBadge =
  | { kind: 'season'; label: string; newest: number }
  | { kind: 'episodes'; label: string; newest: number }
  | { kind: 'added'; label: string; newest: number };

export type NewBadgeSources = {
  watched: boolean;
  watchedKeys: ReadonlySet<string>;
  newEpisodesByShow: ReadonlyMap<string, readonly LibraryEpisodeRef[]>;
  newSeasonByShow: ReadonlyMap<string, number>;
  newlyAdded: ReadonlySet<string>;
};

export function newBadgeFor(item: MediaItem, sources: NewBadgeSources): NewBadge | null {
  if (sources.watched) return null;
  const unwatched = (sources.newEpisodesByShow.get(item.id) || []).filter((episode) => {
    const file = item.episodeFiles?.find((entry) => entry.season === episode.season && entry.episode === episode.episode);
    if (!file || sources.watchedKeys.has(localEpisodeWatchedKey(item.id, episode.season, episode.episode))) return false;
    const state = getProgressState(file.filePath, file.localMetadata?.durationSeconds);
    return state.position <= 0 && !state.watched;
  });
  const newest = Math.max(0, ...unwatched.map((episode) => episode.addedAt || 0));
  const season = sources.newSeasonByShow.get(item.id);
  if (season) return { kind: 'season', label: 'New Season', newest };
  if (unwatched.length) return { kind: 'episodes', label: unwatched.length === 1 ? 'New Episode' : `${unwatched.length} New Episodes`, newest };
  if (sources.newlyAdded.has(item.id)) return { kind: 'added', label: 'Newly Added', newest: item.addedAt || 0 };
  return null;
}
