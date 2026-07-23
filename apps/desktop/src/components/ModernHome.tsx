import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, FolderPlus, Play, Plus, Search, Star, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type MediaItem, type TVShow, useLibrary } from '@/contexts/LibraryContext';
import { useProfiles } from '@/contexts/ProfileContext';
import SafeArtwork from '@/components/SafeArtwork';
import MediaPosterCard from '@/components/MediaPosterCard';
import { Button } from '@/components/ui/button';
import { backdropSources, posterSources, routeArtworkState } from '@/lib/artwork';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import { useProgressSnapshot } from '@/lib/progress';
import { mediaLink, mediaMetaLine } from '@/components/MediaPosterCard.helpers';
import type { StoredProgress } from '@/lib/desktopApi';

export default function ModernHome() {
  const { state, addLibraryFolder } = useLibrary();
  const { lists, setListEntry } = useProfiles();
  const progress = useProgressSnapshot();
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeHeroIndex, setActiveHeroIndex] = useState(0);
  const [heroPaused, setHeroPaused] = useState(false);
  const searchControlRef = useRef<HTMLDivElement | null>(null);
  const { movies, tvShows, animeShows, isLoading, isScanning } = state;
  const allItems = useMemo(() => [...animeShows, ...tvShows, ...movies], [animeShows, movies, tvShows]);
  const heroItems = useMemo(() => {
    const preferredLibrary = animeShows.length > 0 ? animeShows : tvShows.length > 0 ? tvShows : movies;
    return preferredLibrary.slice(0, 6);
  }, [animeShows, movies, tvShows]);
  const hero = heroItems[activeHeroIndex] || heroItems[0];
  const normalizedQuery = searchQuery(query);
  const currentRoute = `${location.pathname}${location.search}`;
  const results = useMemo(
    () => normalizedQuery ? allItems.filter((item) => matchesMediaItem(item, normalizedQuery)) : [],
    [allItems, normalizedQuery],
  );
  const continueWatching = useMemo(() => {
    const recency = (item: MediaItem) => Math.max(
      progress[item.filePath]?.updatedAt || 0,
      ...(item.episodeFiles || []).map((episode) => progress[episode.filePath]?.updatedAt || 0),
    );
    return allItems
      .map((item) => [item, recency(item)] as const)
      .filter(([, updatedAt]) => updatedAt > 0)
      .sort((left, right) => right[1] - left[1])
      .map(([item]) => item);
  }, [allItems, progress]);
  const myListIds = useMemo(
    () => new Set(lists.filter((entry) => entry.kind === 'watchlist').map((entry) => entry.mediaId)),
    [lists],
  );

  useEffect(() => {
    if (activeHeroIndex < heroItems.length) return;
    setActiveHeroIndex(0);
  }, [activeHeroIndex, heroItems.length]);

  useEffect(() => {
    if (heroItems.length < 2 || heroPaused || searchOpen) return undefined;
    const rotationTimer = window.setInterval(() => {
      setActiveHeroIndex((current) => (current + 1) % heroItems.length);
    }, 8000);
    return () => window.clearInterval(rotationTimer);
  }, [heroItems.length, heroPaused, searchOpen]);

  useEffect(() => {
    const routeState = location.state as { openLibrarySearch?: boolean } | null;
    if (!routeState?.openLibrarySearch) return;

    setSearchOpen(true);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    if (!searchOpen) return undefined;

    const dismissSearch = (event: PointerEvent) => {
      if (!searchControlRef.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    const dismissSearchOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSearchOpen(false);
    };

    document.addEventListener('pointerdown', dismissSearch);
    document.addEventListener('keydown', dismissSearchOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissSearch);
      document.removeEventListener('keydown', dismissSearchOnEscape);
    };
  }, [searchOpen]);

  return (
    <div className="loom-modern-home relative h-full overflow-y-auto bg-[var(--loom-bg)] text-[var(--loom-text)]">
      <AnimatePresence>
        {searchOpen && (
          <motion.div
            key="library-search-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="loom-modern-search-overlay fixed inset-0 z-[60] overflow-y-auto px-6 pb-12 pt-[12vh] backdrop-blur-xl"
          >
            <div ref={searchControlRef} className="mx-auto w-full max-w-5xl">
              <div className="loom-modern-search-control flex h-16 items-center rounded-2xl border px-5 shadow-2xl">
                <Search className="h-6 w-6 shrink-0 text-[var(--loom-muted)]" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search your library"
                  autoComplete="off"
                  autoFocus
                  className="loom-modern-search-input h-16 min-w-0 flex-1 bg-transparent px-4 text-lg text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)]"
                />
                <button type="button" onClick={() => { setQuery(''); setSearchOpen(false); }} aria-label="Close search" className="grid h-10 w-10 place-items-center rounded-full text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]">
                  <X className="h-5 w-5" />
                </button>
              </div>
              {normalizedQuery ? (
                <SearchResults items={results} query={query} from={currentRoute} isLoading={isLoading} overlay />
              ) : (
                <p className="pt-8 text-center text-sm text-[var(--loom-muted)]">Search anime, TV shows, and movies</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!searchOpen && normalizedQuery ? (
        <SearchResults items={results} query={query} from={currentRoute} isLoading={isLoading} />
      ) : !searchOpen && hero ? (
        <>
          <Hero
            item={hero}
            from={currentRoute}
            inWatchlist={myListIds.has(hero.id)}
            onToggleWatchlist={() => void setListEntry(hero.id, 'watchlist', !myListIds.has(hero.id))}
            activeIndex={activeHeroIndex}
            itemCount={heroItems.length}
            onPrevious={() => setActiveHeroIndex((current) => (current - 1 + heroItems.length) % heroItems.length)}
            onNext={() => setActiveHeroIndex((current) => (current + 1) % heroItems.length)}
            onSelect={setActiveHeroIndex}
            onPauseChange={setHeroPaused}
          />
          <main className="loom-modern-content-frame page-bottom-safe relative z-10 -mt-24 space-y-10 px-8 pb-10">
            {continueWatching.length > 0 && (
              <ContinueWatchingRail items={continueWatching} from={currentRoute} progress={progress} />
            )}
            {animeShows.length > 0 && <MediaRail title="Anime" items={animeShows} from={currentRoute} />}
            {tvShows.length > 0 && <MediaRail title="TV Shows" items={tvShows} from={currentRoute} />}
            {movies.length > 0 && <MediaRail title="Movies" items={movies} from={currentRoute} />}
          </main>
        </>
      ) : !searchOpen ? (
        <div className="flex min-h-full items-center justify-center px-8 pt-24">
          <div className="max-w-lg text-center">
            <div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl border border-[var(--loom-border)] bg-[var(--loom-surface)]"><FolderPlus className="h-9 w-9 text-[var(--loom-accent)]" /></div>
            <h1 className="mt-6 text-3xl font-bold">Build your cinematic library</h1>
            <p className="mt-3 text-sm leading-6 text-[var(--loom-muted)]">Add anime, TV shows, or movies and LoomTV will turn your collection into a Modern home.</p>
            <Button disabled={isScanning} onClick={() => void addLibraryFolder('anime')} className="mt-7 gap-2 rounded-full px-6"><FolderPlus className="h-4 w-4" /> Add a folder</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type HeroProps = {
  item: MediaItem;
  from: string;
  inWatchlist: boolean;
  onToggleWatchlist: () => void;
  activeIndex: number;
  itemCount: number;
  onPrevious: () => void;
  onNext: () => void;
  onSelect: (index: number) => void;
  onPauseChange: (paused: boolean) => void;
};

function Hero({ item, from, inWatchlist, onToggleWatchlist, activeIndex, itemCount, onPrevious, onNext, onSelect, onPauseChange }: HeroProps) {
  const seasonCount = item.type === 'movie' ? 0 : availableSeasonCount(item as TVShow);
  const metadata = [item.year > 0 ? item.year : null, seasonCount ? `${seasonCount} ${seasonCount === 1 ? 'Season' : 'Seasons'}` : null, ...item.genres.slice(0, 2)].filter(Boolean).join(' • ');
  return (
    <section
      className="loom-modern-hero relative h-[clamp(38rem,76vh,54rem)] overflow-hidden bg-[var(--loom-bg)] text-white"
      aria-label="Featured titles"
      aria-roledescription="carousel"
      onPointerEnter={() => onPauseChange(true)}
      onPointerLeave={() => onPauseChange(false)}
    >
      <div className="loom-modern-hero-artwork absolute inset-y-0 left-1/2 w-full max-w-[1440px] -translate-x-1/2">
        <AnimatePresence initial={false} mode="sync">
          <motion.div
            key={`hero-artwork-${item.id}`}
            className="absolute inset-0"
            initial={{ opacity: 0, scale: 1.025 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          >
            <SafeArtwork src={backdropSources(item)} alt="" className="h-full w-full" imgClassName="object-cover object-center" />
          </motion.div>
        </AnimatePresence>
        <div className="loom-modern-hero-vignette absolute inset-0" />
      </div>
      <div className="loom-modern-content-frame loom-modern-hero-frame relative z-10 flex h-full items-stretch">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={`hero-copy-${item.id}`}
            className="flex w-full max-w-3xl flex-col justify-center px-8 pb-28 pt-32"
            initial={{ opacity: 0, x: -22 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 14 }}
            transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
          >
            <h1 className="font-semibold leading-[0.94] tracking-[-0.045em] drop-shadow-2xl text-[clamp(2.64rem,5vw,3.96rem)]">{item.title}</h1>
            {metadata && <p className="mt-5 text-sm font-medium text-white/68">{metadata}</p>}
            {item.summary && <p className="mt-4 max-w-xl text-base leading-7 text-white/72 line-clamp-3">{item.summary}</p>}
            <div className="mt-7 flex items-center gap-3">
              <Link to={mediaLink(item)} state={{ from, artwork: routeArtworkState(item, posterSources(item)) }} className="inline-flex h-14 items-center gap-2 rounded-full bg-white px-7 text-sm font-bold text-black transition-transform hover:scale-[1.02]">
                <Play className="h-5 w-5 fill-current" /> View details
              </Link>
              <button type="button" onClick={onToggleWatchlist} aria-label={inWatchlist ? `Remove ${item.title} from My List` : `Add ${item.title} to My List`} className="grid h-14 w-14 place-items-center rounded-full border border-white/30 bg-black/24 backdrop-blur-xl transition-colors hover:bg-white/15">
                {inWatchlist ? <Check className="h-6 w-6" /> : <Plus className="h-6 w-6" />}
              </button>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
      {itemCount > 1 && (
        <div className="absolute bottom-28 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/12 bg-black/42 p-1.5 shadow-xl backdrop-blur-xl">
          <button type="button" onClick={onPrevious} aria-label="Previous featured title" className="grid h-8 w-8 place-items-center rounded-full text-white/65 transition-colors hover:bg-white/12 hover:text-white">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-1.5" role="tablist" aria-label="Featured title slides">
            {Array.from({ length: itemCount }).map((_, index) => (
              <button
                key={`hero-dot-${index}`}
                type="button"
                role="tab"
                aria-selected={activeIndex === index}
                aria-label={`Show featured title ${index + 1}`}
                onClick={() => onSelect(index)}
                className={`h-2 rounded-full transition-[width,background-color] duration-300 ${activeIndex === index ? 'w-6 bg-white' : 'w-2 bg-white/35 hover:bg-white/60'}`}
              />
            ))}
          </div>
          <button type="button" onClick={onNext} aria-label="Next featured title" className="grid h-8 w-8 place-items-center rounded-full text-white/65 transition-colors hover:bg-white/12 hover:text-white">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </section>
  );
}

function MediaRail({ title, items, from }: { title: string; items: MediaItem[]; from: string }) {
  return (
    <section>
      <h2 className="mb-4 text-xl font-semibold">{title}</h2>
      <DragScrollRail className="gap-4">
        {items.slice(0, 24).map((item) => (
          <MediaPosterCard
            key={item.id}
            item={item}
            from={from}
            variant="home"
            metaLine={mediaMetaLine(item)}
          />
        ))}
      </DragScrollRail>
    </section>
  );
}

function ContinueWatchingRail({
  items,
  from,
  progress,
}: {
  items: MediaItem[];
  from: string;
  progress: Record<string, StoredProgress>;
}) {
  return (
    <section>
      <h2 className="mb-4 text-xl font-semibold">Continue Watching</h2>
      <DragScrollRail className="gap-4">
        {items.slice(0, 8).map((item) => (
          <ContinueWatchingCard key={item.id} item={item} from={from} progress={progress} />
        ))}
      </DragScrollRail>
    </section>
  );
}

function DragScrollRail({ children, className = '' }: { children: ReactNode; className?: string }) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, dragged: false, startScrollLeft: 0, startX: 0, startY: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const rail = railRef.current;
    if (!rail || rail.scrollWidth <= rail.clientWidth) return;
    dragRef.current = {
      active: true,
      dragged: false,
      startScrollLeft: rail.scrollLeft,
      startX: event.clientX,
      startY: event.clientY,
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rail = railRef.current;
    if (!drag.active || !rail) return;
    const distance = event.clientX - drag.startX;
    const verticalDistance = event.clientY - drag.startY;
    if (!drag.dragged && (Math.abs(distance) < 12 || Math.abs(distance) <= Math.abs(verticalDistance) * 1.2)) return;
    if (!drag.dragged) {
      drag.dragged = true;
      setIsDragging(true);
      rail.setPointerCapture(event.pointerId);
    }
    rail.scrollLeft = drag.startScrollLeft - distance;
    event.preventDefault();
  };

  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    setIsDragging(false);
    if (railRef.current?.hasPointerCapture(event.pointerId)) {
      railRef.current.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={railRef}
      className={`flex select-none overflow-x-auto overflow-y-hidden scroll-smooth pb-2 [scrollbar-gutter:stable] [touch-action:pan-y] ${className} ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      onClickCapture={(event) => {
        if (!dragRef.current.dragged) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current.dragged = false;
      }}
      onDragStart={(event) => event.preventDefault()}
      onPointerCancel={stopDrag}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={stopDrag}
    >
      {children}
    </div>
  );
}

function ContinueWatchingCard({
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
      <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-white/5 shadow-lg group-hover:border-white/25">
        <SafeArtwork
          src={backdropSources(item)}
          alt={item.title}
          className="h-full w-full"
          imgClassName="object-cover transition-transform duration-500 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-white text-black shadow-xl">
            <Play className="ml-0.5 h-5 w-5 fill-current" />
          </span>
        </div>
        {item.rating > 0 && (
          <span className="absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded-full border border-white/12 bg-black/70 px-2 text-[11px] font-semibold text-[#f5c451] backdrop-blur-md">
            <Star className="h-3 w-3 fill-current" />
            {item.rating.toFixed(1)}
          </span>
        )}
        <p className="absolute bottom-4 left-3 right-3 truncate text-sm font-semibold text-white">{item.title}</p>
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/16">
          <div className="h-full bg-[var(--loom-accent)]" style={{ width: `${progressPercent}%` }} />
        </div>
      </div>
    </Link>
  );
}

function latestProgressPercent(item: MediaItem, progress: Record<string, StoredProgress>): number {
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

function SearchResults({ items, query, from, isLoading, overlay = false }: { items: MediaItem[]; query: string; from: string; isLoading: boolean; overlay?: boolean }) {
  return (
    <main className={overlay ? 'w-full pb-10 pt-10' : 'loom-modern-content-frame page-bottom-safe px-8 pb-10 pt-28'}>
      <h1 className={overlay ? 'text-2xl font-bold tracking-tight' : 'text-3xl font-bold tracking-tight'}>Search results</h1>
      <p className="mt-2 text-sm text-[var(--loom-muted)]">{items.length} {items.length === 1 ? 'title' : 'titles'} matching “{query}”</p>
      <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(180px,200px))] gap-5">
        {items.map((item) => (
          <MediaPosterCard
            key={item.id}
            item={item}
            from={from}
            variant="home"
            metaLine={mediaMetaLine(item)}
          />
        ))}
      </div>
      {!isLoading && items.length === 0 && <p className="py-20 text-center text-[var(--loom-muted)]">No local matches found</p>}
    </main>
  );
}

function availableSeasonCount(show: TVShow): number {
  const seasons = new Set((show.episodeFiles || []).map((episode) => episode.season).filter((season) => season > 0));
  return seasons.size || (show.seasons || []).length;
}
