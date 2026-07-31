import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Film } from 'lucide-react';
import { useLibrary } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import { useProgressSnapshot } from '@/lib/progress';
import { matchesLibraryFilter, type LibraryFilter } from '@/lib/libraryFilters';
import LibraryPageLayout from '@/components/LibraryPageLayout';
import MediaPosterCard from '@/components/MediaPosterCard';

export default function Movies() {
  const { state, addLibraryFolder } = useLibrary();
  const { movies, isLoading, isScanning } = state;
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('all');
  const progress = useProgressSnapshot();
  const normalizedQuery = searchQuery(query);
  const filteredMovies = useMemo(() => movies
    .filter((item) => matchesMediaItem(item, normalizedQuery))
    .filter((item) => matchesLibraryFilter(item, activeFilter, progress)), [activeFilter, movies, normalizedQuery, progress]);

  return (
    <LibraryPageLayout
      title="Movies"
      query={query}
      onQueryChange={setQuery}
      placeholder="Search movies"
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
    >
        {isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-[300px] w-full max-w-[200px] rounded-lg" />
            ))}
          </div>
        ) : (
          <VirtualPosterGrid
            items={filteredMovies}
            renderItem={(item) => (
              <MediaPosterCard
                item={item}
                from={currentRoute}
                variant="movies"
                metaLine={item.year > 0 ? String(item.year) : ''}
              />
            )}
          />
        )}
        {movies.length === 0 && !isLoading && (
          <EmptyMoviesState isScanning={isScanning} onAddFolder={() => addLibraryFolder('movies')} />
        )}
        {movies.length > 0 && filteredMovies.length === 0 && !isLoading && (
          <div className="py-12 text-center text-[var(--loom-muted)]">
            {activeFilter === 'all' ? 'No local matches found' : 'No movies match this filter'}
          </div>
        )}
    </LibraryPageLayout>
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
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] bg-[var(--loom-panel)]">
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
