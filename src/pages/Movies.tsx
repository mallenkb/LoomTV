import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play } from 'lucide-react';
import { useLibrary, MediaItem } from '@/contexts/LibraryContext';
import { Skeleton } from '@/components/ui/skeleton';
import { desktopApi } from '@/lib/desktopApi';

export default function Movies() {
  const { state } = useLibrary();
  const { movies, isLoading } = state;

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a] p-6">
      <h2 className="text-2xl font-bold text-white mb-6">Movies</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {isLoading
          ? Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-[330px] w-[220px] rounded-lg" />
            ))
          : movies.map((item) => (
              <MovieCard key={item.id} movie={item} />
            ))}
      </div>
      {movies.length === 0 && !isLoading && (
        <div className="text-center py-12">
          <p className="text-[#a8a8a8] mb-4">No movies found</p>
          <Link to="/settings" className="text-[#eba865] hover:underline">
            Add a library folder in Settings
          </Link>
        </div>
      )}
    </div>
  );
}

function MovieCard({ movie }: { movie: MediaItem }) {
  const [fallbackThumbnail, setFallbackThumbnail] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = !imageFailed ? (movie.poster || fallbackThumbnail) : fallbackThumbnail;

  useEffect(() => {
    setFallbackThumbnail('');
    setImageFailed(false);

    if (movie.poster) return;

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
  }, [movie.filePath, movie.poster]);

  return (
    <Link to={`/movie/${movie.id}`} className="group">
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={movie.title}
            className="w-full h-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
            onError={() => {
              if (movie.poster && !fallbackThumbnail) {
                void desktopApi.getThumbnail(movie.filePath, '00:03:00')
                  .then(({ url }) => setFallbackThumbnail(url))
                  .catch(() => setFallbackThumbnail(''));
              }
              setImageFailed(true);
            }}
          />
        ) : (
          <div className="w-full h-full bg-[#232323] flex flex-col items-center justify-center gap-2 p-3">
            <Play className="w-8 h-8 text-[#eba865] shrink-0" />
            <p className="text-[#a8a8a8] text-xs text-center leading-tight line-clamp-4">{movie.title}</p>
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
        <h4 className="text-sm font-medium text-white truncate">{movie.title}</h4>
        {movie.year > 0 && <p className="text-xs text-[#a8a8a8]">{movie.year}</p>}
      </div>
    </Link>
  );
}
