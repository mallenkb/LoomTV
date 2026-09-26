import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import TelevisionPlaceholder from '../TelevisionPlaceholder';
import type { LineupChannel } from '@/lib/liveChannelLineup';
import type { IptvGuide, IptvGuideProgramme } from '@/shared/desktopProtocol';
import { clockTime, nowAndNext } from '@/lib/useLiveGuide';

export function ChannelLogo({ url, size = 'md' }: { url?: string; size?: 'sm' | 'md' }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`grid ${size === 'sm' ? 'h-8 w-8' : 'h-10 w-10'} shrink-0 place-items-center overflow-hidden rounded-md bg-white/5`}>
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-full w-full object-contain p-1" />
      ) : (
        <TelevisionPlaceholder className={`${size === 'sm' ? 'h-5 w-5' : 'h-6 w-6'} opacity-70`} />
      )}
    </span>
  );
}

/** The live channel list beside the player, like the episode list for a series. */
export default function PlayerChannelPanel({
  channels, current, guide, now, onSelect, onClose,
}: {
  channels: readonly LineupChannel[];
  current: string;
  guide: IptvGuide;
  now: number;
  onSelect: (channel: LineupChannel) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return channels.flatMap((channel, index) => {
      let matchedProgramme: IptvGuideProgramme | null = null;
      if (needle) {
        matchedProgramme = (guide[channel.reference] || []).find((programme) => (
          programme.title.toLowerCase().includes(needle)
        )) || null;
        if (!channel.name.toLowerCase().includes(needle) && !matchedProgramme) return [];
      }
      return [{ channel, number: index + 1, matchedProgramme }];
    });
  }, [channels, guide, query]);

  // Open on the channel that is playing.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <aside
      aria-label="Channels"
      className="loom-no-drag player-side-panel absolute inset-y-0 right-0 z-50 flex w-[360px] max-w-[40vw] flex-col bg-neutral-950 shadow-2xl"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold tracking-tight text-white">Channels</p>
          <p className="mt-0.5 text-[11px] text-[var(--loom-muted)]">{channels.length.toLocaleString()} channels</p>
        </div>
        <button type="button" onClick={onClose} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--loom-muted)] transition-colors hover:bg-white/10 hover:text-white" aria-label="Close channel list">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="border-b border-white/[0.07] px-4 pb-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a channel or programme"
          aria-label="Find a channel or programme"
          className="h-9 w-full rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white outline-none placeholder:text-white/40 focus:border-[var(--loom-accent)]"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-0.5 p-2">
          {visible.map(({ channel, number, matchedProgramme }) => {
            const isCurrent = channel.reference === current;
            const { now: onNow } = nowAndNext(guide[channel.reference], now);
            return (
              <li key={channel.reference}>
                <button
                  ref={isCurrent ? currentRef : undefined}
                  type="button"
                  onClick={() => onSelect(channel)}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${isCurrent ? 'bg-white/10' : 'hover:bg-white/5'}`}
                >
                  <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-white/45">{number}</span>
                  <ChannelLogo url={channel.logoUrl} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${isCurrent ? 'font-semibold text-white' : 'text-white/85'}`}>{channel.name}</span>
                    {matchedProgramme ? (
                      <span className="block truncate text-[11px] tabular-nums text-white/60">
                        {matchedProgramme.title} · {clockTime(matchedProgramme.startMs)}
                      </span>
                    ) : isCurrent ? (
                      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-red-300"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" /><span className="truncate">Watching{onNow ? ` · ${onNow.title}` : ''}</span></span>
                    ) : onNow ? (
                      <span className="block truncate text-[11px] tabular-nums text-white/50">{onNow.title} · until {clockTime(onNow.endMs)}</span>
                    ) : null}
                    {onNow ? (
                      <span className="mt-1 block h-0.5 overflow-hidden rounded-full bg-white/15" aria-hidden="true">
                        <span className="block h-full bg-white/70" style={{ width: `${Math.min(100, Math.max(0, ((now - onNow.startMs) / (onNow.endMs - onNow.startMs)) * 100))}%` }} />
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
          {visible.length === 0 ? <li className="px-3 py-6 text-center text-sm text-white/50">No channels or programmes match.</li> : null}
        </ul>
      </ScrollArea>
    </aside>
  );
}
