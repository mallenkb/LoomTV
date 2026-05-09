import React from 'react';
import { Link } from 'react-router-dom';
import { Play } from 'lucide-react';
import { useLibrary, TVShow } from '@/contexts/LibraryContext';
import { Skeleton } from '@/components/ui/skeleton';

interface TVShowsProps {
  kind?: 'series' | 'anime';
}

export default function TVShows({ kind = 'series' }: TVShowsProps) {
  const { state } = useLibrary();
  const { isLoading } = state;
  const tvShows = kind === 'anime' ? state.animeShows : state.tvShows;
  const title = kind === 'anime' ? 'Anime' : 'TV Shows';
  const emptyLabel = kind === 'anime' ? 'No anime found' : 'No TV shows found';

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a] p-6">
      <h2 className="text-2xl font-bold text-white mb-6">{title}</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {isLoading
          ? Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-[330px] w-[220px] rounded-lg" />
            ))
          : tvShows.map((item) => (
              <TVShowCard key={item.id} show={item} />
            ))}
      </div>
      {tvShows.length === 0 && !isLoading && (
        <div className="text-center py-12">
          <p className="text-[#a8a8a8] mb-4">{emptyLabel}</p>
          <Link to="/settings" className="text-[#eba865] hover:underline">
            Add a library folder in Settings
          </Link>
        </div>
      )}
    </div>
  );
}

function TVShowCard({ show }: { show: TVShow }) {
  const routeBase = show.type === 'anime' ? '/anime' : '/tv';
  return (
    <Link to={`${routeBase}/${show.id}`} className="group">
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden">
        {show.poster ? (
          <img
            src={show.poster}
            alt={show.title}
            className="w-full h-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-[#232323] flex flex-col items-center justify-center gap-2 p-3">
            <Play className="w-8 h-8 text-[#eba865] shrink-0" />
            <p className="text-[#a8a8a8] text-xs text-center leading-tight line-clamp-4">{show.title}</p>
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
        <h4 className="text-sm font-medium text-white truncate">{show.title}</h4>
        <p className="text-xs text-[#a8a8a8]">
          {show.year > 0 ? `${show.year} · ` : ''}{(show.seasons || []).length} {(show.seasons || []).length === 1 ? 'Season' : 'Seasons'}
        </p>
      </div>
    </Link>
  );
}
