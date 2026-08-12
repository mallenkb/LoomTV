import { memo, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Play } from 'lucide-react';
import type { MediaItem } from '@/contexts/LibraryContext';
import { useProfiles } from '@/contexts/ProfileContext';
import SafeArtwork from '@/components/SafeArtwork';
import WatchedToggle from '@/components/WatchedToggle';
import RatingBadge from '@/components/RatingBadge';
import ContentRatingBadge, { preferredContentRating } from '@/components/ContentRatingBadge';
import { posterSources, routeArtworkState } from '@/lib/artwork';
import { artworkVariant } from '@/lib/artworkVariants';
import { desktopApi } from '@/lib/desktopApi';
import { firstPlayableMediaPath, mediaLink } from '@/components/MediaPosterCard.helpers';
import { mediaFormatLabel } from '@/shared/mediaFormat';
import { resetProgress, useProgressSnapshot } from '@/lib/progress';
import { matchesLibraryFilter } from '@/lib/libraryFilters';
import { isLocalItemWatched, localProgressPathsForItem, localWatchedKeysForItem } from '@/lib/watched';

type MediaPosterCardVariant = 'home' | 'movies' | 'tv' | 'others';

interface MediaPosterCardProps {
  item: MediaItem;
  from: string;
  variant: MediaPosterCardVariant;
  metaLine?: string;
}

/* Home rail cards are approximately 200x384. VirtualPosterGrid gives library
   cards an explicit height, which their h-full root inherits even when content
   visibility skips their internals. contain-intrinsic-size takes width first. */
const SKIPPED_CARD_SIZE = '[contain-intrinsic-size:200px_384px] [content-visibility:auto]';

const ROOT_CLASS: Record<MediaPosterCardVariant, string> = {
  home: `loom-poster-link group block w-[200px] flex-none ${SKIPPED_CARD_SIZE}`,
  movies: `loom-poster-link loom-virtual-poster-card group flex h-full w-full flex-col overflow-hidden ${SKIPPED_CARD_SIZE}`,
  tv: `loom-poster-link loom-virtual-poster-card group flex h-full w-full flex-col overflow-hidden ${SKIPPED_CARD_SIZE}`,
  others: `loom-poster-link loom-virtual-poster-card group flex h-full w-full flex-col overflow-hidden ${SKIPPED_CARD_SIZE}`,
};

const FALLBACK_CLASS = 'flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--loom-surface)] p-3';
const FALLBACK_ICON_CLASS = 'h-8 w-8 shrink-0 text-[var(--loom-accent)]';
const FALLBACK_TEXT_CLASS = 'line-clamp-4 text-center text-xs leading-tight text-[var(--loom-muted)]';
const BACKDROP_CLASS = 'absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/40';
const PLAY_OVERLAY_CLASS = 'absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100';

export function usePosterArtwork(item: MediaItem, fallbackFilePath: string) {
  const [fallbackThumbnail, setFallbackThumbnail] = useState('');
  const baseImageSources = useMemo(() => posterSources(item), [item]);
  const generatedSources = useMemo(
    () => fallbackThumbnail ? [fallbackThumbnail] : [],
    [fallbackThumbnail],
  );
  const imageSources = useMemo(
    () => posterSources(item, undefined, generatedSources),
    [generatedSources, item],
  );
  // Grid and rail posters paint into roughly a 150px-wide box, which is 300
  // device pixels on a 2x display. w342 is the smallest TMDB rendition that
  // still covers that, and it decodes to well under half the resident memory
  // of w500 (342x513 vs 500x750 of RGBA). routeArtwork deliberately keeps the
  // full-size sources, because the detail view it hands off to paints large.
  const cardSources = useMemo(
    () => imageSources.map((source) => artworkVariant(source, 'w342')),
    [imageSources],
  );
  const routeArtwork = useMemo(
    () => routeArtworkState(item, imageSources),
    [imageSources, item],
  );

  useEffect(() => {
    setFallbackThumbnail('');
    if (!fallbackFilePath || baseImageSources.length > 0) return;

    let isMounted = true;
    void desktopApi.getThumbnail(fallbackFilePath, '00:03:00')
      .then(({ url }) => {
        if (isMounted) setFallbackThumbnail(url);
      })
      .catch(() => {
        if (isMounted) setFallbackThumbnail('');
      });

    return () => {
      isMounted = false;
    };
  }, [baseImageSources.length, fallbackFilePath]);

  return { imageSources, cardSources, routeArtwork };
}

const MediaPosterCard = memo(function MediaPosterCard({
  item,
  from,
  variant,
  metaLine = '',
}: MediaPosterCardProps) {
  const { cardSources, routeArtwork } = usePosterArtwork(item, firstPlayableMediaPath(item));
  const contentRating = preferredContentRating(item.contentRatings, item.contentRating);
  const { watchedKeys, setWatchedEntries } = useProfiles();
  const progress = useProgressSnapshot();
  const watchedByProgress = matchesLibraryFilter(item, 'watched', progress);
  const watched = watchedByProgress || isLocalItemWatched(item, watchedKeys);
  const watchedKeysForItem = localWatchedKeysForItem(item);
  const progressPaths = localProgressPathsForItem(item);

  const toggleWatched = () => {
    const present = !watched;
    if (!present && watchedByProgress) void resetProgress(progressPaths);
    void setWatchedEntries(watchedKeysForItem, present);
  };

  return (
    <div className={`${ROOT_CLASS[variant]} relative`}>
      <Link
        to={mediaLink(item)}
        state={{ from, artwork: routeArtwork }}
        className="flex h-full w-full flex-col"
      >
        <div className="loom-poster-frame relative aspect-[2/3] min-h-0 shrink-0 overflow-hidden rounded-lg transition-all duration-200">
          <SafeArtwork
            src={cardSources}
            alt={item.title}
            className="h-full w-full transition-transform group-hover:scale-105"
            imgClassName="object-cover"
            fallback={(
              <div className={FALLBACK_CLASS}>
                <Play className={FALLBACK_ICON_CLASS} />
                <p className={FALLBACK_TEXT_CLASS}>{item.title}</p>
              </div>
            )}
          />
          <RatingBadge rating={item.rating} providerRatings={item.providerRatings} />
          <div className={BACKDROP_CLASS} />
          <div className={PLAY_OVERLAY_CLASS}>
            <Play className="h-8 w-8 fill-current text-[var(--loom-accent)] drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] transition-transform duration-200 group-hover:scale-110" />
          </div>
        </div>
        <div className="mt-2 shrink-0 overflow-hidden">
          <h4 className="line-clamp-2 text-sm font-semibold leading-tight text-[var(--loom-text)]">{item.title}</h4>
          {(metaLine || contentRating || item.format) && (
            <div className="mt-1.5 flex min-w-0 items-center gap-x-1.5 gap-y-1">
              {metaLine && <p className="min-w-0 truncate text-xs text-[var(--loom-muted)]">{metaLine}</p>}
              <ContentRatingBadge
                rating={mediaFormatLabel(item.format, item.type)}
                className="shrink-0 border-[var(--loom-accent)]/70 bg-[var(--loom-surface-3)] text-[var(--loom-accent)]"
              />
              <ContentRatingBadge rating={contentRating} className="shrink-0 bg-[var(--loom-surface-3)]" />
            </div>
          )}
        </div>
      </Link>
      <WatchedToggle
        watched={watched}
        onToggle={toggleWatched}
        className="absolute left-2 top-2 z-20"
        iconClassName="h-4 w-4"
        size="compact"
      />
    </div>
  );
});

export default MediaPosterCard;
