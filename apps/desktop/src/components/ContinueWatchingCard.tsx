import { Link } from 'react-router';
import { Play } from 'lucide-react';
import type { MediaItem } from '@/contexts/LibraryContext';
import SafeArtwork from '@/components/SafeArtwork';
import RatingBadge from '@/components/RatingBadge';
import { backdropSources, posterSources, routeArtworkState } from '@/lib/artwork';
import { mediaLink } from '@/components/MediaPosterCard.helpers';
import type { StoredProgress } from '@/lib/desktopApi';

/**
 * The landscape resume card: backdrop, title, and a progress bar reading the
 * most recently played file. Shared by both home styles so a title in progress
 * looks the same wherever it appears.
 *
 * Its colours come from the --loom-media-* tokens, which are declared on :root
 * rather than per style. The card lays its own dark scrim over the artwork, so
 * the white title and the track read the same in light and dark themes.
 */
export function latestProgressPercent(item: MediaItem, progress: Record<string, StoredProgress>): number {
  const candidates = [
    {
      filePath: item.filePath,
      durationHint: item.localMetadata?.durationSeconds || 0,
    },
    ...(item.episodeFiles || []).map((episode) => ({
      filePath: episode.filePath,
      durationHint: episode.localMetadata?.durationSeconds || 0,
    })),
  ].filter((candidate) => Boolean(candidate.filePath));
  const latest = candidates
    .map((candidate) => ({ ...candidate, stored: progress[candidate.filePath] }))
    .filter((candidate): candidate is typeof candidate & { stored: StoredProgress } => Boolean(candidate.stored))
    .sort((left, right) => (right.stored.updatedAt || 0) - (left.stored.updatedAt || 0))[0];

  if (!latest) return 0;
  const duration = latest.stored.duration > 0 ? latest.stored.duration : latest.durationHint;
  if (duration <= 0) return 0;
  return Math.min(100, Math.max(0, (latest.stored.position / duration) * 100));
}

export default function ContinueWatchingCard({
  item,
  from,
  progress,
}: {
  item: MediaItem;
  from: string;
  progress: Record<string, StoredProgress>;
}) {
  const progressPercent = latestProgressPercent(item, progress);

  return (
    <Link
      to={mediaLink(item)}
      state={{ from, artwork: routeArtworkState(item, posterSources(item)) }}
      className="loom-continue-watching-card group block w-[280px] flex-none"
    >
      <div className="relative aspect-video overflow-hidden rounded-2xl bg-[var(--loom-media-veil)] shadow-lg">
        <SafeArtwork
          src={backdropSources(item)}
          alt={item.title}
          className="h-full w-full"
          imgClassName="object-cover transition-transform duration-500 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[var(--loom-media-scrim-strong)] via-transparent to-transparent" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-white text-black shadow-xl">
            <Play className="ml-0.5 h-5 w-5 fill-current" />
          </span>
        </div>
        <RatingBadge rating={item.rating} providerRatings={item.providerRatings} />
        <p className="absolute bottom-4 left-3 right-3 truncate text-sm font-semibold text-[var(--loom-on-media)]">{item.title}</p>
        <div className="absolute inset-x-0 bottom-0 h-1 bg-[var(--loom-media-track)]">
          <div className="h-full bg-[var(--loom-accent)]" style={{ width: `${progressPercent}%` }} />
        </div>
      </div>
    </Link>
  );
}
