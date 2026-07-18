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

const ROOT_CLASS: Record<MediaPosterCardVariant, string> = {
  home: 'loom-poster-link group block w-[200px] flex-none [contain-intrinsic-size:300px_200px] [content-visibility:auto]',
  movies: 'loom-poster-link group block w-full max-w-[200px] [contain-intrinsic-size:300px_200px] [content-visibility:auto]',
  tv: 'loom-poster-link group block w-full max-w-[200px] [contain-intrinsic-size:300px_200px] [content-visibility:auto]',
  others: 'loom-poster-link group block w-full max-w-[200px] [contain-intrinsic-size:300px_200px] [content-visibility:auto]',
};

const FALLBACK_CLASS: Record<MediaPosterCardVariant, string> = {
  home: 'w-full h-full bg-[var(--loom-surface)] flex flex-col items-center justify-center gap-2 p-3',
  movies: 'w-full h-full bg-[var(--loom-surface)] flex flex-col items-center justify-center gap-2 p-3',
  tv: 'w-full h-full bg-[var(--loom-surface)] flex flex-col items-center justify-center gap-2 p-3',
  others: 'flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--loom-surface)] p-3',
};

const FALLBACK_ICON_CLASS: Record<MediaPosterCardVariant, string> = {
  home: 'w-8 h-8 text-[var(--loom-accent)] shrink-0',
  movies: 'w-8 h-8 text-[var(--loom-accent)] shrink-0',
  tv: 'w-8 h-8 text-[var(--loom-accent)] shrink-0',
  others: 'h-8 w-8 shrink-0 text-[var(--loom-accent)]',
};

const FALLBACK_TEXT_CLASS: Record<MediaPosterCardVariant, string> = {
  home: 'text-[var(--loom-muted)] text-xs text-center leading-tight line-clamp-4',
  movies: 'text-[var(--loom-muted)] text-xs text-center leading-tight line-clamp-4',
  tv: 'text-[var(--loom-muted)] text-xs text-center leading-tight line-clamp-4',
  others: 'line-clamp-4 text-center text-xs leading-tight text-[var(--loom-muted)]',
};

const BACKDROP_CLASS: Record<MediaPosterCardVariant, string> = {
  home: 'absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/40',
  movies: 'absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors',
  tv: 'absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors',
  others: 'absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/40',
};

const PLAY_OVERLAY_CLASS: Record<MediaPosterCardVariant, string> = {
  home: 'absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity',
  movies: 'absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity',
  tv: 'absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity',
  others: 'absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100',
};

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
            <div className={FALLBACK_CLASS[variant]}>
              <Play className={FALLBACK_ICON_CLASS[variant]} />
              <p className={FALLBACK_TEXT_CLASS[variant]}>{item.title}</p>
            </div>
          )}
        />
        <RatingBadge rating={item.rating} />
        <div className={BACKDROP_CLASS[variant]} />
        <div className={PLAY_OVERLAY_CLASS[variant]}>
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
