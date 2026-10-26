import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLibrary, type MediaItem } from '@/contexts/LibraryContext';
import { useLocation } from '@/lib/navigation';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import type { PageSearchFilter } from '@/lib/pageSearch';
import { mediaMetaLine } from '@/components/MediaPosterCard.helpers';
import MediaPosterCard from '@/components/MediaPosterCard';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import { SearchPaletteFrame } from '@/components/SearchPaletteFrame';
import SearchFilterTabs from '@/components/SearchFilterTabs';

const FILTERS = [
  { value: 'all', label: 'All' }, { value: 'movie', label: 'Movies' },
  { value: 'tv', label: 'Series' }, { value: 'anime', label: 'Anime' },
] as const;
type Filter = typeof FILTERS[number]['value'];

export default function LocalTitleSearch({ open, onOpenChange, query, onQueryChange, items, title = 'Search your library', initialFilter = 'all' }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  query: string; onQueryChange: (query: string) => void;
  items?: readonly MediaItem[]; title?: string; initialFilter?: PageSearchFilter;
}) {
  const { state } = useLibrary();
  const location = useLocation();
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsId = useId();
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = searchQuery(deferredQuery);
  const sourceItems = useMemo(() => items ?? [...state.movies, ...state.tvShows, ...state.animeShows],
    [items, state.movies, state.tvShows, state.animeShows]);
  const results = useMemo(() => open && normalizedQuery ? sourceItems.filter(item =>
    (filter === 'all' || item.type === filter) && matchesMediaItem(item, normalizedQuery)) : [],
  [open, normalizedQuery, sourceItems, filter]);
  const from = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
  }, [deferredQuery, filter]);

  return <SearchPaletteFrame wide open={open} onOpenChange={onOpenChange} title={title}
    description="Search your local movies, series, and anime. Use the arrow keys to navigate results."
    query={query} onQueryChange={onQueryChange} controls={resultsId} inputRef={inputRef}
    onKeyDown={event => {
      const first = resultsRef.current?.querySelector<HTMLAnchorElement>('a[href]');
      if (!first) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); first.focus(); }
      if (event.key === 'Enter') { event.preventDefault(); first.click(); }
    }}>
    <SearchFilterTabs items={FILTERS} value={filter} onChange={setFilter} />
    <div ref={resultsRef} id={resultsId} className="min-h-0 overflow-y-auto overscroll-contain p-5"
      aria-busy={query !== deferredQuery || state.isLoading}
      onClick={event => { if ((event.target as Element).closest('a[href]')) onOpenChange(false); }}>
      {!normalizedQuery ? <p role="status" className="px-3 py-6 text-center text-sm text-[var(--loom-muted)]">Type a title to search.</p>
        : results.length ? <VirtualPosterGrid items={results} keyboardNavigation onExitTop={() => inputRef.current?.focus()}
          renderItem={item => <MediaPosterCard item={item} from={from} variant="movies" metaLine={mediaMetaLine(item)} />} />
          : <p role="status" className="px-3 py-6 text-center text-sm text-[var(--loom-muted)]">{state.isLoading ? 'Loading your library...' : 'No local matches found.'}</p>}
    </div>
    <div className="shrink-0 border-t border-[var(--loom-border)] px-5 py-2 text-xs text-[var(--loom-muted)]">Arrow keys navigate · Return opens · Esc closes</div>
  </SearchPaletteFrame>;
}
