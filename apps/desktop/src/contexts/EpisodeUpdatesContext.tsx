import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useProfiles } from '@/contexts/ProfileContext';
import { useEpisodeUpdates } from '@/lib/useEpisodeUpdates';
import type { LibraryEpisodeRef, LibraryEpisodeUpdates } from '@/shared/desktopProtocol';

const EMPTY_UPDATES: LibraryEpisodeUpdates = { shows: [] };
const EpisodeUpdatesContext = createContext<{
  updates: LibraryEpisodeUpdates;
  newEpisodesByShow: ReadonlyMap<string, readonly LibraryEpisodeRef[]>;
}>({ updates: EMPTY_UPDATES, newEpisodesByShow: new Map() });

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
  }), [updates]);
  return <EpisodeUpdatesContext.Provider value={value}>{children}</EpisodeUpdatesContext.Provider>;
}

export function usePosterEpisodeUpdates() {
  return useContext(EpisodeUpdatesContext);
}
