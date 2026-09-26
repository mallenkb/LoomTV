import { useEffect, useState } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import type { LibraryEpisodeUpdates } from '@/shared/desktopProtocol';

const EMPTY: LibraryEpisodeUpdates = { shows: [], recentlyAdded: [] };

/**
 * New, upcoming, and missing episodes plus recently added titles for the
 * active profile. Re-read when the page mounts and after files are organized.
 */
export function useEpisodeUpdates(): LibraryEpisodeUpdates {
  const [updates, setUpdates] = useState<LibraryEpisodeUpdates>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void desktopApi.libraryEpisodeUpdates()
        .then((next) => { if (!cancelled) setUpdates(next); })
        .catch(() => undefined);
    };
    load();
    const unsubscribe = desktopApi.onLibraryFilesOrganized(load);
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  return updates;
}

/** "S01E07" for an episode reference. */
export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/** "Airs Sun, Sep 27" for an ISO air date; "Airs today" when it is today. */
export function airsLabel(airDate: string, now = new Date()): string {
  const date = new Date(`${airDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return 'Airs today';
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (date.toDateString() === tomorrow.toDateString()) return 'Airs tomorrow';
  return `Airs ${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
}
