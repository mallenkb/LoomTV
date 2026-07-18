import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { FolderPlus, Tv } from 'lucide-react';
import { useLibrary } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import LibrarySearch from '@/components/LibrarySearch';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import { useProgressSnapshot } from '@/lib/progress';
import { matchesLibraryFilter, type LibraryFilter } from '@/lib/libraryFilters';
import LibraryFilterBar from '@/components/LibraryFilterBar';
import MediaPosterCard from '@/components/MediaPosterCard';
import { availableSeasonCount } from '@/components/MediaPosterCard.helpers';

interface TVShowsProps {
  kind?: 'series' | 'anime';
}

export default function TVShows({ kind = 'series' }: TVShowsProps) {
  const { state, addLibraryFolder } = useLibrary();
  const { isLoading, isScanning } = state;
  const tvShows = kind === 'anime' ? state.animeShows : state.tvShows;
  const title = kind === 'anime' ? 'anime' : 'TV shows';
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('all');
  const progress = useProgressSnapshot();
  const normalizedQuery = searchQuery(query);
  const filteredShows = useMemo(() => tvShows
    .filter((item) => matchesMediaItem(item, normalizedQuery))
    .filter((item) => matchesLibraryFilter(item, activeFilter, progress)), [activeFilter, normalizedQuery, progress, tvShows]);

  return (
    <div className="loom-page h-full overflow-y-auto">
      <LibrarySearch
        value={query}
        onChange={setQuery}
        placeholder={kind === 'anime' ? 'Search anime' : 'Search tv shows'}
        rightSlot={<LibraryFilterBar activeFilter={activeFilter} onChange={setActiveFilter} />}
      />
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6 pt-24">
        {isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-[300px] w-full max-w-[200px] rounded-lg" />
            ))}
          </div>
        ) : (
          <VirtualPosterGrid
            items={filteredShows}
            renderItem={(item) => {
              const seasonCount = availableSeasonCount(item);
              const metaLine = `${item.year > 0 ? `${item.year} · ` : ''}${seasonCount} ${seasonCount === 1 ? 'Season' : 'Seasons'}`;
              return <MediaPosterCard item={item} from={currentRoute} variant="tv" metaLine={metaLine} />;
            }}
          />
        )}
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
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] bg-[var(--loom-panel)]">
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
