import { episodeCode } from '@/lib/useEpisodeUpdates';
import type { LibraryShowUpdates } from '@/shared/desktopProtocol';

/**
 * The next episode number and air date, above the season list.
 */
export default function ShowUpdatesPanel({ show }: { show?: LibraryShowUpdates }) {
  const next = show?.nextAirs;
  if (!next?.airDate) return null;

  const airDate = new Date(`${next.airDate}T12:00:00`);
  if (Number.isNaN(airDate.getTime())) return null;

  const today = new Date();
  // Compare calendar days so daylight-saving changes do not shift the countdown.
  const daysUntil = Math.round((
    Date.UTC(airDate.getFullYear(), airDate.getMonth(), airDate.getDate())
    - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  ) / 86_400_000);
  const countdown = daysUntil === 0 ? 'Today'
    : daysUntil === 1 ? 'Tomorrow'
      : daysUntil > 1 ? String(daysUntil) : null;

  return (
    <div className="mb-3 flex items-center gap-3 rounded-xl bg-[color-mix(in_srgb,var(--loom-accent)_6%,var(--loom-surface))] pl-[8.8px] pr-3 py-[8.8px]">
      <time
        dateTime={next.airDate}
        aria-label={airDate.toLocaleDateString([], { dateStyle: 'full' })}
        className="flex h-10 w-10 shrink-0 flex-col overflow-hidden rounded-md bg-[color-mix(in_srgb,var(--loom-text)_6%,transparent)] text-center"
      >
        <span className="bg-[var(--loom-accent)] text-[11px] font-bold uppercase leading-4 tracking-wide text-[var(--loom-accent-foreground)]">
          {airDate.toLocaleDateString([], { month: 'short' })}
        </span>
        <span className="text-lg font-medium leading-6 text-[var(--loom-text)]">
          {airDate.toLocaleDateString([], { day: '2-digit' })}
        </span>
      </time>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] leading-4 text-[var(--loom-muted)]">
          Next episode · {airDate.toLocaleDateString([], { weekday: 'long' })}
        </p>
        <p className="truncate text-sm font-medium leading-5 text-[var(--loom-text)]">
          {episodeCode(next.season, next.episode)}
        </p>
      </div>

      {countdown && (
        <div className="shrink-0 text-right">
          <p className={`${daysUntil > 1 ? 'text-[32px] leading-8 tracking-tight' : 'text-lg leading-6'} font-medium text-[var(--loom-text)]`}>
            {countdown}
          </p>
          {daysUntil > 1 && <p className="text-[10px] leading-3 text-[var(--loom-muted)]">days to go</p>}
        </div>
      )}
    </div>
  );
}
