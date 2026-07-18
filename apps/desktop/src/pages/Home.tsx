import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Film, FolderPlus, Tv } from 'lucide-react';
import { useLibrary, MediaItem } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import LibrarySearch from '@/components/LibrarySearch';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import { useProgressSnapshot } from '@/lib/progress';
import MediaPosterCard from '@/components/MediaPosterCard';
import { mediaMetaLine } from '@/components/MediaPosterCard.helpers';

export default function Home() {
  const { state, addLibraryFolder } = useLibrary();
  const { movies, tvShows, animeShows, isLoading, isScanning } = state;
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const continueWatchingRailRef = useRef<HTMLDivElement>(null);
  const animeRailRef = useRef<HTMLDivElement>(null);
  const tvRailRef = useRef<HTMLDivElement>(null);
  const moviesRailRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const normalizedQuery = searchQuery(query);
  const hasLibraryItems = movies.length > 0 || tvShows.length > 0 || animeShows.length > 0;

  // Recency comes from the active profile's progress, never from the shared
  // catalog, so one profile's viewing cannot reorder Home for another.
  const progress = useProgressSnapshot();
  const continueWatching = useMemo(() => {
    const recency = (item: MediaItem): number => {
      let last = progress[item.filePath]?.updatedAt || 0;
      for (const episodeFile of item.episodeFiles || []) {
        const updatedAt = progress[episodeFile.filePath]?.updatedAt || 0;
        if (updatedAt > last) last = updatedAt;
      }
      return last;
    };
    return [...movies, ...tvShows, ...animeShows]
      .map((item) => [item, recency(item)] as const)
      .filter(([, last]) => last > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([item]) => item);
  }, [animeShows, movies, tvShows, progress]);
  const filteredAnime = useMemo(
    () => animeShows.filter((item) => matchesMediaItem(item, normalizedQuery)),
    [animeShows, normalizedQuery],
  );
  const filteredTVShows = useMemo(
    () => tvShows.filter((item) => matchesMediaItem(item, normalizedQuery)),
    [normalizedQuery, tvShows],
  );
  const filteredMovies = useMemo(
    () => movies.filter((item) => matchesMediaItem(item, normalizedQuery)),
    [movies, normalizedQuery],
  );
  const showAnimeSection = isLoading || filteredAnime.length > 0;
  const showTVSection = isLoading || filteredTVShows.length > 0;
  const showMoviesSection = isLoading || filteredMovies.length > 0;
  const scrollRail = (railRef: RefObject<HTMLDivElement | null>, direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollLeft += direction * Math.max(240, rail.clientWidth * 0.8);
  };

  return (
    <div className="loom-page h-full overflow-y-auto">
      <LibrarySearch value={query} onChange={setQuery} placeholder="Search all libraries" />
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6 pt-24">
        {!normalizedQuery && !isLoading && !hasLibraryItems && (
          <HomeEmptyState isScanning={isScanning} onAddFolder={addLibraryFolder} />
        )}

        {!normalizedQuery && continueWatching.length > 0 && (
          <section className="mb-8">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="loom-section-title text-2xl font-bold text-white">Continue Watching</h3>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => scrollRail(continueWatchingRailRef, -1)}
                  aria-label="Scroll Continue Watching left"
                  className="h-10 w-10 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] text-white shadow-lg backdrop-blur-md hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
                >
                  <ChevronLeft className="h-5 w-5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => scrollRail(continueWatchingRailRef, 1)}
                  aria-label="Scroll Continue Watching right"
                  className="h-10 w-10 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] text-white shadow-lg backdrop-blur-md hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
                >
                  <ChevronRight className="h-5 w-5" />
                </Button>
              </div>
            </div>
            <MediaRail items={continueWatching} isLoading={isLoading} from={currentRoute} scrollRef={continueWatchingRailRef} />
          </section>
        )}

        {showAnimeSection && (
          <section className="mb-8">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="loom-section-title text-2xl font-bold text-white">Anime</h3>
              <RailHeaderControls label="Anime" seeAllTo="/anime" railRef={animeRailRef} onScroll={scrollRail} />
            </div>
            <MediaRail items={filteredAnime.slice(0, 10)} isLoading={isLoading} from={currentRoute} scrollRef={animeRailRef} />
          </section>
        )}

        {showTVSection && (
          <section className="mb-8">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="loom-section-title text-2xl font-bold text-white">TV Shows</h3>
              <RailHeaderControls label="TV Shows" seeAllTo="/tv" railRef={tvRailRef} onScroll={scrollRail} />
            </div>
            <MediaRail items={filteredTVShows.slice(0, 10)} isLoading={isLoading} from={currentRoute} scrollRef={tvRailRef} />
          </section>
        )}

        {showMoviesSection && (
          <section className="mb-8">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="loom-section-title text-2xl font-bold text-white">Movies</h3>
              <RailHeaderControls label="Movies" seeAllTo="/movies" railRef={moviesRailRef} onScroll={scrollRail} />
            </div>
            <MediaRail items={filteredMovies.slice(0, 10)} isLoading={isLoading} from={currentRoute} scrollRef={moviesRailRef} />
          </section>
        )}
        {normalizedQuery && !isLoading && filteredAnime.length === 0 && filteredTVShows.length === 0 && filteredMovies.length === 0 && (
          <div className="py-12 text-center text-[var(--loom-muted)]">No local matches found</div>
        )}
      </div>
    </div>
  );
}

const RAIL_ARROW_CLASS = 'h-10 w-10 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] text-white shadow-lg backdrop-blur-md hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]';

function RailHeaderControls({
  label,
  seeAllTo,
  railRef,
  onScroll,
}: {
  label: string;
  seeAllTo: string;
  railRef: RefObject<HTMLDivElement | null>;
  onScroll: (railRef: RefObject<HTMLDivElement | null>, direction: -1 | 1) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Link to={seeAllTo}>
        <Button
          variant="ghost"
          className="h-10 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] px-4 text-[var(--loom-muted)] shadow-lg backdrop-blur-md hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
        >
          See All
        </Button>
      </Link>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onScroll(railRef, -1)}
        aria-label={`Scroll ${label} left`}
        className={RAIL_ARROW_CLASS}
      >
        <ChevronLeft className="h-5 w-5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onScroll(railRef, 1)}
        aria-label={`Scroll ${label} right`}
        className={RAIL_ARROW_CLASS}
      >
        <ChevronRight className="h-5 w-5" />
      </Button>
    </div>
  );
}

function HomeEmptyState({
  isScanning,
  onAddFolder,
}: {
  isScanning: boolean;
  onAddFolder: (kind?: 'movies' | 'tvShows' | 'anime' | 'others') => Promise<void>;
}) {
  return (
    <div className="flex min-h-[calc(100vh-220px)] items-center justify-center px-4">
      <div className="w-full max-w-[620px] text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] bg-[var(--loom-panel)]">
          <FolderPlus className="h-9 w-9 text-[var(--loom-accent)]" />
        </div>
        <h2 className="text-2xl font-semibold text-white">Add your first library folder</h2>
        <p className="mx-auto mt-3 max-w-[460px] text-sm leading-6 text-[var(--loom-muted)]">
          Choose where LoomTV should look for your movies, TV shows, or anime. The folder will be scanned right away.
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          <Button onClick={() => onAddFolder('movies')} disabled={isScanning} className="h-12 gap-2">
            <Film className="h-4 w-4" />
            Movies
          </Button>
          <Button onClick={() => onAddFolder('tvShows')} disabled={isScanning} variant="outline" className="h-12 gap-2">
            <Tv className="h-4 w-4" />
            TV Shows
          </Button>
          <Button onClick={() => onAddFolder('anime')} disabled={isScanning} variant="outline" className="h-12 gap-2">
            <FolderPlus className="h-4 w-4" />
            Anime
          </Button>
        </div>
      </div>
    </div>
  );
}

function MediaRail({
  items,
  isLoading,
  from,
  scrollRef,
}: {
  items: MediaItem[];
  isLoading: boolean;
  from: string;
  scrollRef?: RefObject<HTMLDivElement | null>;
}) {
  const internalRailRef = useRef<HTMLDivElement>(null);
  const railRef = scrollRef || internalRailRef;
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
      className={`flex select-none gap-6 overflow-x-auto overflow-y-hidden scroll-smooth pb-3 pr-6 [scrollbar-gutter:stable] [touch-action:pan-y] ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      onClickCapture={(event) => {
        if (!dragRef.current.dragged) return;
        // Pointer capture ends before the browser dispatches the synthetic
        // click. Suppress only that click so a real tap still follows the
        // card link, while a drag never opens the card underneath the pointer.
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
      {isLoading
        ? Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[300px] w-[200px] flex-none rounded-lg" />
          ))
        : items.map((item) => (
            <MediaPosterCard key={item.id} item={item} from={from} variant="home" metaLine={mediaMetaLine(item)} />
          ))}
    </div>
  );
}
