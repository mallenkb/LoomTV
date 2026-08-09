import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Bookmark } from 'lucide-react';
import { useLibrary, type MediaItem } from '@/contexts/LibraryContext';
import { useProfiles } from '@/contexts/ProfileContext';
import LibraryPageLayout from '@/components/LibraryPageLayout';
import MediaPosterCard from '@/components/MediaPosterCard';
import StremioPosterCard from '@/components/StremioPosterCard';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import { mediaMetaLine } from '@/components/MediaPosterCard.helpers';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import { useProgressSnapshot } from '@/lib/progress';
import { createLibraryListState, matchesLibraryFilter, type LibraryFilter } from '@/lib/libraryFilters';
import {
  getCachedWatchedDiscoverItem,
  isLocalItemWatched,
  parseDiscoverWatchedKey,
} from '@/lib/watched';
import { cacheDiscoverReturnRoute, cacheExploreItem } from '@/lib/discoverNavigation';
import type { StremioPluginCatalogItem } from '@/lib/desktopApi';

export default function MyList() {
  const { state } = useLibrary();
  const { lists, watchedKeys } = useProfiles();
  const location = useLocation();
  const navigate = useNavigate();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('all');
  const progress = useProgressSnapshot();
  const listState = useMemo(() => createLibraryListState(lists), [lists]);
  const normalizedQuery = searchQuery(query);
  const savedItems = useMemo(() => {
    const byId = new Map([...state.movies, ...state.tvShows, ...state.animeShows].map((item) => [item.id, item]));
    const seen = new Set<string>();

    return lists
      .filter((entry) => entry.kind === 'watchlist' || entry.kind === 'favorite')
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((entry) => {
        if (seen.has(entry.mediaId)) return false;
        seen.add(entry.mediaId);
        return true;
      })
      .map((entry) => byId.get(entry.mediaId))
      .filter((item): item is MediaItem => Boolean(item));
  }, [lists, state.animeShows, state.movies, state.tvShows]);
  const filteredItems = useMemo(
    () => savedItems
      .filter((item) => matchesMediaItem(item, normalizedQuery))
      .filter((item) => matchesLibraryFilter(item, activeFilter, progress, listState)),
    [activeFilter, listState, normalizedQuery, progress, savedItems],
  );
  const watchedLocalItems = useMemo(() => {
    const allItems = [...state.movies, ...state.tvShows, ...state.animeShows];
    return allItems
      .filter((item) => isLocalItemWatched(item, watchedKeys) || matchesLibraryFilter(item, 'watched', progress))
      .filter((item) => matchesMediaItem(item, normalizedQuery));
  }, [normalizedQuery, progress, state.animeShows, state.movies, state.tvShows, watchedKeys]);
  const watchedDiscoverItems = useMemo(() => {
    const seen = new Set<string>();
    return lists
      .filter((entry) => entry.kind === 'watched' && entry.mediaId.startsWith('discover:'))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((entry) => {
        const parsed = parseDiscoverWatchedKey(entry.mediaId);
        const item = getCachedWatchedDiscoverItem(entry.mediaId);
        return parsed && item ? { entry, parsed, item } : null;
      })
      .filter((record): record is { entry: typeof lists[number]; parsed: NonNullable<ReturnType<typeof parseDiscoverWatchedKey>>; item: StremioPluginCatalogItem } => {
        if (!record || seen.has(record.entry.mediaId)) return false;
        seen.add(record.entry.mediaId);
        return !normalizedQuery || record.item.title.toLowerCase().includes(normalizedQuery);
      })
      .map((record) => record.item);
  }, [lists, normalizedQuery]);
  const watchedCount = watchedLocalItems.length + watchedDiscoverItems.length;
  const openDiscoverItem = (item: StremioPluginCatalogItem) => {
    const from = currentRoute;
    cacheDiscoverReturnRoute(from);
    cacheExploreItem(item);
    const detailPath = item.type === 'movie' ? `/movie/${item.id}` : item.type === 'anime' ? `/anime/${item.id}` : `/tv/${item.id}`;
    navigate(detailPath, { state: { from, stremioCatalogItem: item } });
  };

  return (
    <LibraryPageLayout
      title="My List"
      subtitle={savedItems.length > 0 || watchedCount > 0
        ? `${savedItems.length} saved · ${watchedCount} watched`
        : undefined}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search My List"
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
    >
      {state.isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-[300px] w-full max-w-[200px] animate-pulse rounded-lg bg-[var(--loom-surface)]" />
          ))}
        </div>
      ) : savedItems.length === 0 && watchedCount === 0 ? (
        <EmptyMyListState />
      ) : (
        <div className="space-y-10">
          {savedItems.length > 0 && (
            <section aria-labelledby="my-list-saved-heading" className="space-y-4">
              <h2 id="my-list-saved-heading" className="text-lg font-semibold text-[var(--loom-text)]">Saved</h2>
              {filteredItems.length > 0 ? (
                <VirtualPosterGrid
                  items={filteredItems}
                  renderItem={(item) => (
                    <MediaPosterCard
                      item={item}
                      from={currentRoute}
                      variant={item.type === 'movie' ? 'movies' : 'tv'}
                      metaLine={mediaMetaLine(item)}
                    />
                  )}
                />
              ) : (
                <div className="py-8 text-center text-sm text-[var(--loom-muted)]">
                  {activeFilter === 'all' ? 'No saved titles match your search' : 'No saved titles match this filter'}
                </div>
              )}
            </section>
          )}

          {watchedCount > 0 && (
            <section aria-labelledby="my-list-watched-heading" className="space-y-4">
              <h2 id="my-list-watched-heading" className="text-lg font-semibold text-[var(--loom-text)]">Watched</h2>
              {watchedLocalItems.length > 0 && (
                <VirtualPosterGrid
                  items={watchedLocalItems}
                  renderItem={(item) => (
                    <MediaPosterCard
                      item={item}
                      from={currentRoute}
                      variant={item.type === 'movie' ? 'movies' : 'tv'}
                      metaLine={mediaMetaLine(item)}
                    />
                  )}
                />
              )}
              {watchedDiscoverItems.length > 0 && (
                <VirtualPosterGrid
                  items={watchedDiscoverItems}
                  renderItem={(item) => (
                    <StremioPosterCard
                      item={item}
                      metaLine={item.releaseInfo || ''}
                      onSelect={openDiscoverItem}
                    />
                  )}
                />
              )}
            </section>
          )}
        </div>
      )}
    </LibraryPageLayout>
  );
}

function EmptyMyListState() {
  return (
    <div className="flex min-h-[calc(100vh-260px)] items-center justify-center px-4">
      <div className="w-full max-w-[520px] text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] bg-[var(--loom-panel)]">
          <Bookmark className="h-9 w-9 text-[var(--loom-accent)]" />
        </div>
        <h2 className="text-2xl font-semibold text-[var(--loom-text)]">Your list is empty</h2>
        <p className="mx-auto mt-3 max-w-[420px] text-sm leading-6 text-[var(--loom-muted)]">
          Use the bookmark button on a title to save it here.
        </p>
      </div>
    </div>
  );
}
