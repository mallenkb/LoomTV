import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { IptvGuide, IptvGuideProgramme } from '@/shared/desktopProtocol';
import type { LineupChannel } from '@/lib/liveChannelLineup';
import { clockTime, minutesLeft } from '@/lib/useLiveGuide';
import { ChannelLogo } from './PlayerChannelPanel';

const PX_PER_MINUTE = 4;
const WINDOW_HOURS = 4;
const CHANNEL_COLUMN = 200;
const HALF_HOUR_MS = 30 * 60 * 1000;

type Selection = { channel: LineupChannel; programme: IptvGuideProgramme };

/**
 * The live guide: the lineup down the side and the next few hours across,
 * over the lower part of the player so the picture stays in view above it.
 */
export default function PlayerGuide({
  channels, guide, now, current, onWatch, onClose,
}: {
  channels: readonly LineupChannel[];
  guide: IptvGuide;
  now: number;
  current: string;
  onWatch: (channel: LineupChannel) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Selection | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const currentRowRef = useRef<HTMLDivElement | null>(null);

  const from = Math.floor(now / HALF_HOUR_MS) * HALF_HOUR_MS;
  const to = from + WINDOW_HOURS * 60 * 60 * 1000;
  const width = ((to - from) / 60_000) * PX_PER_MINUTE;
  const x = (ms: number) => ((Math.min(Math.max(ms, from), to) - from) / 60_000) * PX_PER_MINUTE;

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return channels
      .map((channel, index) => ({ channel, number: index + 1 }))
      .filter(({ channel }) => !needle
        || channel.name.toLowerCase().includes(needle)
        || (guide[channel.reference] || []).some((programme) => programme.endMs > from && programme.startMs < to && programme.title.toLowerCase().includes(needle)));
  }, [channels, from, guide, query, to]);

  // Open on the channel that is playing.
  useEffect(() => {
    const row = currentRowRef.current, box = scrollRef.current;
    if (row && box) box.scrollTop = Math.max(0, row.offsetTop - 60);
  }, []);

  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || panelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-player-guide-toggle="true"]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', closeFromOutside, true);
    return () => document.removeEventListener('pointerdown', closeFromOutside, true);
  }, [onClose]);

  const times: number[] = [];
  for (let t = from; t < to; t += HALF_HOUR_MS) times.push(t);
  const needle = query.trim().toLowerCase();
  const detail = selected || (() => {
    const channel = channels.find((entry) => entry.reference === current);
    const programme = channel && (guide[current] || []).find((entry) => entry.startMs <= now && now < entry.endMs);
    return channel && programme ? { channel, programme } : null;
  })();
  const hasListings = rows.some(({ channel }) => (
    (guide[channel.reference] || []).some((programme) => programme.endMs > from && programme.startMs < to)
  ));

  return (
    <section
      ref={panelRef}
      aria-label="Guide"
      className="loom-no-drag absolute inset-x-0 bottom-0 z-50 flex h-[62%] flex-col border-t border-white/10 bg-neutral-950/[0.97] shadow-2xl backdrop-blur-md"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-start gap-4 border-b border-white/[0.07] px-5 py-3">
        <div className="min-w-0 flex-1">
          {detail ? (
            <>
              <p className="truncate text-xs text-white/55">{detail.channel.name}</p>
              <p className="truncate text-base font-semibold text-white">{detail.programme.title}</p>
              <p className="truncate text-xs tabular-nums text-white/60">
                {clockTime(detail.programme.startMs)} – {clockTime(detail.programme.endMs)}
                {' · '}
                {detail.programme.startMs <= now && now < detail.programme.endMs
                  ? `On now, ${minutesLeft(detail.programme, now)} min left`
                  : detail.programme.startMs > now ? `Starts in ${Math.round((detail.programme.startMs - now) / 60_000)} min` : 'Ended'}
                {detail.programme.description ? ` · ${detail.programme.description}` : ''}
              </p>
            </>
          ) : (
            <p className="py-2 text-base font-semibold text-white">Guide</p>
          )}
        </div>
        {detail && detail.channel.reference !== current ? (
          <button
            type="button"
            onClick={() => onWatch(detail.channel)}
            className="shrink-0 self-center rounded-lg bg-white px-4 py-2 text-sm font-bold text-black outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
          >
            Watch {detail.channel.name}
          </button>
        ) : null}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation(); }}
          placeholder="Find a channel or show"
          aria-label="Find a channel or show"
          className="hidden h-9 w-56 shrink-0 self-center rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white outline-none placeholder:text-white/40 focus:border-[var(--loom-accent)] md:block"
        />
        <button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center self-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white" aria-label="Close guide" title="Close guide (G)">
          <X className="h-4 w-4" />
        </button>
      </div>

      {!hasListings && !needle ? (
        <p className="border-b border-white/[0.07] px-5 py-2 text-xs text-white/55">
          No programme data is available for this time. Check this source's XMLTV guide in Settings.
        </p>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: CHANNEL_COLUMN + width }}>
          <div className="sticky top-0 z-20 flex h-7 border-b border-white/10 bg-neutral-950">
            <div className="sticky left-0 z-10 shrink-0 bg-neutral-950" style={{ width: CHANNEL_COLUMN }} />
            <div className="relative" style={{ width }}>
              {times.map((t) => (
                <span key={t} className="absolute top-1.5 pl-2 text-[11px] tabular-nums text-white/55" style={{ left: x(t) }}>{clockTime(t)}</span>
              ))}
            </div>
          </div>

          {rows.map(({ channel, number }) => {
            const isCurrent = channel.reference === current;
            const programmes = (guide[channel.reference] || []).filter((programme) => programme.endMs > from && programme.startMs < to);
            return (
              <div key={channel.reference} ref={isCurrent ? currentRowRef : undefined} className="flex h-14 border-b border-white/[0.05]">
                <button
                  type="button"
                  onClick={() => onWatch(channel)}
                  title={isCurrent ? 'Watching' : `Watch ${channel.name}`}
                  className={`sticky left-0 z-10 flex shrink-0 items-center gap-2.5 border-r border-white/10 px-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${isCurrent ? 'bg-neutral-800' : 'bg-neutral-900 hover:bg-neutral-800'}`}
                  style={{ width: CHANNEL_COLUMN }}
                >
                  <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-white/45">{number}</span>
                  <ChannelLogo url={channel.logoUrl} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13px] ${isCurrent ? 'font-semibold text-white' : 'text-white/85'}`}>{channel.name}</span>
                    {isCurrent ? <span className="flex items-center gap-1 text-[10.5px] text-red-300"><span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />Watching</span> : null}
                  </span>
                </button>
                <div className="relative" style={{ width }}>
                  {programmes.length ? programmes.map((programme) => {
                    const onAir = programme.startMs <= now && now < programme.endMs;
                    const isSelected = selected?.channel.reference === channel.reference && selected.programme.startMs === programme.startMs;
                    const matches = Boolean(needle) && programme.title.toLowerCase().includes(needle);
                    return (
                      <button
                        key={programme.startMs}
                        type="button"
                        onClick={() => setSelected({ channel, programme })}
                        onDoubleClick={() => onWatch(channel)}
                        className={`absolute inset-y-1 overflow-hidden rounded-md px-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${isSelected ? 'ring-2 ring-inset ring-[var(--loom-accent)]' : ''} ${matches ? 'bg-[var(--loom-accent)]/25' : onAir ? 'bg-white/[0.12] hover:bg-white/20' : 'bg-white/[0.05] hover:bg-white/[0.12]'}`}
                        style={{ left: x(programme.startMs) + 2, width: Math.max(20, x(programme.endMs) - x(programme.startMs) - 4) }}
                      >
                        <span className="block truncate text-xs font-medium text-white">{programme.title}</span>
                        <span className="block truncate text-[10.5px] tabular-nums text-white/50">{clockTime(programme.startMs)} – {clockTime(programme.endMs)}</span>
                      </button>
                    );
                  }) : (
                    <div className="absolute inset-y-1 left-0.5 right-0.5 flex items-center rounded-md bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.03)_0_8px,transparent_8px_16px)] px-3 text-xs text-white/35">
                      No guide info
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {rows.length === 0 ? <p className="px-5 py-6 text-sm text-white/50">Nothing matches "{query}".</p> : null}

          <div className="pointer-events-none absolute bottom-0 top-0 z-[5] w-0.5 bg-red-500" style={{ left: CHANNEL_COLUMN + x(now) }} aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
