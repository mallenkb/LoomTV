import { useState } from 'react';
import { CalendarClock, CircleAlert, Sparkles } from 'lucide-react';
import { airsLabel, episodeCode, useEpisodeUpdates } from '@/lib/useEpisodeUpdates';

const PLACEHOLDER_TITLE = /^(?:tba|tbd|to be announced|untitled)$/i;

/**
 * New episodes, what airs next, and missing episodes for one show, above its
 * season list. Renders nothing when there is nothing to say.
 */
export default function ShowUpdatesPanel({ mediaId }: { mediaId: string }) {
  const { shows } = useEpisodeUpdates();
  const [showMissing, setShowMissing] = useState(false);
  const show = shows.find((entry) => entry.mediaId === mediaId);
  if (!show) return null;
  const next = show.nextAirs;
  const nextTitle = next && next.title && !PLACEHOLDER_TITLE.test(next.title) ? ` "${next.title}"` : '';

  return (
    <div className="mb-4 space-y-2 rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-3 text-sm">
      {show.newEpisodes.length > 0 || next ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          {show.newEpisodes.length > 0 ? (
            <span className="flex items-center gap-1.5 text-[var(--loom-text)]">
              <Sparkles className="h-4 w-4 text-[var(--loom-accent)]" aria-hidden="true" />
              {show.newEpisodes.length} new {show.newEpisodes.length === 1 ? 'episode' : 'episodes'}:{' '}
              {show.newEpisodes.slice(0, 4).map((episode) => episodeCode(episode.season, episode.episode)).join(', ')}
              {show.newEpisodes.length > 4 ? '…' : ''}
            </span>
          ) : null}
          {next?.airDate ? (
            <span className="flex items-center gap-1.5 text-[var(--loom-muted)]">
              <CalendarClock className="h-4 w-4" aria-hidden="true" />
              Next: {episodeCode(next.season, next.episode)}{nextTitle} · {airsLabel(next.airDate)}
            </span>
          ) : null}
        </div>
      ) : null}
      {show.missing.length > 0 ? (
        <div>
          <button type="button" onClick={() => setShowMissing((value) => !value)} aria-expanded={showMissing} className="flex items-center gap-1.5 text-amber-300 hover:underline">
            <CircleAlert className="h-4 w-4" aria-hidden="true" />
            {show.missing.length} aired {show.missing.length === 1 ? 'episode is' : 'episodes are'} missing from your library
          </button>
          {showMissing ? (
            <ul className="mt-2 space-y-1 pl-6 text-xs text-[var(--loom-muted)]">
              {show.missing.map((episode) => (
                <li key={`${episode.season}:${episode.episode}`}>
                  {episodeCode(episode.season, episode.episode)}{episode.title ? ` - ${episode.title}` : ''}{episode.airDate ? ` · aired ${episode.airDate}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
