import { episodeCode } from './episodeCode.ts';
import type { LibraryEpisodeRef } from '../shared/desktopProtocol.ts';

// Titles such as "Episode 3" only repeat the code, and "TBA" or "Untitled"
// stand in for a title that is not known yet. None of these are shown.
const PLACEHOLDER_TITLE = /^(episode\s*\d+|tba|tbd|tbc|untitled|unknown|n\/a|none|-+)$/i;
const MS_PER_DAY = 86_400_000;

export type NextEpisodeStrip = {
  code: string;
  /** The title when it adds information, otherwise empty. */
  title: string;
  /** Code, then the title if there is one. Never blank. */
  line: string;
  airDate: Date | null;
  /** Calendar days from today; null when the air date is unknown. */
  daysUntil: number | null;
  /** "Today", "Tomorrow", or the day count when more than one day away; otherwise null. */
  countdown: string | null;
};

function parseAirDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function calendarDaysBetween(from: Date, to: Date): number {
  return Math.round((
    Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
    - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  ) / MS_PER_DAY);
}

/** Null only when there is no upcoming episode at all. Missing fields fall back instead of hiding the strip. */
export function nextEpisodeStripModel(next: LibraryEpisodeRef | null | undefined, now = new Date()): NextEpisodeStrip | null {
  if (!next) return null;
  const code = episodeCode(next.season, next.episode);
  const rawTitle = next.title?.trim() ?? '';
  const title = rawTitle && !PLACEHOLDER_TITLE.test(rawTitle) ? rawTitle : '';
  const airDate = parseAirDate(next.airDate);
  const daysUntil = airDate ? calendarDaysBetween(now, airDate) : null;
  const countdown = daysUntil === null ? null
    : daysUntil === 0 ? 'Today'
      : daysUntil === 1 ? 'Tomorrow'
        : daysUntil > 1 ? String(daysUntil) : null;
  return { code, title, line: title ? `${code} · ${title}` : code, airDate, daysUntil, countdown };
}
