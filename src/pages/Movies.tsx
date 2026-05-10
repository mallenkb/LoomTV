import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Play, Star } from 'lucide-react';
import { useLibrary, MediaItem } from '@/contexts/LibraryContext';
import { Skeleton } from '@/components/ui/skeleton';
import { desktopApi } from '@/lib/desktopApi';
import LibrarySearch from '@/components/LibrarySearch';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import SafeArtwork from '@/components/SafeArtwork';
import { posterSources, routeArtworkState } from '@/lib/artwork';

export default function Movies() {
  const { state } = useLibrary();
  const { movies, isLoading } = state;
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const normalizedQuery = searchQuery(query);
  const filteredMovies = movies.filter((item) => matchesMediaItem(item, normalizedQuery));

  return (
    <div className="h-full overflow-y-auto bg-[var(--loom-bg)]">
      <LibrarySearch value={query} onChange={setQuery} placeholder="Search Movies" />
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6 pt-24">
        <h2 className="text-2xl font-bold text-white mb-6">Movies</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
          {isLoading
            ? Array.from({ length: 12 }).map((_, i) => (
                <Skeleton key={i} className="h-[300px] w-full max-w-[200px] rounded-lg" />
              ))
            : filteredMovies.map((item) => (
                <MovieCard key={item.id} movie={item} from={currentRoute} />
              ))}
        </div>
        {movies.length === 0 && !isLoading && (
          <div className="text-center py-12">
            <p className="text-[var(--loom-muted)] mb-4">No movies found</p>
            <Link to="/settings" className="text-[var(--loom-accent)] hover:underline">
              Add a library folder in Settings
            </Link>
          </div>
        )}
        {movies.length > 0 && filteredMovies.length === 0 && !isLoading && (
          <div className="py-12 text-center text-[var(--loom-muted)]">No local matches found</div>
        )}
      </div>
    </div>
  );
}

function MovieCard({ movie, from }: { movie: MediaItem; from: string }) {
  const [fallbackThumbnail, setFallbackThumbnail] = useState('');
  const imageSources = posterSources(movie, undefined, fallbackThumbnail ? [fallbackThumbnail] : []);

  useEffect(() => {
    setFallbackThumbnail('');

    let isMounted = true;
    void desktopApi.getThumbnail(movie.filePath, '00:03:00')
      .then(({ url }) => {
        if (isMounted) setFallbackThumbnail(url);
      })
      .catch(() => {
        if (isMounted) setFallbackThumbnail('');
      });

    return () => {
      isMounted = false;
    };
  }, [movie.filePath]);

  return (
    <Link
      to={`/movie/${movie.id}`}
      state={{ from, artwork: routeArtworkState(movie, imageSources) }}
      className="group block w-full max-w-[200px]"
    >
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden">
        <SafeArtwork
          src={imageSources}
          alt={movie.title}
          className="h-full w-full transition-transform group-hover:scale-105"
          imgClassName="object-cover"
          fallback={
          <div className="w-full h-full bg-[var(--loom-surface)] flex flex-col items-center justify-center gap-2 p-3">
            <Play className="w-8 h-8 text-[var(--loom-accent)] shrink-0" />
            <p className="text-[var(--loom-muted)] text-xs text-center leading-tight line-clamp-4">{movie.title}</p>
          </div>
          }
        />
        <RatingBadge rating={movie.rating} />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-[var(--loom-accent)] flex items-center justify-center">
            <Play className="w-6 h-6 text-[var(--loom-accent-foreground)] ml-1" />
          </div>
        </div>
      </div>
      <div className="mt-2">
        <h4 className="text-sm font-medium text-white truncate">{movie.title}</h4>
        {movie.year > 0 && <p className="text-xs text-[var(--loom-muted)]">{movie.year}</p>}
      </div>
    </Link>
  );
}

function RatingBadge({ rating }: { rating?: number }) {
  if (!rating || rating <= 0) return null;
  return (
    <div className="absolute right-2 top-2 z-10 inline-flex h-7 items-center gap-1 rounded-md bg-black/72 px-2 text-xs font-semibold text-[#F5C451] shadow-lg backdrop-blur-md">
      <Star className="h-3.5 w-3.5" fill="currentColor" />
      {rating.toFixed(1)}
    </div>
  );
}
