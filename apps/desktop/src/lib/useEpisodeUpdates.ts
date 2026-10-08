import { useEffect, useState } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import type { LibraryEpisodeUpdates } from '@/shared/desktopProtocol';
import { msUntilNextLocalMidnight } from '@/lib/localMidnight';

const EMPTY: LibraryEpisodeUpdates = { shows: [], newlyAdded: [] };

// Progress saves fire every few seconds during playback; one reload after
// they settle is enough to clear "new" badges and pick the next episode.
const RELOAD_DEBOUNCE_MS = 2_000;

/**
 * New, upcoming, and missing episodes for the active profile. Re-read when
 * the page mounts, after files are organized or library folders change,
 * after watch progress changes, at local midnight, and when the window
 * becomes visible again, so "next" and "Airs today" never go stale.
 */
export function useEpisodeUpdates(enabled = true): LibraryEpisodeUpdates {
  const [updates, setUpdates] = useState<LibraryEpisodeUpdates>(EMPTY);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let midnight: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void desktopApi.libraryEpisodeUpdates()
        .then((next) => { if (!cancelled) setUpdates(next); })
        .catch(() => undefined);
    };
    const loadSoon = () => {
      clearTimeout(debounce);
      debounce = setTimeout(load, RELOAD_DEBOUNCE_MS);
    };
    const scheduleMidnight = () => {
      midnight = setTimeout(() => { load(); scheduleMidnight(); }, msUntilNextLocalMidnight());
    };
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    load();
    scheduleMidnight();
    const unsubscribeOrganized = desktopApi.onLibraryFilesOrganized(load);
    // Schedules come from the cache at once and refresh in the background.
    const unsubscribeSchedules = desktopApi.onLibraryEpisodeUpdatesChanged(load);
    window.addEventListener('loomtv-progress', loadSoon);
    window.addEventListener('loomtv:library-roots-changed', loadSoon);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      clearTimeout(midnight);
      unsubscribeOrganized();
      unsubscribeSchedules();
      window.removeEventListener('loomtv-progress', loadSoon);
      window.removeEventListener('loomtv:library-roots-changed', loadSoon);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
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
