import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FolderPlus, Play, Star, Tv } from 'lucide-react';
import { useLibrary, TVShow } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { desktopApi } from '@/lib/desktopApi';
import LibrarySearch from '@/components/LibrarySearch';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import SafeArtwork from '@/components/SafeArtwork';
import { posterSources, routeArtworkState } from '@/lib/artwork';
import { hydrateProgressFromDatabase, loadProgress } from '@/lib/progress';
import type { StoredProgress } from '@/lib/desktopApi';
import { libraryFilterOptions, matchesLibraryFilter, type LibraryFilter } from '@/lib/libraryFilters';

interface TVShowsProps {
  kind?: 'series' | 'anime';
}

export default function TVShows({ kind = 'series' }: TVShowsProps) {
  const { state, addLibraryFolder } = useLibrary();
  const { isLoading, isScanning } = state;
  const tvShows = kind === 'anime' ? state.animeShows : state.tvShows;
  const title = kind === 'anime' ? 'Anime' : 'TV Shows';
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('all');
  const [progress, setProgress] = useState<Record<string, StoredProgress>>(() => loadProgress());
  const normalizedQuery = searchQuery(query);
  const filteredShows = tvShows
    .filter((item) => matchesMediaItem(item, normalizedQuery))
    .filter((item) => matchesLibraryFilter(item, activeFilter, progress));

  useEffect(() => {
    const refresh = () => setProgress(loadProgress());
    void hydrateProgressFromDatabase().then(refresh);
    window.addEventListener('loomtv-progress', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('loomtv-progress', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return (
    <div className="loom-page h-full overflow-y-auto">
      <LibrarySearch value={query} onChange={setQuery} />
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6 pt-24">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <h2 className="loom-section-title text-2xl font-bold text-white">{title}</h2>
          <FilterBar activeFilter={activeFilter} onChange={setActiveFilter} />
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
          {isLoading
            ? Array.from({ length: 12 }).map((_, i) => (
                <Skeleton key={i} className="h-[300px] w-full max-w-[200px] rounded-lg" />
              ))
            : filteredShows.map((item) => (
                <TVShowCard key={item.id} show={item} from={currentRoute} />
              ))}
        </div>
        {tvShows.length === 0 && !isLoading && (
          <EmptyShowsState
            kind={kind}
            isScanning={isScanning}
            onAddFolder={() => addLibraryFolder(kind === 'anime' ? 'anime' : 'tvShows')}
          />
        )}
        {tvShows.length > 0 && filteredShows.length === 0 && !isLoading && (
          <div className="py-12 text-center text-[var(--loom-muted)]">
            {activeFilter === 'all' ? 'No local matches found' : `No ${title.toLowerCase()} match this filter`}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterBar({
  activeFilter,
  onChange,
}: {
  activeFilter: LibraryFilter;
  onChange: (filter: LibraryFilter) => void;
}) {
  return (
    <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-1">
      {libraryFilterOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={`h-8 shrink-0 rounded-md px-3 text-xs font-medium transition-colors ${
            activeFilter === option.id
              ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]'
              : 'text-[var(--loom-muted)] hover:bg-white/10 hover:text-white'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function EmptyShowsState({
  kind,
  isScanning,
  onAddFolder,
}: {
  kind: 'series' | 'anime';
  isScanning: boolean;
  onAddFolder: () => Promise<void>;
}) {
  const isAnime = kind === 'anime';
  const Icon = isAnime ? FolderPlus : Tv;
  const title = isAnime ? 'Add an Anime folder' : 'Add a TV Shows folder';
  const description = isAnime
    ? 'Choose a folder containing anime series. LoomTV will scan episodes and organize them into your anime library.'
    : 'Choose a folder containing TV series. LoomTV will scan episodes and organize them into your TV library.';
  const buttonLabel = isAnime ? 'Add Anime Folder' : 'Add TV Shows Folder';

  return (
    <div className="flex min-h-[calc(100vh-260px)] items-center justify-center px-4">
      <div className="w-full max-w-[520px] text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] border border-[var(--loom-panel-border)] bg-[var(--loom-panel)]">
          <Icon className="h-9 w-9 text-[var(--loom-accent)]" />
        </div>
        <h3 className="text-2xl font-semibold text-white">{title}</h3>
        <p className="mx-auto mt-3 max-w-[420px] text-sm leading-6 text-[var(--loom-muted)]">
          {description}
        </p>
        <Button onClick={onAddFolder} disabled={isScanning} className="mt-8 h-12 gap-2 px-5">
          <Icon className="h-4 w-4" />
          {buttonLabel}
        </Button>
      </div>
    </div>
  );
}

function TVShowCard({ show, from }: { show: TVShow; from: string }) {
  const routeBase = show.type === 'anime' ? '/anime' : '/tv';
  const [fallbackThumbnail, setFallbackThumbnail] = useState('');
  const fallbackFilePath = show.episodeFiles
    ?.slice()
    .sort((a, b) => a.season - b.season || a.episode - b.episode)[0]?.filePath;
  const imageSources = posterSources(show, undefined, fallbackThumbnail ? [fallbackThumbnail] : []);

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
    <Link
      to={`${routeBase}/${show.id}`}
      state={{ from, artwork: routeArtworkState(show, imageSources) }}
      className="loom-poster-link group block w-full max-w-[200px]"
    >
      <div className="loom-poster-frame relative aspect-[2/3] overflow-hidden rounded-lg transition-all duration-200">
        <SafeArtwork
          src={imageSources}
          alt={show.title}
          className="h-full w-full transition-transform group-hover:scale-105"
          imgClassName="object-cover"
          fallback={
          <div className="w-full h-full bg-[var(--loom-surface)] flex flex-col items-center justify-center gap-2 p-3">
            <Play className="w-8 h-8 text-[var(--loom-accent)] shrink-0" />
            <p className="text-[var(--loom-muted)] text-xs text-center leading-tight line-clamp-4">{show.title}</p>
          </div>
          }
        />
        <RatingBadge rating={show.rating} />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--loom-accent)] shadow-[0_0_0_6px_rgba(251,197,0,0.14)]">
            <Play className="w-6 h-6 text-[var(--loom-accent-foreground)] ml-1" />
          </div>
        </div>
      </div>
      <div className="mt-2">
        <h4 className="truncate text-sm font-semibold text-white">{show.title}</h4>
        <p className="text-xs text-[var(--loom-muted)]">
          {show.year > 0 ? `${show.year} · ` : ''}{availableSeasonCount(show)} {availableSeasonCount(show) === 1 ? 'Season' : 'Seasons'}
        </p>
      </div>
    </Link>
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
