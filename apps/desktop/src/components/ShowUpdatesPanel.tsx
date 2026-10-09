import { nextEpisodeStripModel } from '@/lib/nextEpisodeStrip';
import type { LibraryShowUpdates } from '@/shared/desktopProtocol';

/**
 * The next episode, above the season list. The title is optional and the air
 * date may be unknown; the strip still shows what is known.
 */
export default function ShowUpdatesPanel({ show }: { show?: LibraryShowUpdates }) {
  const strip = nextEpisodeStripModel(show?.nextAirs);
  if (!strip) return null;
  const { airDate, daysUntil, countdown, line } = strip;

  return (
    <div className="mb-3 flex items-center gap-3 rounded-xl bg-[color-mix(in_srgb,var(--loom-accent)_6%,var(--loom-surface))] pl-[8.8px] pr-5 py-[8.8px] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--loom-accent)_12%,var(--loom-surface))] motion-reduce:transition-none">
      {airDate ? (
        <time
          dateTime={show?.nextAirs?.airDate}
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
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-dashed border-[var(--loom-muted)] text-[10px] font-medium leading-none text-[var(--loom-muted)]">
          TBA
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] leading-4 text-[var(--loom-muted)]">
          Next episode · {airDate ? airDate.toLocaleDateString([], { weekday: 'long' }) : 'Air date not announced'}
        </p>
        <p className="truncate text-sm font-medium leading-5 text-[var(--loom-text)]">
          {line}
        </p>
      </div>

      {countdown && (
        <div className="shrink-0 text-right">
          <p className="text-[26px] font-medium leading-none tracking-tight text-[var(--loom-text)]">{countdown}</p>
          {daysUntil !== null && daysUntil > 1 && <p className="mt-1 text-[10px] leading-3 text-[var(--loom-muted)]">days to go</p>}
        </div>
      )}
    </div>
  );
}
