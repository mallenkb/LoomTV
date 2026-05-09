import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Play } from 'lucide-react';
import { useLibrary, MediaItem } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { desktopApi } from '@/lib/desktopApi';

export default function Home() {
  const { state } = useLibrary();
  const { movies, tvShows, animeShows, isLoading } = state;

  const continueWatching = [...movies, ...tvShows, ...animeShows]
    .filter((item) => item.lastPlayed)
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
    .slice(0, 6);

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a]">
      <div className="p-6">
        {continueWatching.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-white">Continue Watching</h3>
              <Button variant="ghost" size="sm" className="text-[#a8a8a8]">
                See All <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              {isLoading
                ? Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-[330px] w-[220px] rounded-lg" />
                  ))
                : continueWatching.map((item) => (
                    <MediaCard key={item.id} item={item} />
                  ))}
            </div>
          </section>
        )}

        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xl font-semibold text-white">Anime</h3>
            <Link to="/anime">
              <Button variant="ghost" size="sm" className="text-[#a8a8a8]">
                See All <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-[330px] w-[220px] rounded-lg" />
                ))
              : animeShows.slice(0, 6).map((item) => (
                  <MediaCard key={item.id} item={item} />
                ))}
          </div>
        </section>

        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xl font-semibold text-white">TV Shows</h3>
            <Link to="/tv">
              <Button variant="ghost" size="sm" className="text-[#a8a8a8]">
                See All <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-[330px] w-[220px] rounded-lg" />
                ))
              : tvShows.slice(0, 6).map((item) => (
                  <MediaCard key={item.id} item={item} />
                ))}
          </div>
        </section>

        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xl font-semibold text-white">Movies</h3>
            <Link to="/movies">
              <Button variant="ghost" size="sm" className="text-[#a8a8a8]">
                See All <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-[330px] w-[220px] rounded-lg" />
                ))
              : movies.slice(0, 6).map((item) => (
                  <MediaCard key={item.id} item={item} />
                ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function MediaCard({ item }: { item: MediaItem }) {
  const LinkComponent = Link;
  const to = mediaLink(item);
  const [fallbackThumbnail, setFallbackThumbnail] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = !imageFailed ? (item.poster || fallbackThumbnail) : fallbackThumbnail;

  useEffect(() => {
    setFallbackThumbnail('');
    setImageFailed(false);

    if (item.poster || item.type !== 'movie') return;

    let isMounted = true;
    void desktopApi.getThumbnail(item.filePath, '00:03:00')
      .then(({ url }) => {
        if (isMounted) setFallbackThumbnail(url);
      })
      .catch(() => {
        if (isMounted) setFallbackThumbnail('');
      });

    return () => {
      isMounted = false;
    };
  }, [item.filePath, item.poster, item.type]);

  return (
    <LinkComponent to={to} className="group">
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={item.title}
            className="w-full h-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
            onError={() => {
              if (item.type === 'movie' && item.poster && !fallbackThumbnail) {
                void desktopApi.getThumbnail(item.filePath, '00:03:00')
                  .then(({ url }) => setFallbackThumbnail(url))
                  .catch(() => setFallbackThumbnail(''));
              }
              setImageFailed(true);
            }}
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
