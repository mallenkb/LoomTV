import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Play } from 'lucide-react';
import { useLibrary, MediaItem, TVShow } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { desktopApi } from '@/lib/desktopApi';
import LibrarySearch from '@/components/LibrarySearch';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import SafeArtwork from '@/components/SafeArtwork';
import { posterSources, routeArtworkState } from '@/lib/artwork';

export default function Home() {
  const { state } = useLibrary();
  const { movies, tvShows, animeShows, isLoading } = state;
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const normalizedQuery = searchQuery(query);

  const continueWatching = [...movies, ...tvShows, ...animeShows]
    .filter((item) => matchesMediaItem(item, normalizedQuery))
    .filter((item) => item.lastPlayed)
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
    .slice(0, 30);
  const filteredAnime = animeShows.filter((item) => matchesMediaItem(item, normalizedQuery));
  const filteredTVShows = tvShows.filter((item) => matchesMediaItem(item, normalizedQuery));
  const filteredMovies = movies.filter((item) => matchesMediaItem(item, normalizedQuery));
  const showAnimeSection = !normalizedQuery || isLoading || filteredAnime.length > 0;
  const showTVSection = !normalizedQuery || isLoading || filteredTVShows.length > 0;
  const showMoviesSection = !normalizedQuery || isLoading || filteredMovies.length > 0;

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a]">
      <LibrarySearch value={query} onChange={setQuery} placeholder="Search Home" />
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6 pt-24">
        {continueWatching.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-white">Continue Watching</h3>
              <Button variant="ghost" size="sm" className="text-[#a8a8a8]">
                See All <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
            <MediaRail items={continueWatching} isLoading={isLoading} from={currentRoute} />
          </section>
        )}

        {showAnimeSection && (
          <section className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-white">Anime</h3>
              <Link to="/anime">
                <Button variant="ghost" size="sm" className="text-[#a8a8a8]">
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
              <h3 className="text-xl font-semibold text-white">TV Shows</h3>
              <Link to="/tv">
                <Button variant="ghost" size="sm" className="text-[#a8a8a8]">
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
              <h3 className="text-xl font-semibold text-white">Movies</h3>
              <Link to="/movies">
                <Button variant="ghost" size="sm" className="text-[#a8a8a8]">
                  See All <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </Link>
            </div>
            <MediaRail items={filteredMovies.slice(0, 30)} isLoading={isLoading} from={currentRoute} />
          </section>
        )}
        {normalizedQuery && !isLoading && continueWatching.length === 0 && filteredAnime.length === 0 && filteredTVShows.length === 0 && filteredMovies.length === 0 && (
          <div className="py-12 text-center text-[#a8a8a8]">No local matches found</div>
        )}
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
      className="group block w-[200px] flex-none"
    >
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden">
        {imageSources.length > 0 ? (
          <SafeArtwork
            src={imageSources}
            alt={item.title}
            className="h-full w-full transition-transform group-hover:scale-105"
            imgClassName="object-cover"
          />
        ) : (
          <div className="w-full h-full bg-[#232323] flex flex-col items-center justify-center gap-2 p-3">
            <Play className="w-8 h-8 text-[#eba865] shrink-0" />
            <p className="text-[#a8a8a8] text-xs text-center leading-tight line-clamp-4">{item.title}</p>
          </div>
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-[#eba865] flex items-center justify-center">
            <Play className="w-6 h-6 text-black ml-1" />
          </div>
        </div>
      </div>
      <div className="mt-2">
        <h4 className="text-sm font-medium text-white truncate">{item.title}</h4>
        <p className="text-xs text-[#a8a8a8]">{item.year}</p>
      </div>
    </LinkComponent>
  );
}

function mediaLink(item: MediaItem): string {
  if (item.type === 'movie') return `/movie/${item.id}`;
  if (item.type === 'anime') return `/anime/${item.id}`;
  return `/tv/${item.id}`;
}
