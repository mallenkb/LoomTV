import { useCallback } from 'react';
import type { MediaItem } from '@/contexts/LibraryContext';
import { useProfiles } from '@/contexts/ProfileContext';
import { usePosterEpisodeUpdates } from '@/contexts/EpisodeUpdatesContext';
import { useProgressSnapshot } from '@/lib/progress';
import { matchesLibraryFilter } from '@/lib/libraryFilters';
import { isLocalItemWatched } from '@/lib/watched';
import { newBadgeFor } from '@/lib/newBadges';

/**
 * Order for library grids and Home rails: titles with a "new" badge first (newest first),
 * finished titles last, and everything else in between in its usual order.
 * Uses the same rules as the poster badges.
 */
export function useLibraryItemOrder(): <T extends MediaItem>(items: readonly T[]) => T[] {
  const { watchedKeys } = useProfiles();
  const progress = useProgressSnapshot();
  const { newEpisodesByShow, newSeasonByShow, newlyAdded } = usePosterEpisodeUpdates();

  return useCallback(<T extends MediaItem>(items: readonly T[]) => {
    const ranked = items.map((item, index) => {
      const watched = matchesLibraryFilter(item, 'watched', progress) || isLocalItemWatched(item, watchedKeys);
      if (watched) return { item, index, rank: 2, newest: 0 };
      const badge = newBadgeFor(item, { watched, watchedKeys, newEpisodesByShow, newSeasonByShow, newlyAdded });
      return { item, index, rank: badge ? 0 : 1, newest: badge?.newest || 0 };
    });
    ranked.sort((left, right) => left.rank - right.rank
      || (left.rank === 0 ? right.newest - left.newest : 0)
      || left.index - right.index);
    return ranked.map((entry) => entry.item);
  }, [newEpisodesByShow, newSeasonByShow, newlyAdded, progress, watchedKeys]);
}
