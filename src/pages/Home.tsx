import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Film, FolderPlus, Play, Star, Tv } from 'lucide-react';
import { useLibrary, MediaItem, TVShow } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { desktopApi } from '@/lib/desktopApi';
import LibrarySearch from '@/components/LibrarySearch';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import SafeArtwork from '@/components/SafeArtwork';
import { posterSources, routeArtworkState } from '@/lib/artwork';

export default function Home() {
  const { state, addLibraryFolder } = useLibrary();
  const { movies, tvShows, animeShows, isLoading, isScanning } = state;
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const normalizedQuery = searchQuery(query);
  const hasLibraryItems = movies.length > 0 || tvShows.length > 0 || animeShows.length > 0;

  const continueWatching = [...movies, ...tvShows, ...animeShows]
    .filter((item) => item.lastPlayed)
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
    .slice(0, 30);
  const filteredAnime = animeShows.filter((item) => matchesMediaItem(item, normalizedQuery));
  const filteredTVShows = tvShows.filter((item) => matchesMediaItem(item, normalizedQuery));
  const filteredMovies = movies.filter((item) => matchesMediaItem(item, normalizedQuery));
  const showAnimeSection = isLoading || filteredAnime.length > 0;
  const showTVSection = isLoading || filteredTVShows.length > 0;
  const showMoviesSection = isLoading || filteredMovies.length > 0;

  return (
    <div className="loom-page h-full overflow-y-auto">
      <LibrarySearch value={query} onChange={setQuery} />
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6 pt-24">
        {!normalizedQuery && !isLoading && !hasLibraryItems && (
          <HomeEmptyState isScanning={isScanning} onAddFolder={addLibraryFolder} />
        )}

        {!normalizedQuery && continueWatching.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="loom-section-title text-xl font-semibold text-white">Continue Watching</h3>
              <Button variant="ghost" size="sm" className="text-[var(--loom-muted)]">
                See All <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
            <MediaRail items={continueWatching} isLoading={isLoading} from={currentRoute} />
          </section>
        )}

        {showAnimeSection && (
          <section className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="loom-section-title text-xl font-semibold text-white">Anime</h3>
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
            <div className="flex items-center justify-between mb-4">
              <h3 className="loom-section-title text-xl font-semibold text-white">TV Shows</h3>
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
            <div className="flex items-center justify-between mb-4">
              <h3 className="loom-section-title text-xl font-semibold text-white">Movies</h3>
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
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] border border-[var(--loom-panel-border)] bg-[var(--loom-panel)]">
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
  return (
    <div className="flex gap-6 overflow-x-auto overflow-y-hidden pb-3 pr-6 [scrollbar-gutter:stable]">
      {isLoading
        ? Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[300px] w-[200px] flex-none rounded-lg" />
          ))
        : items.map((item) => (
            <MediaCard key={item.id} item={item} from={from} />
          ))}
    </div>
  );
}

function MediaCard({ item, from }: { item: MediaItem; from: string }) {
  const LinkComponent = Link;
  const to = mediaLink(item);
  const [fallbackThumbnail, setFallbackThumbnail] = useState('');
  const imageSources = posterSources(item, undefined, fallbackThumbnail ? [fallbackThumbnail] : []);
  const fallbackFilePath = item.type === 'movie'
    ? item.filePath
    : (item as TVShow).episodeFiles?.slice().sort((a, b) => a.season - b.season || a.episode - b.episode)[0]?.filePath;
  const seasonCount = item.type === 'movie' ? 0 : availableSeasonCount(item as TVShow);
  const metaParts = [
    item.year > 0 ? String(item.year) : '',
    seasonCount > 0 ? `${seasonCount} ${seasonCount === 1 ? 'Season' : 'Seasons'}` : '',
  ].filter(Boolean);
  const metaLine = metaParts.join(' · ');

  useEffect(() => {
    setFallbackThumbnail('');

    if (!fallbackFilePath) return;

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
  }, [fallbackFilePath]);

  return (
    <LinkComponent
      to={to}
      state={{ from, artwork: routeArtworkState(item, imageSources) }}
      className="loom-poster-link group block w-[200px] flex-none"
    >
      <div className="loom-poster-frame relative aspect-[2/3] overflow-hidden rounded-lg transition-all duration-200">
        <SafeArtwork
          src={imageSources}
          alt={item.title}
          className="h-full w-full transition-transform group-hover:scale-105"
          imgClassName="object-cover"
          fallback={
          <div className="w-full h-full bg-[var(--loom-surface)] flex flex-col items-center justify-center gap-2 p-3">
            <Play className="w-8 h-8 text-[var(--loom-accent)] shrink-0" />
            <p className="text-[var(--loom-muted)] text-xs text-center leading-tight line-clamp-4">{item.title}</p>
          </div>
          }
        />
        <RatingBadge rating={item.rating} />
        <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/40" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--loom-accent)] shadow-[0_0_0_6px_rgba(251,197,0,0.14)]">
            <Play className="w-6 h-6 text-[var(--loom-accent-foreground)] ml-1" />
          </div>
        </div>
      </div>
      <div className="mt-2">
        <h4 className="truncate text-sm font-semibold text-white">{item.title}</h4>
        {metaLine && <p className="text-xs text-[var(--loom-muted)]">{metaLine}</p>}
      </div>
    </LinkComponent>
  );
}

function availableSeasonCount(show: TVShow): number {
  const fileSeasons = new Set((show.episodeFiles || []).map((file) => file.season).filter((season) => season > 0));
  return fileSeasons.size || (show.seasons || []).length;
}

function RatingBadge({ rating }: { rating?: number }) {
  if (!rating || rating <= 0) return null;
  return (
    <div className="loom-chip absolute right-2 top-2 z-10 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-semibold backdrop-blur-md">
      <Star className="h-3.5 w-3.5" fill="currentColor" />
      {rating.toFixed(1)}
    </div>
  );
}

function mediaLink(item: MediaItem): string {
  if (item.type === 'movie') return `/movie/${item.id}`;
  if (item.type === 'anime') return `/anime/${item.id}`;
  return `/tv/${item.id}`;
}
