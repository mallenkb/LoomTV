import { ShimmerBlock } from '@/components/ContentShimmer';
import { memo, useEffect, useState } from 'react';
import { cinemetaTitleMetadata } from '@/lib/cinemetaAddonMetadata';
import { queryScope } from '@/lib/queryClient';
import CardPlayContent, { CARD_PLAY_ACTION_CLASS, CARD_PLAY_OVERLAY_CLASS } from './CardPlayContent';
import { useProfiles } from '@/contexts/ProfileContext';
import SafeArtwork from '@/components/SafeArtwork';
import TelevisionPlaceholder from '@/components/TelevisionPlaceholder';
import ContentRatingBadge from '@/components/ContentRatingBadge';
import WatchedToggle from '@/components/WatchedToggle';
import RatingBadge from '@/components/RatingBadge';
import type { StremioPluginCatalogItem } from '@/lib/desktopApi';
import { cacheWatchedDiscoverItem, discoverWatchedKey } from '@/lib/watched';

/* Keep the Discover card pitch aligned with the local-library poster cards so
   VirtualPosterGrid can reuse the same responsive geometry and scroll rhythm. */
const SKIPPED_CARD_SIZE = '[contain-intrinsic-size:200px_384px] [content-visibility:auto]';
const ROOT_CLASS = `loom-poster-link loom-virtual-poster-card group relative flex h-full w-full max-w-[200px] flex-col overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--loom-bg)] ${SKIPPED_CARD_SIZE}`;
const FALLBACK_CLASS = 'flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--loom-surface)] p-3';
const FALLBACK_TEXT_CLASS = 'line-clamp-4 text-center text-xs leading-tight text-[var(--loom-muted)]';
const BACKDROP_CLASS = 'absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/40';
const PLAY_OVERLAY_CLASS = CARD_PLAY_OVERLAY_CLASS;

function artworkSources(item: StremioPluginCatalogItem): string[] {
  return Array.from(new Set([
    item.artwork?.poster,
    item.artwork?.background,
    item.artwork?.logo,
    item.posterUrl,
    item.posterFallbackUrl,
    item.backgroundUrl,
    item.logoUrl,
  ].filter((value): value is string => Boolean(value))));
}

function fallbackArtwork(title: string) {
  return (
    <div className={FALLBACK_CLASS}>
      <TelevisionPlaceholder />
      <p className={FALLBACK_TEXT_CLASS}>{title}</p>
    </div>
  );
}

const StremioPosterCard = memo(function StremioPosterCard({
  item,
  rank,
  metaLine = '',
  showContentRating = true,
  onSelect,
  onPlayTrailer,
  onPlay,
  playbackDisabled = false,
  playbackLabel = 'Play',
  metadataPending = false,
}: {
  item: StremioPluginCatalogItem;
  rank?: number;
  metaLine?: string;
  showContentRating?: boolean;
  onSelect: (item: StremioPluginCatalogItem) => void;
  onPlayTrailer?: () => void;
  onPlay?: (item: StremioPluginCatalogItem) => void;
  playbackDisabled?: boolean;
  playbackLabel?: string;
  metadataPending?: boolean;
}) {
  const { watchedKeys, setWatched } = useProfiles();
  const imdbId = [item.imdbId, item.providerId].find(value => value && /^tt\d{5,12}$/.test(value));
  const ratingType = item.type === 'movie' ? 'movie' : ['tv', 'series', 'anime'].includes(item.type) ? 'series' : null;
  const scope = JSON.stringify(queryScope());
  const ratingKey = `${scope}:${ratingType}:${imdbId}`;
  const [loadedRating, setLoadedRating] = useState<{ key: string; value?: number } | null>(null);
  const hasImdbRating = Boolean(item.providerRatings?.imdb?.value);
  const canLoadRating = Boolean(imdbId && ratingType && !hasImdbRating);
  useEffect(() => {
    if (!imdbId || !ratingType || hasImdbRating) return;
    let current = true;
    void cinemetaTitleMetadata(imdbId, ratingType).then(metadata => {
      if (current) setLoadedRating({ key: ratingKey, value: metadata.rating > 0 && metadata.rating <= 10 ? metadata.rating : undefined });
    }).catch(() => {
      if (current) setLoadedRating({ key: ratingKey });
    });
    return () => { current = false; };
  }, [imdbId, ratingType, hasImdbRating, ratingKey]);
  const fetchedRating = loadedRating?.key === ratingKey ? loadedRating.value : undefined;
  const ratingPending = canLoadRating && loadedRating?.key !== ratingKey;
  const rating = fetchedRating || item.rating;
  const providerRatings = fetchedRating ? { ...item.providerRatings, imdb: { value: fetchedRating, scale: 10 as const } } : item.providerRatings;
  const watchedKey = discoverWatchedKey(item);
  const watched = watchedKeys.has(watchedKey);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect(item);
      }}
      className={ROOT_CLASS}
      aria-label={`${item.title}${item.releaseInfo ? ` (${item.releaseInfo})` : ''}`}
    >
      <div className="loom-poster-frame relative min-h-0 shrink-0 aspect-[2/3] overflow-hidden rounded-lg transition-all duration-200">
        <SafeArtwork
          src={artworkSources(item)}
          alt={item.title}
          className="h-full w-full transition-transform group-hover:scale-105"
          imgClassName="object-cover"
          fallback={fallbackArtwork(item.title)}
        />
        {(ratingPending || metadataPending) && !rating && !providerRatings?.imdb?.value ? (
          <span role="status" aria-label="Loading rating" className="absolute right-2 top-2 z-10 overflow-hidden rounded-full">
            <ShimmerBlock className="h-7 w-16" />
          </span>
        ) : <RatingBadge rating={rating} providerRatings={providerRatings} />}
        {playbackDisabled && playbackLabel !== 'Play' ? (
          <span role="status" className="absolute bottom-2 left-2 z-20 rounded-full bg-black/80 px-2.5 py-1 text-xs font-medium text-white">{playbackLabel}</span>
        ) : null}
        <div className={BACKDROP_CLASS} />
        <div className={PLAY_OVERLAY_CLASS}>
          {onPlay ? (
            <button
              type="button"
              aria-label={`${playbackLabel} ${item.title}`}
              disabled={playbackDisabled}
              onClick={(event) => {
                event.stopPropagation();
                onPlay(item);
              }}
              onKeyDown={(event) => event.stopPropagation()}
              className={CARD_PLAY_ACTION_CLASS}
            >
              <CardPlayContent label={playbackLabel} />
            </button>
          ) : onPlayTrailer ? (
            <button
              type="button"
              aria-label={`Play trailer for ${item.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onPlayTrailer();
              }}
              onKeyDown={(event) => event.stopPropagation()}
              className={CARD_PLAY_ACTION_CLASS}
            >
              <CardPlayContent label="Trailer" />
            </button>
          ) : (
            <span className={CARD_PLAY_ACTION_CLASS}><CardPlayContent /></span>
          )}
        </div>
      </div>
      <div className="mt-2 shrink-0 overflow-hidden">
        <h4 className="truncate text-sm font-semibold text-[var(--loom-text)]">{item.title}</h4>
        {(metaLine || (showContentRating && item.contentRating)) && (
          <div className="loom-poster-meta mt-1.5 flex min-w-0 items-center gap-x-1.5 gap-y-1">
            {metaLine && <p className="min-w-0 truncate text-xs text-[var(--loom-muted)]">{metaLine}</p>}
            {showContentRating && (
              <ContentRatingBadge rating={item.contentRating} className="shrink-0 bg-[var(--loom-surface-3)]" />
            )}
          </div>
        )}
      </div>
      {rank === undefined ? (
        <WatchedToggle
          watched={watched}
          onToggle={() => {
            cacheWatchedDiscoverItem(item);
            void setWatched(watchedKey, !watched);
          }}
          className="loom-poster-watched-toggle absolute left-2 top-2 z-20"
          iconClassName="h-4 w-4"
          size="compact"
        />
      ) : (
        <span
          aria-label={`Rank ${rank}`}
          className="pointer-events-none absolute left-3 top-1 z-20 text-[2.7rem] font-black leading-none text-white [text-shadow:0_1px_2px_rgb(0_0_0_/_0.95),0_0_5px_rgb(0_0_0_/_0.9)]"
        >
          {rank}
        </span>
      )}
    </div>
  );
});

export default StremioPosterCard;
