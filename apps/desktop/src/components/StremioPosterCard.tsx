import { memo } from 'react';
import { Play } from 'lucide-react';
import { useProfiles } from '@/contexts/ProfileContext';
import SafeArtwork from '@/components/SafeArtwork';
import ContentRatingBadge from '@/components/ContentRatingBadge';
import WatchedToggle from '@/components/WatchedToggle';
import RatingBadge from '@/components/RatingBadge';
import type { StremioPluginCatalogItem } from '@/lib/desktopApi';
import { mediaFormatLabel } from '@/shared/mediaFormat';
import { cacheWatchedDiscoverItem, discoverWatchedKey } from '@/lib/watched';

/* Keep the Discover card pitch aligned with the local-library poster cards so
   VirtualPosterGrid can reuse the same responsive geometry and scroll rhythm. */
const SKIPPED_CARD_SIZE = '[contain-intrinsic-size:200px_384px] [content-visibility:auto]';
const ROOT_CLASS = `loom-poster-link loom-virtual-poster-card group relative flex h-full w-full max-w-[200px] flex-col overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--loom-bg)] ${SKIPPED_CARD_SIZE}`;
const FALLBACK_CLASS = 'flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--loom-surface)] p-3';
const FALLBACK_TEXT_CLASS = 'line-clamp-4 text-center text-xs leading-tight text-[var(--loom-muted)]';
const BACKDROP_CLASS = 'absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/40';
const PLAY_OVERLAY_CLASS = 'absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100';

function artworkSources(item: StremioPluginCatalogItem): string[] {
  return Array.from(new Set([
    item.artwork?.poster,
    item.artwork?.background,
    item.artwork?.logo,
    item.posterUrl,
    item.backgroundUrl,
    item.logoUrl,
  ].filter((value): value is string => Boolean(value))));
}

function fallbackArtwork(title: string) {
  return (
    <div className={FALLBACK_CLASS}>
      <Play className="h-8 w-8 shrink-0 text-[var(--loom-accent)]" />
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
}: {
  item: StremioPluginCatalogItem;
  rank?: number;
  metaLine?: string;
  showContentRating?: boolean;
  onSelect: (item: StremioPluginCatalogItem) => void;
  onPlayTrailer?: () => void;
  onPlay?: (item: StremioPluginCatalogItem) => void;
}) {
  const { watchedKeys, setWatched } = useProfiles();
  const watchedKey = discoverWatchedKey(item);
  const watched = watchedKeys.has(watchedKey);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item)}
      onKeyDown={(event) => {
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
        <RatingBadge rating={item.rating} providerRatings={item.providerRatings} />
        <div className={BACKDROP_CLASS} />
        <div className={PLAY_OVERLAY_CLASS}>
          {onPlay ? (
            <button
              type="button"
              aria-label={`Play ${item.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onPlay(item);
              }}
              onKeyDown={(event) => event.stopPropagation()}
              className="loom-poster-play-action inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-3.5 text-sm font-semibold text-black shadow-xl transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
            >
              <Play className="h-4 w-4 fill-current" />
              Play
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
              className="loom-poster-play-action grid h-12 w-12 place-items-center rounded-full bg-white text-black shadow-xl transition-transform duration-200 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
            >
              <Play className="ml-0.5 h-5 w-5 fill-current" />
            </button>
          ) : (
            <Play className="h-8 w-8 fill-current text-[var(--loom-accent)] drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] transition-transform duration-200 group-hover:scale-110" />
          )}
        </div>
      </div>
      <div className="mt-2 shrink-0 overflow-hidden">
        <h4 className="truncate text-sm font-semibold text-[var(--loom-text)]">{item.title}</h4>
        {(metaLine || item.contentRating || item.format) && (
          <div className="loom-poster-meta mt-1.5 flex min-w-0 items-center gap-x-1.5 gap-y-1">
            {metaLine && <p className="min-w-0 truncate text-xs text-[var(--loom-muted)]">{metaLine}</p>}
            <ContentRatingBadge
              rating={mediaFormatLabel(item.format, item.type)}
              className="shrink-0 bg-[var(--loom-surface-3)]"
            />
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
