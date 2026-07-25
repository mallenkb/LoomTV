import { memo, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Star } from 'lucide-react';
import type { MediaItem } from '@/contexts/LibraryContext';
import SafeArtwork from '@/components/SafeArtwork';
import { posterSources, routeArtworkState } from '@/lib/artwork';
import { desktopApi } from '@/lib/desktopApi';
import { firstPlayableMediaPath, mediaLink } from '@/components/MediaPosterCard.helpers';

type MediaPosterCardVariant = 'home' | 'movies' | 'tv' | 'others';

interface MediaPosterCardProps {
  item: MediaItem;
  from: string;
  variant: MediaPosterCardVariant;
  metaLine?: string;
}

/* Poster frame is 200x300 and the title block below it adds ~40px, matching the
   340px row height VirtualPosterGrid reserves. contain-intrinsic-size takes
   width then height, so these must stay in that order or skipped cards
   under-reserve space and the scroll position drifts as they render. */
const SKIPPED_CARD_SIZE = '[contain-intrinsic-size:200px_340px] [content-visibility:auto]';

const ROOT_CLASS: Record<MediaPosterCardVariant, string> = {
  home: `loom-poster-link group block w-[200px] flex-none ${SKIPPED_CARD_SIZE}`,
  movies: `loom-poster-link group block w-full max-w-[200px] ${SKIPPED_CARD_SIZE}`,
  tv: `loom-poster-link group block w-full max-w-[200px] ${SKIPPED_CARD_SIZE}`,
  others: `loom-poster-link group block w-full max-w-[200px] ${SKIPPED_CARD_SIZE}`,
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

  return { imageSources, routeArtwork };
}

function RatingBadge({ rating }: { rating?: number }) {
  if (!rating || rating <= 0) return null;
  return (
    <div className="loom-chip absolute right-2 top-2 z-10 inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold backdrop-blur-md">
      <Star className="h-3 w-3" fill="currentColor" />
      {rating.toFixed(1)}
    </div>
  );
}

const MediaPosterCard = memo(function MediaPosterCard({
  item,
  from,
  variant,
  metaLine = '',
}: MediaPosterCardProps) {
  const { imageSources, routeArtwork } = usePosterArtwork(item, firstPlayableMediaPath(item));

  return (
    <Link
      to={mediaLink(item)}
      state={{ from, artwork: routeArtwork }}
      className={ROOT_CLASS[variant]}
    >
      <div className="loom-poster-frame relative aspect-[2/3] overflow-hidden rounded-lg transition-all duration-200">
        <SafeArtwork
          src={imageSources}
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
        <RatingBadge rating={item.rating} />
        <div className={BACKDROP_CLASS} />
        <div className={PLAY_OVERLAY_CLASS}>
          <Play className="h-8 w-8 fill-current text-[var(--loom-accent)] drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] transition-transform duration-200 group-hover:scale-110" />
        </div>
      </div>
      <div className="mt-2">
        <h4 className="truncate text-sm font-semibold text-[var(--loom-text)]">{item.title}</h4>
        {metaLine && <p className="text-xs text-[var(--loom-muted)]">{metaLine}</p>}
      </div>
    </Link>
  );
});

export default MediaPosterCard;
