import { memo, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Play } from 'lucide-react';
import type { MediaItem } from '@/contexts/LibraryContext';
import { useProfiles } from '@/contexts/ProfileContext';
import SafeArtwork from '@/components/SafeArtwork';
import WatchedToggle from '@/components/WatchedToggle';
import RatingBadge from '@/components/RatingBadge';
import ContentRatingBadge, { preferredContentRating } from '@/components/ContentRatingBadge';
import { posterSources, routeArtworkState, uniqueArtworkSources } from '@/lib/artwork';
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
  onPlay?: (item: MediaItem) => void;
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

function fileNameForItem(item: MediaItem): string {
  const filePath = firstPlayableMediaPath(item);
  return filePath.split(/[\\/]/).filter(Boolean).pop() || item.title;
}

export function usePosterArtwork(item: MediaItem, fallbackFilePath: string, preferGenerated = false) {
  const [fallbackThumbnail, setFallbackThumbnail] = useState('');
  const baseImageSources = useMemo(() => posterSources(item), [item]);
  const generatedSources = useMemo(
    () => fallbackThumbnail ? [fallbackThumbnail] : [],
    [fallbackThumbnail],
  );
  const imageSources = useMemo(
    () => preferGenerated
      ? uniqueArtworkSources(generatedSources, baseImageSources)
      : posterSources(item, undefined, generatedSources),
    [baseImageSources, generatedSources, item, preferGenerated],
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
    if (!fallbackFilePath || (!preferGenerated && baseImageSources.length > 0)) return;

    let isMounted = true;
    void desktopApi.getThumbnail(fallbackFilePath, preferGenerated ? '00:00:00' : '00:03:00')
      .then(({ url }) => {
        if (isMounted) setFallbackThumbnail(url);
      })
      .catch(() => {
        if (isMounted) setFallbackThumbnail('');
      });

    return () => {
      isMounted = false;
    };
  }, [baseImageSources.length, fallbackFilePath, preferGenerated]);

  return { imageSources, cardSources, routeArtwork };
}

const MediaPosterCard = memo(function MediaPosterCard({
  item,
  from,
  variant,
  metaLine = '',
  onPlay,
}: MediaPosterCardProps) {
  const { cardSources, routeArtwork } = usePosterArtwork(item, firstPlayableMediaPath(item), variant === 'others');
  const contentRating = preferredContentRating(item.contentRatings, item.contentRating);
  const isImage = variant === 'others' && item.format?.toLowerCase() === 'image';
  const displayTitle = variant === 'others' ? fileNameForItem(item) : item.title;
  const formatLabel = isImage
    ? 'Image'
    : variant === 'others' && item.type === 'movie'
      ? 'Video'
    : mediaFormatLabel(item.format, item.type);
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

  const cardContent = (
    <>
      <div className={variant === 'others'
        ? 'relative flex h-24 min-h-0 shrink-0 items-center justify-center overflow-visible bg-transparent transition-all duration-200'
        : 'loom-poster-frame relative aspect-[2/3] min-h-0 shrink-0 overflow-hidden rounded-lg transition-all duration-200'}>
        <SafeArtwork
          src={cardSources}
        alt={displayTitle}
          className={variant === 'others'
            ? 'flex h-full w-full items-center justify-center bg-transparent'
            : 'h-full w-full transition-transform group-hover:scale-105'}
          naturalSize={variant === 'others'}
          imgClassName={variant === 'others'
            ? 'rounded-lg object-contain shadow-sm'
            : 'object-cover'}
          fallback={variant === 'others' ? (
            <div className="h-full w-full bg-transparent" />
          ) : (
            <div className={FALLBACK_CLASS}>
              <Play className={FALLBACK_ICON_CLASS} />
              <p className={FALLBACK_TEXT_CLASS}>{item.title}</p>
            </div>
          )}
        />
        {variant !== 'others' ? <RatingBadge rating={item.rating} providerRatings={item.providerRatings} /> : null}
        {variant !== 'others' && !isImage ? (
          <>
            <div className={BACKDROP_CLASS} />
            <div className={PLAY_OVERLAY_CLASS}>
              {/* Matches the Discover card's hover mark. It stays a span rather
                  than a button because the whole card is already a link, and a
                  nested button would be invalid inside it. */}
              <span className="loom-poster-play-action grid h-12 w-12 place-items-center rounded-full bg-white text-black shadow-xl transition-transform duration-200 group-hover:scale-110">
                <Play className="ml-0.5 h-5 w-5 fill-current" />
              </span>
            </div>
          </>
        ) : null}
      </div>
      <div className="mt-2 shrink-0 overflow-hidden text-left">
        <h4 className={variant === 'others'
          ? 'line-clamp-2 min-h-[2rem] w-full break-all text-center text-xs font-normal leading-snug text-[var(--loom-text)]'
          : 'line-clamp-2 text-sm font-semibold leading-tight text-[var(--loom-text)]'}>{displayTitle}</h4>
        {variant !== 'others' && (metaLine || contentRating || item.format) && (
          <div className="loom-poster-meta mt-1.5 flex min-w-0 items-center gap-x-1.5 gap-y-1">
            {metaLine && <p className="min-w-0 truncate text-xs text-[var(--loom-muted)]">{metaLine}</p>}
            <ContentRatingBadge rating={formatLabel} className="shrink-0 bg-[var(--loom-surface-3)]" />
            <ContentRatingBadge rating={contentRating} className="shrink-0 bg-[var(--loom-surface-3)]" />
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className={`${ROOT_CLASS[variant]} relative`}>
      {onPlay ? (
        <button type="button" onClick={() => onPlay(item)} className="flex h-full w-full flex-col">
          {cardContent}
        </button>
      ) : (
        <Link to={mediaLink(item)} state={{ from, artwork: routeArtwork }} className="flex h-full w-full flex-col">
          {cardContent}
        </Link>
      )}
      {variant !== 'others' ? (
        <WatchedToggle
          watched={watched}
          onToggle={toggleWatched}
          className="loom-poster-watched-toggle absolute left-2 top-2 z-20"
          iconClassName="h-4 w-4"
          size="compact"
        />
      ) : null}
    </div>
  );
});

export default MediaPosterCard;
