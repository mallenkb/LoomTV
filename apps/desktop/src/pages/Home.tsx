import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Film, FolderPlus, Tv } from 'lucide-react';
import { useLibrary, MediaItem } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import LibrarySearch from '@/components/LibrarySearch';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import MediaPosterCard from '@/components/MediaPosterCard';
import { mediaMetaLine } from '@/components/MediaPosterCard.helpers';

export default function Home() {
  const { state, addLibraryFolder } = useLibrary();
  const { movies, tvShows, animeShows, isLoading, isScanning } = state;
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const normalizedQuery = searchQuery(query);
  const hasLibraryItems = movies.length > 0 || tvShows.length > 0 || animeShows.length > 0;

  const continueWatching = useMemo(() => [...movies, ...tvShows, ...animeShows]
    .filter((item) => item.lastPlayed)
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
    .slice(0, 30), [animeShows, movies, tvShows]);
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
              <Button variant="ghost" size="sm" className="text-[var(--loom-muted)]">
                See All <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
            <MediaRail items={continueWatching} isLoading={isLoading} from={currentRoute} />
          </section>
        )}

        {showAnimeSection && (
          <section className="mb-8">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="loom-section-title text-2xl font-bold text-white">Anime</h3>
              <Link to="/anime">
                <Button variant="ghost" size="sm" className="text-[var(--loom-muted)]">
                  See All <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </Link>
            </div>
            <MediaRail items={filteredAnime.slice(0, 30)} isLoading={isLoading} from={currentRoute} />
          </section>
        )}

        {showTVSection && (
          <section className="mb-8">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="loom-section-title text-2xl font-bold text-white">TV Shows</h3>
              <Link to="/tv">
                <Button variant="ghost" size="sm" className="text-[var(--loom-muted)]">
                  See All <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </Link>
            </div>
            <MediaRail items={filteredTVShows.slice(0, 30)} isLoading={isLoading} from={currentRoute} />
          </section>
        )}

        {showMoviesSection && (
          <section className="mb-8">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="loom-section-title text-2xl font-bold text-white">Movies</h3>
              <Link to="/movies">
                <Button variant="ghost" size="sm" className="text-[var(--loom-muted)]">
                  See All <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </Link>
            </div>
            <MediaRail items={filteredMovies.slice(0, 30)} isLoading={isLoading} from={currentRoute} />
          </section>
        )}
        {normalizedQuery && !isLoading && filteredAnime.length === 0 && filteredTVShows.length === 0 && filteredMovies.length === 0 && (
          <div className="py-12 text-center text-[var(--loom-muted)]">No local matches found</div>
        )}
      </div>
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

function MediaRail({ items, isLoading, from }: { items: MediaItem[]; isLoading: boolean; from: string }) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, dragged: false, startScrollLeft: 0, startX: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const rail = railRef.current;
    if (!rail || rail.scrollWidth <= rail.clientWidth) return;
    dragRef.current = {
      active: true,
      dragged: false,
      startScrollLeft: rail.scrollLeft,
      startX: event.clientX,
    };
    rail.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rail = railRef.current;
    if (!drag.active || !rail) return;
    const distance = event.clientX - drag.startX;
    if (!drag.dragged && Math.abs(distance) < 5) return;
    if (!drag.dragged) {
      drag.dragged = true;
      setIsDragging(true);
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
      className={`flex select-none gap-6 overflow-x-auto overflow-y-hidden pb-3 pr-6 [scrollbar-gutter:stable] ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
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
