import { useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { FolderPlus } from 'lucide-react';
import { libraryMutationMessage, useLibrary, MediaItem, TVShow } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import MediaPosterCard from '@/components/MediaPosterCard';
import { mediaMetaLine } from '@/components/MediaPosterCard.helpers';
import { useProgressSnapshot } from '@/lib/progress';
import { useProfiles } from '@/contexts/ProfileContext';
import { createLibraryListState, matchesLibraryFilter, type LibraryFilter } from '@/lib/libraryFilters';
import LibraryPageLayout from '@/components/LibraryPageLayout';

export default function Others() {
  const { state, addLibraryFolder } = useLibrary();
  const { isLoading, libraryFolderGroups } = state;
  const { lists } = useProfiles();
  const othersFolders = useMemo(() => libraryFolderGroups.others || [], [libraryFolderGroups.others]);
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('all');
  const [libraryActionError, setLibraryActionError] = useState('');
  const progress = useProgressSnapshot();
  const listState = useMemo(() => createLibraryListState(lists), [lists]);
  const normalizedQuery = searchQuery(query);
  const items = useMemo(
    () => otherFolderItems([...state.movies, ...state.tvShows, ...state.animeShows], othersFolders),
    [othersFolders, state.animeShows, state.movies, state.tvShows],
  );
  const filteredItems = useMemo(
    () => items
      .filter((item) => matchesMediaItem(item, normalizedQuery))
      .filter((item) => matchesLibraryFilter(item, activeFilter, progress, listState)),
    [activeFilter, items, listState, normalizedQuery, progress],
  );
  const handleAddFolder = async () => {
    setLibraryActionError('');
    try {
      await addLibraryFolder('others');
    } catch (error) {
      setLibraryActionError(libraryMutationMessage(error));
    }
  };

  return (
    <LibraryPageLayout
      title="Others"
      subtitle={othersFolders.length > 0
        ? `${othersFolders.length} custom ${othersFolders.length === 1 ? 'folder' : 'folders'}`
        : undefined}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search custom folders"
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
    >
        {isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-[300px] w-full max-w-[200px] rounded-lg" />
            ))}
          </div>
        ) : othersFolders.length === 0 ? (
          <EmptyOthersState error={libraryActionError} onAddFolder={handleAddFolder} />
        ) : (
          <>
            <VirtualPosterGrid
              items={filteredItems}
              renderItem={(item) => (
                <MediaPosterCard item={item} from={currentRoute} variant="others" metaLine={mediaMetaLine(item)} />
              )}
            />
            {items.length === 0 && (
              <div className="py-12 text-center text-[var(--loom-muted)]">
                No media found in your Others folders yet.
              </div>
            )}
            {items.length > 0 && filteredItems.length === 0 && (
              <div className="py-12 text-center text-[var(--loom-muted)]">
                {activeFilter === 'all' ? 'No local matches found' : 'No custom-folder titles match this filter'}
              </div>
            )}
          </>
        )}
    </LibraryPageLayout>
  );
}

function EmptyOthersState({ error, onAddFolder }: { error?: string; onAddFolder: () => Promise<void> }) {
  return (
    <div className="flex min-h-[calc(100vh-260px)] items-center justify-center px-4">
      <div className="w-full max-w-[520px] text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] bg-[var(--loom-panel)]">
          <FolderPlus className="h-9 w-9 text-[var(--loom-accent)]" />
        </div>
        <h3 className="text-2xl font-semibold text-white">Add an Others folder</h3>
        <p className="mx-auto mt-3 max-w-[420px] text-sm leading-6 text-[var(--loom-muted)]">
          Use Others for mixed folders. LoomTV will scan the files and sort detected movies, TV shows, and anime automatically.
        </p>
        {error ? <p role="alert" className="mt-4 text-sm text-red-200">{error}</p> : null}
        <Button onClick={onAddFolder} className="mt-8 h-12 gap-2 px-5">
          <FolderPlus className="h-4 w-4" />
          Add Others Folder
        </Button>
      </div>
    </div>
  );
}

function otherFolderItems(items: MediaItem[], folders: string[]): MediaItem[] {
  const normalizedFolders = folders.map(normalizePathPrefix).filter(Boolean);
  if (normalizedFolders.length === 0) return [];
  return items.filter((item) => itemBelongsToFolders(item, normalizedFolders));
}

function itemBelongsToFolders(item: MediaItem, folders: string[]): boolean {
  if (item.type === 'movie') return pathBelongsToFolders(item.filePath, folders);
  const episodeFiles = (item as TVShow).episodeFiles || [];
  // Loose episode-looking files in a mixed root are retained as playable
  // catalog items even when no series structure could be formed. Fall back to
  // the item's own path so Others never hides a file the scanner indexed.
  return episodeFiles.length > 0
    ? episodeFiles.some((file) => pathBelongsToFolders(file.filePath, folders))
    : pathBelongsToFolders(item.filePath, folders);
}

function pathBelongsToFolders(filePath: string | undefined, folders: string[]): boolean {
  const normalizedPath = normalizePathPrefix(filePath || '');
  return folders.some((folder) => normalizedPath === folder || normalizedPath.startsWith(`${folder}/`));
}

function normalizePathPrefix(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}
