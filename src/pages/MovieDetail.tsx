import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Play, Star, Clock, ArrowLeft } from 'lucide-react';
import { useLibrary, MediaItem, LocalMediaDetails } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

interface MovieDetailProps {
  onPlay?: (filePath: string, title: string, subtitles?: MediaItem['subtitles']) => void;
}

function formatDuration(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatLocalSpecs(metadata?: LocalMediaDetails): string[] {
  if (!metadata) return [];
  const specs: string[] = [];
  const duration = formatDuration(metadata.durationSeconds);
  if (duration) specs.push(duration);
  if (metadata.width && metadata.height) specs.push(`${metadata.width}x${metadata.height}`);
  if (metadata.videoCodec) specs.push(metadata.videoCodec.toUpperCase());
  if (metadata.audioCodec) specs.push(metadata.audioCodec.toUpperCase());
  if (metadata.container) specs.push(metadata.container.toUpperCase());
  return specs;
}

export default function MovieDetail({ onPlay }: MovieDetailProps) {
  const { id } = useParams<{ id: string }>();
  const { state } = useLibrary();
  const [movie, setMovie] = useState<MediaItem | null>(null);

  useEffect(() => {
    const found = state.movies.find((m) => m.id === id);
    setMovie(found || null);
  }, [id, state.movies]);

  if (!movie) {
    return (
      <div className="h-full overflow-y-auto bg-[#1a1a1a] p-6">
        <Skeleton className="h-[400px] w-full rounded-lg" />
        <div className="mt-4 space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
    );
  }

  const localSpecs = formatLocalSpecs(movie.localMetadata);

  const handlePlay = async () => {
    if (onPlay) {
      onPlay(movie.filePath, movie.title, movie.subtitles);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a]">
      <div className="relative h-[50vh] w-full">
        {(movie.backdrop || movie.poster) ? (
          <img src={movie.backdrop || movie.poster} alt={movie.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-[#232323]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#1a1a1a] via-[#1a1a1a]/50 to-transparent" />
        <Link to="/movies" className="absolute top-4 left-4 flex items-center gap-2 text-white hover:text-[#eba865] transition-colors">
          <ArrowLeft className="w-5 h-5" />
          Back
        </Link>

        <div className="absolute bottom-0 left-0 right-0 p-8 flex gap-6 items-end">
          {movie.poster && (
            <img
              src={movie.poster}
              alt={movie.title}
              className="hidden md:block w-28 rounded-lg shadow-xl shrink-0 border border-white/10"
            />
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-4xl font-bold text-white mb-2">{movie.title}</h1>
            <div className="flex items-center gap-4 text-[#a8a8a8] text-sm mb-3">
              <span className="flex items-center gap-1">
                <Star className="w-4 h-4 text-[#eba865]" fill="currentColor" />
                {movie.rating ? movie.rating.toFixed(1) : 'N/A'}
              </span>
              {movie.year > 0 && <span>{movie.year}</span>}
              {movie.fileSize && (
                <span className="flex items-center gap-1">
                  <Clock className="w-4 h-4" />
                  {(movie.fileSize / 1024 / 1024 / 1024).toFixed(1)} GB
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2 mb-5">
              {movie.genres.map((genre) => (
                <Badge key={genre} variant="outline" className="text-white border-white/30 text-xs">
                  {genre}
                </Badge>
              ))}
            </div>
            {localSpecs.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-5">
                {localSpecs.map((spec) => (
                  <Badge key={spec} variant="outline" className="text-[#eba865] border-[#eba865]/40 text-xs">
                    {spec}
                  </Badge>
                ))}
              </div>
            )}
            <Button onClick={handlePlay} className="bg-[#eba865] text-black hover:bg-[#d4964f] gap-2">
              <Play className="w-5 h-5" />
              Play
            </Button>
          </div>
        </div>
      </div>

      <div className="p-8">
        {movie.summary && (
          <section className="mb-8">
            <h3 className="text-lg font-semibold text-white mb-3">Summary</h3>
            <p className="text-[#a8a8a8] leading-relaxed">{movie.summary}</p>
          </section>
        )}

        {movie.localMetadata && (
          <section className="mb-8">
            <h3 className="text-lg font-semibold text-white mb-3">Local Media Info</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {movie.localMetadata.width && movie.localMetadata.height && (
                <div className="rounded-lg bg-[#232323] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Resolution</p>
                  <p className="text-white text-sm mt-1">{movie.localMetadata.width}x{movie.localMetadata.height}</p>
                </div>
              )}
              {movie.localMetadata.durationSeconds && (
                <div className="rounded-lg bg-[#232323] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Duration</p>
                  <p className="text-white text-sm mt-1">{formatDuration(movie.localMetadata.durationSeconds)}</p>
                </div>
              )}
              {movie.localMetadata.videoCodec && (
                <div className="rounded-lg bg-[#232323] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Video</p>
                  <p className="text-white text-sm mt-1">{movie.localMetadata.videoCodec}</p>
                </div>
              )}
              {movie.localMetadata.audioCodec && (
                <div className="rounded-lg bg-[#232323] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Audio</p>
                  <p className="text-white text-sm mt-1">
                    {movie.localMetadata.audioCodec}
                    {movie.localMetadata.audioTracks ? ` · ${movie.localMetadata.audioTracks} tracks` : ''}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {movie.cast.length > 0 && (
          <section>
            <h3 className="text-lg font-semibold text-white mb-3">Cast</h3>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {movie.cast.slice(0, 8).map((actor) => (
                <div key={actor.name} className="flex-shrink-0 w-20 text-center">
                  <Avatar className="w-16 h-16 mx-auto mb-2">
                    {actor.image ? (
                      <AvatarImage src={actor.image} alt={actor.name} />
                    ) : (
                      <AvatarFallback className="bg-[#2d2d2d] text-white text-xs">
                        {actor.name.charAt(0)}
                      </AvatarFallback>
                    )}
                  </Avatar>
                  <p className="text-xs text-white truncate">{actor.name}</p>
                  <p className="text-xs text-[#a8a8a8] truncate">{actor.character}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
