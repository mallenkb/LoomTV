import { memo } from 'react';
import { Play, Star } from 'lucide-react';
import SafeArtwork from '@/components/SafeArtwork';
import type { StremioPluginCatalogItem } from '@/lib/desktopApi';

/* Keep the Discover card pitch aligned with the local-library poster cards so
   VirtualPosterGrid can reuse the same responsive geometry and scroll rhythm. */
const SKIPPED_CARD_SIZE = '[contain-intrinsic-size:200px_340px] [content-visibility:auto]';
const ROOT_CLASS = `loom-poster-link group block w-full max-w-[200px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--loom-bg)] ${SKIPPED_CARD_SIZE}`;
const FALLBACK_CLASS = 'flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--loom-surface)] p-3';
const FALLBACK_TEXT_CLASS = 'line-clamp-4 text-center text-xs leading-tight text-[var(--loom-muted)]';
const BACKDROP_CLASS = 'absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/40';
const PLAY_OVERLAY_CLASS = 'absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100';

function artworkSources(item: StremioPluginCatalogItem): string[] {
  return Array.from(new Set([
    item.artwork?.poster,
    item.artwork?.background,
    item.artwork?.logo,
  ].filter((value): value is string => Boolean(value))));
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
  metaLine = '',
  onSelect,
}: {
  item: StremioPluginCatalogItem;
  metaLine?: string;
  onSelect: (item: StremioPluginCatalogItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      className={ROOT_CLASS}
      aria-label={`${item.title}${item.releaseInfo ? ` (${item.releaseInfo})` : ''}`}
    >
      <div className="loom-poster-frame relative aspect-[2/3] overflow-hidden rounded-lg transition-all duration-200">
        <SafeArtwork
          src={artworkSources(item)}
          alt={item.title}
          className="h-full w-full transition-transform group-hover:scale-105"
          imgClassName="object-cover"
          fallback={fallbackArtwork(item.title)}
        />
        <RatingBadge rating={item.rating} />
        <div className={BACKDROP_CLASS} />
        <div className={PLAY_OVERLAY_CLASS}>
          <Play className="h-8 w-8 fill-current text-[var(--loom-accent)] drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] transition-transform duration-200 group-hover:scale-110" />
        </div>
      </div>
      <div className="mt-2 overflow-hidden">
        <h4 className="truncate text-sm font-semibold text-[var(--loom-text)]">{item.title}</h4>
        {metaLine && <p className="text-xs text-[var(--loom-muted)]">{metaLine}</p>}
      </div>
    </button>
  );
});

export default StremioPosterCard;
