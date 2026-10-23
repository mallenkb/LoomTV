import { useEffect, useRef, useState } from 'react';
import StremioPosterCard from '@/components/StremioPosterCard';
import { SearchPaletteFrame } from '@/pages/SettingsSearch';
import { cachedCinemetaCatalog, cinemetaCatalog } from '@/pages/PluginDiscover/cinemeta';
import type { StremioPluginCatalogItem } from '@/lib/desktopApi';
import { PosterGridShimmer } from '@/components/ContentShimmer';
import { enrichWithCinemeta } from '@/lib/cinemetaAddonMetadata';

type SearchFilter = 'all' | 'movie' | 'tv' | 'anime';
type SearchSnapshot = { query: string; items: StremioPluginCatalogItem[]; visibleCount: number; active: number; scrollTop: number; types: string; filter?: SearchFilter };
const savedSearches = new Map<string, SearchSnapshot>();
export function savedAddonSearch(key: string) { return savedSearches.get(key); }

export default function AddonTitleSearch({ open, onOpenChange, types, onSelect, restoreKey, initialFilter = 'all' }: {
  restoreKey: string; initialFilter?: SearchFilter;
  open: boolean; onOpenChange: (open: boolean) => void; types: readonly ('movie' | 'tv' | 'anime')[];
  onSelect: (item: StremioPluginCatalogItem) => void;
}) {
  const [restored] = useState(() => savedAddonSearch(restoreKey));
  const [filter, setFilter] = useState<SearchFilter>(restored?.filter || initialFilter);
  const restorePending = useRef(Boolean(restored));
  const [query, setQuery] = useState(restored?.query || '');
  const [items, setItems] = useState<StremioPluginCatalogItem[]>(restored?.items || []);
  const [visibleCount, setVisibleCount] = useState(restored?.visibleCount || 10);
  const [metadata, setMetadata] = useState<Record<string, StremioPluginCatalogItem>>({});
  const [metadataPending, setMetadataPending] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(restored?.active || 0);
  const [columns, setColumns] = useState(5);
  const list = useRef<HTMLDivElement>(null);
  const metadataDone = useRef(new Set<string>());
  const selectedFilter = filter === 'all' || types.includes(filter) ? filter : 'all';
  const typeKey = selectedFilter === 'all' ? types.join(',') : selectedFilter;
  useEffect(() => {
    let current = true;
    if (restorePending.current && restored && open) {
      restorePending.current = false;
      if (list.current) list.current.scrollTop = restored.scrollTop;
      return;
    }
    metadataDone.current.clear();
    setItems([]); setActive(0); setFailed(false); setVisibleCount(10); setMetadata({});
    if (!open || !query.trim()) { setPending(0); return; }
    const requested = typeKey.split(',') as ('movie' | 'tv' | 'anime')[];
    setItems(requested.flatMap(type => type === 'anime' ? [] : cachedCinemetaCatalog(type, 'popular', query.trim(), '', '') || []));
    setPending(requested.length);
    const timer = window.setTimeout(() => {
      for (const type of requested) {
        const request = type === 'anime' ? import('@/pages/PluginDiscover').then(module => module.discoverAnime(query.trim(), 'popular')) : cinemetaCatalog(type, 'popular', query.trim(), '', '');
        void request.then(result => { if (current) setItems(previous => [...previous, ...result.slice(0, 30)].filter((item, index, all) => all.findIndex(other => other.id === item.id && other.type === item.type) === index)); })
          .catch(() => { if (current) setFailed(true); })
          .finally(() => { if (current) setPending(value => value - 1); });
      }
    }, 150);
    return () => { current = false; window.clearTimeout(timer); };
  }, [open, query, typeKey, restored, restored?.scrollTop]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  useEffect(() => { if (restored && list.current) list.current.scrollTop = restored.scrollTop; }, [restored]);
  useEffect(() => {
    if (!open || !list.current) return;
    const element = list.current;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth - 40;
      setColumns(Math.max(1, Math.min(5, Math.floor((width + 24) / 184))));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);
  // Posters appear immediately; enrich only the displayed batch, with at most
  // three metadata requests at once. The shared Cinemeta cache deduplicates reads.
  useEffect(() => {
    let current = true;
    const candidates = items.slice(0, visibleCount).filter(item => !item.providerRatings?.imdb && item.imdbId && !metadataDone.current.has(`${item.type}:${item.id}`));
    setMetadataPending(new Set(candidates.map(item => `${item.type}:${item.id}`)));
    let next = 0;
    const worker = async () => {
      while (current && next < candidates.length) {
        const item = candidates[next++];
        const key = `${item.type}:${item.id}`;
        const enriched = await enrichWithCinemeta(item, partial => {
          if (current) setMetadata(previous => ({ ...previous, [key]: partial }));
        });
        if (!current) return;
        metadataDone.current.add(key);
        setMetadata(previous => ({ ...previous, [key]: enriched }));
        setMetadataPending(previous => { const remaining = new Set(previous); remaining.delete(key); return remaining; });
      }
    };
    for (let index = 0; index < Math.min(3, candidates.length); index++) void worker();
    return () => { current = false; };
  }, [items, visibleCount]);
  const visibleItems = items.slice(0, visibleCount).map(item => metadata[`${item.type}:${item.id}`] || item);
  const choose = (item: StremioPluginCatalogItem | undefined) => {
    if (!item) return;
    savedSearches.set(restoreKey, { query, items: items.map(value => metadata[`${value.type}:${value.id}`] || value), visibleCount, active, scrollTop: list.current?.scrollTop || 0, types: types.join(','), filter: selectedFilter });
    while (savedSearches.size > 12) {
      const oldestKey = savedSearches.keys().next().value;
      if (oldestKey === undefined) break;
      savedSearches.delete(oldestKey);
    }
    onOpenChange(false);
    onSelect(item);
  };
  const changeOpen = (value: boolean) => {
    if (!value) savedSearches.delete(restoreKey);
    onOpenChange(value);
  };
  const rows = Array.from({ length: Math.ceil(visibleItems.length / columns) }, (_, row) => visibleItems.slice(row * columns, (row + 1) * columns));
  return <SearchPaletteFrame wide popupRole="grid" open={open} onOpenChange={changeOpen} title="Search titles" description="Search movies, series, and anime. Use the arrow keys and Return to open a title." query={query} onQueryChange={setQuery} controls="addon-search-results" activeDescendant={visibleItems[active] ? `addon-search-${active}` : undefined}
    onKeyDown={event => {
      const delta = { ArrowDown: columns, ArrowUp: -columns, ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (delta !== undefined && visibleItems.length) {
        event.preventDefault();
        setActive(value => Math.max(0, Math.min(visibleItems.length - 1, value + delta)));
      } else if (event.key === 'Enter') { event.preventDefault(); choose(visibleItems[active]); }
    }}>
    <div role="group" aria-label="Filter search by type" className="flex shrink-0 gap-1 border-b border-[var(--loom-border)] px-5 py-2">
      {(['all', ...types] as SearchFilter[]).map(value => <button key={value} type="button"
        aria-pressed={selectedFilter === value}
        onClick={() => { setFilter(value); if (list.current) list.current.scrollTop = 0; }}
        className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${selectedFilter === value ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)]'}`}>
        {{ all: 'All', movie: 'Movies', tv: 'Series', anime: 'Anime' }[value]}
      </button>)}
    </div>
    <div ref={list} onScroll={event => {
      const element = event.currentTarget;
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 160) setVisibleCount(count => Math.min(items.length, count + 10));
    }} className="max-h-[min(560px,calc(80dvh-140px))] overflow-y-auto overscroll-contain p-5">
      {items.length > 0 ? <div id="addon-search-results" role="grid" aria-label="Titles" aria-colcount={columns} className="space-y-7">
        {rows.map((row, rowIndex) => <div key={rowIndex} role="row" className="grid gap-6" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {row.map((item, column) => {
            const index = rowIndex * columns + column;
            const seasons = item.seasonCount;
            const metaLine = [item.releaseInfo, seasons ? `${seasons} ${seasons === 1 ? 'Season' : 'Seasons'}` : item.type === 'movie' ? 'Movie' : item.type === 'anime' ? 'Anime' : 'TV series'].filter(Boolean).join(' · ');
            return <div key={`${item.type}:${item.id}`} id={`addon-search-${index}`} data-index={index} role="gridcell" aria-selected={index === active}
              onMouseMove={() => setActive(index)} onFocus={() => setActive(index)}
              className={`min-w-0 [&_h4]:line-clamp-2 [&_h4]:whitespace-normal ${index === active ? '[&_.loom-poster-frame]:ring-2 [&_.loom-poster-frame]:ring-[var(--loom-accent)] [&_.loom-poster-frame]:ring-offset-2 [&_.loom-poster-frame]:ring-offset-[var(--loom-panel)]' : ''}`}>
              <StremioPosterCard item={item} metaLine={metaLine} onSelect={choose} metadataPending={metadataPending.has(`${item.type}:${item.id}`)} />
            </div>;
          })}
        </div>)}
      </div> : pending ? <div id="addon-search-results"><PosterGridShimmer count={columns} className="grid-cols-[repeat(auto-fit,minmax(140px,1fr))]" /></div> : <p id="addon-search-results" role="status" className="px-3 py-6 text-center text-sm text-[var(--loom-muted)]">{!query.trim() ? 'Type a title to search.' : pending ? 'Searching titles...' : failed ? 'Search could not be completed. Try another search.' : 'No titles found.'}</p>}
      {items.length > 0 && pending > 0 && <PosterGridShimmer count={columns} className="mt-7 grid-cols-[repeat(auto-fit,minmax(140px,1fr))]" />}
      {visibleCount < items.length && <button type="button" onClick={() => setVisibleCount(count => count + 10)} className="mt-5 w-full rounded-lg py-2 text-sm text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)]">Load more titles</button>}
    </div>
    <div className="border-t border-[var(--loom-border)] px-5 py-2 text-xs text-[var(--loom-muted)]">Arrow keys navigate · Return opens · Esc closes{pending && items.length ? ' · Searching...' : ''}</div>
  </SearchPaletteFrame>;
}
