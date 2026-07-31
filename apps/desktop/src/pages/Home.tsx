import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Film, FolderPlus, Tv } from 'lucide-react';
import { useLibrary, MediaItem } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import MediaRail from '@/components/MediaRail';
import LibrarySearch from '@/components/LibrarySearch';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import { useProgressSnapshot } from '@/lib/progress';
import MediaPosterCard from '@/components/MediaPosterCard';
import { mediaMetaLine } from '@/components/MediaPosterCard.helpers';
import { useProfiles } from '@/contexts/ProfileContext';
import { useTheme } from '@/components/ThemeProvider';
import ModernHome from '@/components/ModernHome';
import LibraryFilterBar from '@/components/LibraryFilterBar';
import { matchesLibraryFilter, type LibraryFilter } from '@/lib/libraryFilters';

export default function Home() {
  const { theme } = useTheme();
  return theme.homeStyle === 'modern' ? <ModernHome /> : <DefaultHome />;
}
function DefaultHome() {
  const { state, addLibraryFolder } = useLibrary();
  const { lists } = useProfiles();
  const { movies, tvShows, animeShows, isLoading, isScanning } = state;
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('all');
  const normalizedQuery = searchQuery(query);
  const hasLibraryItems = movies.length > 0 || tvShows.length > 0 || animeShows.length > 0;
  const myListItems = useMemo(() => {
    const byId = new Map([...movies, ...tvShows, ...animeShows].map((item) => [item.id, item]));
    const seen = new Set<string>();
    return lists
      .filter((entry) => entry.kind === 'watchlist' || entry.kind === 'favorite')
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((entry) => {
        if (seen.has(entry.mediaId)) return false;
        seen.add(entry.mediaId);
        return true;
      })
      .map((entry) => byId.get(entry.mediaId))
      .filter((item): item is MediaItem => Boolean(item));
  }, [animeShows, lists, movies, tvShows]);

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
  const visibleMyListItems = useMemo(
    () => myListItems.filter((item) => matchesLibraryFilter(item, activeFilter, progress)),
    [activeFilter, myListItems, progress],
  );
  const visibleContinueWatching = useMemo(
    () => continueWatching.filter((item) => matchesLibraryFilter(item, activeFilter, progress)),
    [activeFilter, continueWatching, progress],
  );
  const filteredAnime = useMemo(
    () => animeShows
      .filter((item) => matchesMediaItem(item, normalizedQuery))
      .filter((item) => matchesLibraryFilter(item, activeFilter, progress)),
    [activeFilter, animeShows, normalizedQuery, progress],
  );
  const filteredTVShows = useMemo(
    () => tvShows
      .filter((item) => matchesMediaItem(item, normalizedQuery))
      .filter((item) => matchesLibraryFilter(item, activeFilter, progress)),
    [activeFilter, normalizedQuery, progress, tvShows],
  );
  const filteredMovies = useMemo(
    () => movies
      .filter((item) => matchesMediaItem(item, normalizedQuery))
      .filter((item) => matchesLibraryFilter(item, activeFilter, progress)),
    [activeFilter, movies, normalizedQuery, progress],
  );
  const showAnimeSection = isLoading || filteredAnime.length > 0;
  const showTVSection = isLoading || filteredTVShows.length > 0;
  const showMoviesSection = isLoading || filteredMovies.length > 0;

  return (
    <div className="loom-page h-full overflow-y-auto">
      <LibrarySearch
        value={query}
        onChange={setQuery}
        placeholder="Search all libraries"
        rightSlot={<LibraryFilterBar activeFilter={activeFilter} onChange={setActiveFilter} />}
      />
      <div className="loom-frame page-bottom-safe pt-24">
        {!normalizedQuery && activeFilter === 'all' && !isLoading && !hasLibraryItems && (
          <HomeEmptyState isScanning={isScanning} onAddFolder={addLibraryFolder} />
        )}

        {!normalizedQuery && visibleMyListItems.length > 0 && (
          <MediaRail title="My List" className="mb-8">
            <PosterCards items={visibleMyListItems.slice(0, 20)} from={currentRoute} />
          </MediaRail>
        )}

        {!normalizedQuery && visibleContinueWatching.length > 0 && (
          <MediaRail title="Continue Watching" className="mb-8">
            <PosterCards items={visibleContinueWatching} from={currentRoute} isLoading={isLoading} />
          </MediaRail>
        )}

        {showAnimeSection && (
          <MediaRail title="Anime" className="mb-8" action={<SeeAllLink to="/anime" />}>
            <PosterCards items={filteredAnime.slice(0, 10)} from={currentRoute} isLoading={isLoading} />
          </MediaRail>
        )}

        {showTVSection && (
          <MediaRail title="TV Shows" className="mb-8" action={<SeeAllLink to="/tv" />}>
            <PosterCards items={filteredTVShows.slice(0, 10)} from={currentRoute} isLoading={isLoading} />
          </MediaRail>
        )}

        {showMoviesSection && (
          <MediaRail title="Movies" className="mb-8" action={<SeeAllLink to="/movies" />}>
            <PosterCards items={filteredMovies.slice(0, 10)} from={currentRoute} isLoading={isLoading} />
          </MediaRail>
        )}
        {!isLoading && (normalizedQuery || activeFilter !== 'all') && filteredAnime.length === 0 && filteredTVShows.length === 0 && filteredMovies.length === 0 && (
          <div className="py-12 text-center text-[var(--loom-muted)]">
            {activeFilter !== 'all' && !normalizedQuery ? 'No titles match this filter' : 'No local matches found'}
          </div>
        )}
      </div>
    </div>
  );
}

function SeeAllLink({ to }: { to: string }) {
  return (
    <Link to={to}>
      <Button
        variant="ghost"
        className="h-10 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] px-4 text-[var(--loom-muted)] shadow-lg backdrop-blur-md hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
      >
        See All
      </Button>
    </Link>
  );
}

function PosterCards({ items, from, isLoading = false }: { items: MediaItem[]; from: string; isLoading?: boolean }) {
  if (isLoading) {
    return (
      <>
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-[300px] w-[200px] flex-none rounded-lg" />
        ))}
      </>
    );
  }
  return (
    <>
      {items.map((item) => (
        <MediaPosterCard key={item.id} item={item} from={from} variant="home" metaLine={mediaMetaLine(item)} />
      ))}
    </>
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
