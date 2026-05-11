import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Film, Play, Star } from 'lucide-react';
import { useLibrary, MediaItem } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { desktopApi } from '@/lib/desktopApi';
import LibrarySearch from '@/components/LibrarySearch';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import SafeArtwork from '@/components/SafeArtwork';
import { posterSources, routeArtworkState } from '@/lib/artwork';

export default function Movies() {
  const { state, addLibraryFolder } = useLibrary();
  const { movies, isLoading, isScanning } = state;
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const normalizedQuery = searchQuery(query);
  const filteredMovies = movies.filter((item) => matchesMediaItem(item, normalizedQuery));

  return (
    <div className="loom-page h-full overflow-y-auto">
      <LibrarySearch value={query} onChange={setQuery} />
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6 pt-24">
        <h2 className="loom-section-title mb-6 text-2xl font-bold text-white">Movies</h2>
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
          <EmptyMoviesState isScanning={isScanning} onAddFolder={() => addLibraryFolder('movies')} />
        )}
        {movies.length > 0 && filteredMovies.length === 0 && !isLoading && (
          <div className="py-12 text-center text-[var(--loom-muted)]">No local matches found</div>
        )}
      </div>
    </div>
  );
}

function EmptyMoviesState({
  isScanning,
  onAddFolder,
}: {
  isScanning: boolean;
  onAddFolder: () => Promise<void>;
}) {
  return (
    <div className="flex min-h-[calc(100vh-260px)] items-center justify-center px-4">
      <div className="w-full max-w-[520px] text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] border border-[var(--loom-panel-border)] bg-[var(--loom-panel)]">
          <Film className="h-9 w-9 text-[var(--loom-accent)]" />
        </div>
        <h3 className="text-2xl font-semibold text-white">Add a Movies folder</h3>
        <p className="mx-auto mt-3 max-w-[420px] text-sm leading-6 text-[var(--loom-muted)]">
          Choose a folder containing your films. LoomTV will scan it and build your movie library.
        </p>
        <Button onClick={onAddFolder} disabled={isScanning} className="mt-8 h-12 gap-2 px-5">
          <Film className="h-4 w-4" />
          Add Movies Folder
        </Button>
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
      className="loom-poster-link group block w-full max-w-[200px]"
    >
      <div className="loom-poster-frame relative aspect-[2/3] overflow-hidden rounded-lg transition-all duration-200">
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
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--loom-accent)] shadow-[0_0_0_6px_rgba(251,197,0,0.14)]">
            <Play className="w-6 h-6 text-[var(--loom-accent-foreground)] ml-1" />
          </div>
        </div>
      </div>
      <div className="mt-2">
        <h4 className="truncate text-sm font-semibold text-white">{movie.title}</h4>
        {movie.year > 0 && <p className="text-xs text-[var(--loom-muted)]">{movie.year}</p>}
      </div>
    </Link>
  );
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
