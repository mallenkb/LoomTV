import { useEffect, useState } from 'react';
import { desktopApi } from './desktopApi';
import type { IptvGuide, IptvGuideProgramme } from '@/shared/desktopProtocol';

const GUIDE_BEHIND_MS = 60 * 60 * 1000;
const GUIDE_AHEAD_MS = 6 * 60 * 60 * 1000;
const GUIDE_RELOAD_MS = 5 * 60 * 1000;
const CLOCK_TICK_MS = 30 * 1000;

/**
 * Guide listings for the live lineup, from an hour ago to six hours ahead.
 * Reloads every few minutes, and `now` ticks so "min left" stays current.
 */
export function useLiveGuide(references: readonly string[], enabled: boolean): { guide: IptvGuide; now: number } {
  const [guide, setGuide] = useState<IptvGuide>({});
  const [now, setNow] = useState(() => Date.now());
  const key = references.join('\n');

  useEffect(() => {
    if (!enabled || !key) return undefined;
    let cancelled = false;
    const load = () => {
      const at = Date.now();
      void desktopApi.iptvGuide(key.split('\n'), at - GUIDE_BEHIND_MS, at + GUIDE_AHEAD_MS)
        .then((next) => { if (!cancelled) setGuide(next); })
        .catch(() => undefined);
    };
    load();
    const reload = window.setInterval(load, GUIDE_RELOAD_MS);
    return () => { cancelled = true; window.clearInterval(reload); };
  }, [enabled, key]);

  useEffect(() => {
    if (!enabled) return undefined;
    const tick = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(tick);
  }, [enabled]);

  return { guide, now };
}

/** The show on at `at`, and the one after it. */
export function nowAndNext(programmes: readonly IptvGuideProgramme[] | undefined, at: number): { now: IptvGuideProgramme | null; next: IptvGuideProgramme | null } {
  if (!programmes?.length) return { now: null, next: null };
  const index = programmes.findIndex((programme) => programme.startMs <= at && at < programme.endMs);
  if (index >= 0) return { now: programmes[index], next: programmes[index + 1] || null };
  return { now: null, next: programmes.find((programme) => programme.startMs > at) || null };
}

export function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function minutesLeft(programme: IptvGuideProgramme, at: number): number {
  return Math.max(1, Math.round((programme.endMs - at) / 60_000));
}
