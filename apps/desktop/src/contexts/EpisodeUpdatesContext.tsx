import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useProfiles } from '@/contexts/ProfileContext';
import { useEpisodeUpdates } from '@/lib/useEpisodeUpdates';
import type { LibraryEpisodeRef, LibraryEpisodeUpdates } from '@/shared/desktopProtocol';

const EMPTY_UPDATES: LibraryEpisodeUpdates = { shows: [], newlyAdded: [] };
const EpisodeUpdatesContext = createContext<{
  updates: LibraryEpisodeUpdates;
  newEpisodesByShow: ReadonlyMap<string, readonly LibraryEpisodeRef[]>;
  newSeasonByShow: ReadonlyMap<string, number>;
  newlyAdded: ReadonlySet<string>;
}>({ updates: EMPTY_UPDATES, newEpisodesByShow: new Map(), newSeasonByShow: new Map(), newlyAdded: new Set() });

/** One lookup shared by the rails and posters on the current library page. */
export function EpisodeUpdatesProvider({ children }: { children: ReactNode }) {
  const { activeProfile } = useProfiles();
  return (
    <EpisodeUpdatesLoader key={activeProfile?.id ?? 'none'} enabled={Boolean(activeProfile)}>
      {children}
    </EpisodeUpdatesLoader>
  );
}

function EpisodeUpdatesLoader({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const updates = useEpisodeUpdates(enabled);
  const value = useMemo(() => ({
    updates,
    newEpisodesByShow: new Map(updates.shows.map((show) => [show.mediaId, show.newEpisodes])),
    newSeasonByShow: new Map(updates.shows.flatMap((show) => (show.newSeason ? [[show.mediaId, show.newSeason] as const] : []))),
    newlyAdded: new Set(updates.newlyAdded || []),
  }), [updates]);
  return <EpisodeUpdatesContext.Provider value={value}>{children}</EpisodeUpdatesContext.Provider>;
}

export function usePosterEpisodeUpdates() {
  return useContext(EpisodeUpdatesContext);
}
