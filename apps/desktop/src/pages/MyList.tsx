import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from '@/lib/navigation';
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
  discoverWatchedKey,
} from '@/lib/watched';
import { cacheDiscoverReturnRoute, cacheExploreItem } from '@/lib/discoverNavigation';
import type { StremioPluginCatalogItem } from '@/lib/desktopApi';
import { EpisodeUpdatesProvider } from '@/contexts/EpisodeUpdatesContext';
import { useLibraryItemOrder } from '@/lib/libraryItemOrder';
import { useAddonBookmarks, type AddonBookmark } from '@/lib/addonBookmarks';
import { useAddonTitles } from '@/lib/addonTitles';
import { addonDetailRoute } from '@/lib/addonPlayback';
import { addonProgressKey, readAddonWatchHistory } from '@/lib/addonWatchHistory';

export default function MyList() {
  return <EpisodeUpdatesProvider><MyListContent /></EpisodeUpdatesProvider>;
}

function MyListContent() {
  const { state } = useLibrary();
  const { lists, watchedKeys, activeProfile } = useProfiles();
  const { bookmarks } = useAddonBookmarks();
  const addonTitles = useAddonTitles();
  const location = useLocation();
  const navigate = useNavigate();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('all');
  const progress = useProgressSnapshot();
  const orderItems = useLibraryItemOrder();
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
    () => orderItems(savedItems
      .filter((item) => matchesMediaItem(item, normalizedQuery))
      .filter((item) => matchesLibraryFilter(item, activeFilter, progress, listState))),
    [activeFilter, listState, normalizedQuery, orderItems, progress, savedItems],
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
  const addonHistory = activeProfile ? readAddonWatchHistory(activeProfile.id) : [];
  const savedCount = savedItems.length + bookmarks.length;
  const filteredBookmarks = bookmarks.filter(({ key, item }) => {
    if (normalizedQuery && !item.title.toLowerCase().includes(normalizedQuery)) return false;
    const watched = watchedKeys.has(discoverWatchedKey(item));
    switch (activeFilter) {
      case 'favorites': return listState.favoriteIds.has(key);
      case 'watched': return watched;
      case 'unwatched': return !watched;
      case 'in-progress': return addonHistory.some(({ target }) => {
        if (target.detailId !== item.id) return false;
        const stored = progress[addonProgressKey(target)];
        return stored && stored.position > 10 && !stored.watched && (stored.duration <= 0 || stored.position / stored.duration < 0.9);
      });
      case 'missing-artwork': return !item.posterUrl && !item.artwork?.poster;
      case 'missing-metadata': return !item.description;
      default: return true;
    }
  });
  const openBookmark = ({ item, addonId, streamAddonId }: AddonBookmark) => {
    cacheDiscoverReturnRoute(currentRoute);
    cacheExploreItem(item);
    navigate(addonDetailRoute(item), { state: { from: currentRoute, stremioCatalogItem: item, addonId, streamAddonId } });
  };
  const watchedCount = watchedLocalItems.length + watchedDiscoverItems.length;
  const [chosenTab, setChosenTab] = useState<'saved' | 'watched' | null>(null);
  // Open on whichever list has titles until the viewer picks one.
  const tab = chosenTab ?? (savedCount === 0 && watchedCount > 0 ? 'watched' : 'saved');
  const openDiscoverItem = (item: StremioPluginCatalogItem) => {
    const from = currentRoute;
    cacheDiscoverReturnRoute(from);
    cacheExploreItem(item);
    const detailPath = item.type === 'movie' ? `/movie/${item.id}` : item.type === 'anime' ? `/anime/${item.id}` : `/tv/${item.id}`;
    navigate(detailPath, { state: { from, stremioCatalogItem: item } });
  };

  const hasAnything = savedCount > 0 || watchedCount > 0;
  const tabs = (
    <div role="tablist" aria-label="My List" className="inline-flex gap-1 rounded-[var(--loom-control-radius,0.5rem)] bg-[var(--loom-surface-2)] p-1">
      {([['saved', 'Saved', savedCount], ['watched', 'Watched', watchedCount]] as const).map(([id, label, count]) => {
        const selected = tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`my-list-tab-${id}`}
            aria-selected={selected}
            aria-controls="my-list-panel"
            onClick={() => setChosenTab(id)}
            className={`loom-control-button flex h-8 items-center gap-2 rounded-[var(--loom-control-radius,0.5rem)] px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${selected ? 'bg-[var(--loom-text)] text-[var(--loom-bg)]' : 'text-[var(--loom-muted)] hover:text-[var(--loom-text)]'}`}
          >
            {label}
            <span className={`text-xs tabular-nums ${selected ? 'opacity-70' : 'text-[var(--loom-faint)]'}`}>{count.toLocaleString()}</span>
          </button>
        );
      })}
    </div>
  );

  const listResults = <>
{tab === 'saved' ? (
              savedCount === 0 ? (
                <p className="py-16 text-center text-sm text-[var(--loom-muted)]">Nothing saved yet. Use the bookmark button on a title to save it here.</p>
              ) : filteredItems.length > 0 || filteredBookmarks.length > 0 ? (
                <>
                {filteredItems.length > 0 && <VirtualPosterGrid
                  items={filteredItems}
                  renderItem={(item) => (
                    <MediaPosterCard
                      item={item}
                      from={currentRoute}
                      variant={item.type === 'movie' ? 'movies' : 'tv'}
                      metaLine={mediaMetaLine(item)}
                    />
                  )}
                />}
                {filteredBookmarks.length > 0 && <VirtualPosterGrid
                  items={filteredBookmarks.map(record => ({ ...record, id: record.key }))}
                  renderItem={(record) => (
                    <StremioPosterCard
                      item={record.item}
                      metaLine={[record.item.releaseInfo, (record.addonId && addonTitles[record.addonId]) || record.addonName || record.item.source].filter(Boolean).join(' · ')}
                      onSelect={() => openBookmark(record)}
                    />
                  )}
                />}
                </>
              ) : (
                <p className="py-16 text-center text-sm text-[var(--loom-muted)]">
                  {activeFilter === 'all' ? 'No saved titles match your search' : 'No saved titles match this filter'}
                </p>
              )
            ) : watchedCount === 0 ? (
              <p className="py-16 text-center text-sm text-[var(--loom-muted)]">{normalizedQuery ? 'No watched titles match your search' : 'Titles you finish show up here.'}</p>
            ) : (
              <>
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
              </>
            )}
  </>;

  return (
    <LibraryPageLayout
      title="My List"
      headerAction={!state.isLoading && hasAnything ? tabs : undefined}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search My List"
      searchResults={listResults}
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
    >
      {state.isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-[300px] w-full max-w-[200px] animate-pulse rounded-lg bg-[var(--loom-surface)]" />
          ))}
        </div>
      ) : savedCount === 0 && watchedCount === 0 ? (
        <EmptyMyListState />
      ) : (
        <>
          <div id="my-list-panel" role="tabpanel" aria-labelledby={`my-list-tab-${tab}`} className="space-y-6">
            {listResults}
          </div>
        </>
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
