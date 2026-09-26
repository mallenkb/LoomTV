import { CalendarClock } from 'lucide-react';
import { airsLabel, episodeCode } from '@/lib/useEpisodeUpdates';
import type { LibraryShowUpdates } from '@/shared/desktopProtocol';

/**
 * The next episode number and air date, above the season list.
 */
export default function ShowUpdatesPanel({ show }: { show?: LibraryShowUpdates }) {
  const next = show?.nextAirs;
  if (!next?.airDate) return null;

  return (
    <div className="mb-4 space-y-2 rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-3 text-sm">
      <span className="flex items-center gap-1.5 text-[var(--loom-muted)]">
        <CalendarClock className="h-4 w-4" aria-hidden="true" />
        Next: {episodeCode(next.season, next.episode)} · {airsLabel(next.airDate)}
      </span>
    </div>
  );
}
