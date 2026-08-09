import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Compass } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { useTheme } from '@/components/ThemeProvider';
import { useProfiles } from '@/contexts/ProfileContext';
import LibrarySearch from '@/components/LibrarySearch';
import StremioPosterCard from '@/components/StremioPosterCard';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import {
  desktopApi,
  type StremioPluginCatalogDefinition,
  type StremioPluginCatalogItem,
  type StremioPluginSummary,
} from '@/lib/desktopApi';
import { cacheDiscoverReturnRoute } from '@/lib/discoverNavigation';

const PROVIDER_SEARCH_DEBOUNCE_MS = 450;
const DISCOVER_CACHE_STORAGE_KEY = 'loomtv:discover-cache-v3';
const DISCOVER_VIEW_STATE_STORAGE_KEY = 'loomtv:discover-view-state-v1';
const DISCOVER_ROUTE = '/discover';

type DiscoverType = 'movie' | 'tv' | 'anime';
type DiscoverSection = 'trending' | 'popular' | 'top_rated' | 'new';
type GenreOption = { label: string; value: string };
type GridEntry = { id: string; item: StremioPluginCatalogItem };
type CachedDiscoverItem = { expiresAt: number; items: StremioPluginCatalogItem[] };
type DiscoverCacheState = { date: string; entries: Record<string, CachedDiscoverItem> };
type ParsedDiscoverFilterState = {
  contentType: DiscoverType;
  section: DiscoverSection;
  genreFilter: string;
  yearFilter: string;
  query: string;
};
type CatalogSelection = {
  plugin: StremioPluginSummary;
  catalog: StremioPluginCatalogDefinition;
};

const DISCOVER_SECTIONS: Record<DiscoverType, readonly DiscoverSection[]> = {
  movie: ['trending', 'popular', 'top_rated', 'new'],
  tv: ['trending', 'popular', 'top_rated', 'new'],
  anime: ['trending', 'popular', 'top_rated', 'new'],
};

const DISCOVER_SECTION_LABELS: Record<DiscoverSection, string> = {
  trending: 'Trending',
  popular: 'Popular',
  top_rated: 'Top Rated',
  new: 'Latest',
};

const DISCOVER_TYPE_LABELS: Record<DiscoverType, string> = {
  movie: 'Movies',
  tv: 'TV Shows',
  anime: 'Anime',
};

const SECTION_ALIASES: Record<DiscoverSection, readonly string[]> = {
  trending: ['trending', 'trending-day', 'trending-week'],
  popular: ['popular', 'most-popular'],
  top_rated: ['top', 'top-rated', 'top_rated', 'toprated'],
  new: ['new', 'latest', 'upcoming', 'on-the-air', 'on_the_air'],
};

function parseDiscoverFilterState(search: string): ParsedDiscoverFilterState {
  const params = new URLSearchParams(search);
  const contentTypeParam = params.get('type');
  const sectionParam = params.get('section');
  return {
    contentType: contentTypeParam === 'movie' || contentTypeParam === 'tv' || contentTypeParam === 'anime'
      ? contentTypeParam
      : 'movie',
    section: sectionParam === 'trending' || sectionParam === 'popular' || sectionParam === 'top_rated' || sectionParam === 'new'
      ? sectionParam
      : 'trending',
    genreFilter: params.get('genre') || '',
    yearFilter: params.get('year') || '',
    query: params.get('q') || '',
  };
}

function buildDiscoverSearch(state: ParsedDiscoverFilterState): string {
  const params = new URLSearchParams();
  if (state.contentType !== 'movie') params.set('type', state.contentType);
  if (state.section !== 'trending') params.set('section', state.section);
  if (state.genreFilter.trim()) params.set('genre', state.genreFilter.trim());
  if (state.yearFilter.trim()) params.set('year', state.yearFilter.trim());
  if (state.query.trim()) params.set('q', state.query.trim());
  return params.toString();
}

function providerUiType(value: string): DiscoverType | null {
  if (value === 'movie') return 'movie';
  if (value === 'series' || value === 'tv') return 'tv';
  if (value === 'anime') return 'anime';
  return null;
}

function normalizedToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function catalogMatchesSection(catalog: StremioPluginCatalogDefinition, section: DiscoverSection): boolean {
  const aliases = SECTION_ALIASES[section];
  const id = normalizedToken(catalog.id);
  const name = normalizedToken(catalog.name);
  return aliases.some((alias) => id === alias || name === alias || name.includes(alias));
}

function catalogForSection(
  plugins: readonly StremioPluginSummary[],
  contentType: DiscoverType,
  section: DiscoverSection,
): CatalogSelection | null {
  for (const plugin of plugins) {
    for (const catalog of plugin.catalogs) {
      if (providerUiType(catalog.type) !== contentType) continue;
      if (catalogMatchesSection(catalog, section)) return { plugin, catalog };
    }
  }
  return null;
}

function providerCatalogSupports(catalog: StremioPluginCatalogDefinition, name: string): boolean {
  return catalog.extra.some((extra) => extra.name.trim().toLowerCase() === name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The provider request failed.';
}

function toLocalDateKey(date = new Date()): string {
  return date.getFullYear()
    + '-' + String(date.getMonth() + 1).padStart(2, '0')
    + '-' + String(date.getDate()).padStart(2, '0');
}

function nextMidnightAt(date = new Date()): number {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

function parseYearFromItem(item: StremioPluginCatalogItem): number {
  for (const value of [item.releaseInfo, item.released].filter(Boolean)) {
    const match = String(value).match(/(19\d{2}|20\d{2})/);
    if (match) return Number(match[0]);
  }
  return 0;
}

function stremioMetaLine(item: StremioPluginCatalogItem): string {
  const year = parseYearFromItem(item);
  return [year > 0 ? String(year) : item.releaseInfo || item.released || '', item.runtime]
    .filter(Boolean)
    .join(' · ');
}

function toYearFilterOptions(items: readonly StremioPluginCatalogItem[]): string[] {
  const years = new Set<number>();
  for (const item of items) {
    const year = parseYearFromItem(item);
    if (year > 0) years.add(year);
  }
  return [...years].sort((left, right) => right - left).map(String);
}

function normalizeGenreFilter(value: string): string {
  return value.trim().toLowerCase();
}

function hasGenreMatch(item: StremioPluginCatalogItem, genreValue: string): boolean {
  const normalizedGenre = normalizeGenreFilter(genreValue);
  return !normalizedGenre || item.genres.some((genre) => {
    const normalized = normalizeGenreFilter(genre);
    return normalized === normalizedGenre || normalized.includes(normalizedGenre);
  });
}

function hasYearMatch(item: StremioPluginCatalogItem, yearFilter: string): boolean {
  const normalizedYear = Number(yearFilter);
  return !Number.isFinite(normalizedYear) || normalizedYear <= 0 || parseYearFromItem(item) === normalizedYear;
}

function genreOptionsFrom(
  catalog: StremioPluginCatalogDefinition | null,
  items: readonly StremioPluginCatalogItem[],
): GenreOption[] {
  const definition = catalog?.extra.find((extra) => extra.name.trim().toLowerCase() === 'genre');
  const values = definition?.options?.length
    ? definition.options
    : [...new Set(items.flatMap((item) => item.genres))];
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => ({ label: value, value: normalizeGenreFilter(value) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function makeCacheId(
  selection: CatalogSelection | null,
  section: DiscoverSection,
  query: string,
  genre: string,
  year: string,
): string {
  const addon = selection?.plugin.addonId || 'none';
  const catalog = selection?.catalog.id || 'none';
  return [addon, catalog, section, query.trim().toLowerCase(), genre.trim().toLowerCase(), year.trim()].join(':');
}

function loadDiscoverCacheFromStorage(): DiscoverCacheState {
  const empty: DiscoverCacheState = { date: toLocalDateKey(), entries: {} };
  try {
    const raw = sessionStorage.getItem(DISCOVER_CACHE_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as DiscoverCacheState;
    if (!parsed || parsed.date !== toLocalDateKey() || !parsed.entries || typeof parsed.entries !== 'object') return empty;
    return {
      date: parsed.date,
      entries: Object.fromEntries(Object.entries(parsed.entries).filter(([, entry]) => (
        typeof entry?.expiresAt === 'number' && Array.isArray(entry.items)
      ))),
    };
  } catch {
    return empty;
  }
}

function insertShimmerStyle() {
  if (typeof document === 'undefined' || document.getElementById('loom-discover-shimmer-style')) return;
  const style = document.createElement('style');
  style.id = 'loom-discover-shimmer-style';
  style.textContent = [
    '@keyframes discover-shimmer-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }',
    '.discover-shimmer-wave { background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 40%, rgba(255,255,255,0.22) 50%, rgba(255,255,255,0.08) 60%, transparent 100%); animation: discover-shimmer-slide 1.5s linear infinite; }',
  ].join('\n');
  document.head.appendChild(style);
}

function DiscoverShimmerCard() {
  return (
    <div className="loom-poster-link block w-full max-w-[200px] [contain-intrinsic-size:200px_340px] [content-visibility:auto]">
      <div className="loom-poster-frame relative aspect-[2/3] overflow-hidden rounded-lg">
        <div className="relative h-full w-full overflow-hidden bg-[var(--loom-surface)]">
          <span className="discover-shimmer-wave pointer-events-none absolute inset-0 block" />
        </div>
      </div>
      <div className="mt-2 space-y-2">
        <div className="relative h-4 w-4/5 overflow-hidden !rounded-none bg-[var(--loom-surface)]">
          <span className="discover-shimmer-wave pointer-events-none absolute inset-0 block" />
        </div>
        <div className="relative h-3 w-1/2 overflow-hidden !rounded-none bg-[var(--loom-surface)]">
          <span className="discover-shimmer-wave pointer-events-none absolute inset-0 block" />
        </div>
      </div>
    </div>
  );
}

type ThemeDropdownOption = { value: string; label: string };

function ThemeDropdown({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ThemeDropdownOption[];
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{ left: number; top: number; width: number } | null>(null);
  const selectedLabel = useMemo(
    () => options.find((option) => option.value === value)?.label || options[0]?.label || 'Select',
    [options, value],
  );

  const computeMenuStyle = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setMenuStyle({ left: rect.left, top: rect.bottom + 6, width: rect.width });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    computeMenuStyle();
    const reposition = () => computeMenuStyle();
    const outside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [computeMenuStyle, isOpen]);

  return (
    <div ref={containerRef} className="relative text-sm">
      <button
        type="button"
        id={id}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        ref={buttonRef}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setIsOpen(false);
          if (['ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            setIsOpen(true);
          }
        }}
        className="relative z-10 inline-flex h-8 min-w-[9rem] items-center rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 pr-10 text-sm font-normal text-[var(--loom-text)] outline-none transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)]"
      >
        <span className="truncate whitespace-nowrap">{selectedLabel}</span>
        <ChevronDown className={'pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)] transition-transform ' + (isOpen ? 'rotate-180' : '')} />
      </button>
      {isOpen && menuStyle ? createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          className="fixed z-[9999] mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-1 text-[var(--loom-text)] shadow-[0_18px_40px_rgba(0,0,0,0.30)]"
          style={{ left: menuStyle.left, top: menuStyle.top, width: menuStyle.width }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => { onChange(option.value); setIsOpen(false); }}
              className={'relative z-10 flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ' + (option.value === value
                ? 'bg-[var(--loom-active-bg)] text-[var(--loom-text)]'
                : 'text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]')}
            >
              {option.label}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default function PluginDiscover() {
  const { theme } = useTheme();
  const { activeProfile } = useProfiles();
  const location = useLocation();
  const navigate = useNavigate();
  const initialFilterState = useMemo(() => parseDiscoverFilterState(location.search), [location.search]);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [plugins, setPlugins] = useState<StremioPluginSummary[]>([]);
  const [query, setQuery] = useState(initialFilterState.query);
  const [contentType, setContentType] = useState<DiscoverType>(initialFilterState.contentType);
  const [section, setSection] = useState<DiscoverSection>(initialFilterState.section);
  const [genreFilter, setGenreFilter] = useState(initialFilterState.genreFilter);
  const [genreOptions, setGenreOptions] = useState<GenreOption[]>([]);
  const [yearFilter, setYearFilter] = useState(initialFilterState.yearFilter);
  const [yearOptions, setYearOptions] = useState<string[]>([]);
  const [items, setItems] = useState<readonly StremioPluginCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const catalogRequestRevision = useRef(0);
  const searchTimer = useRef<number | null>(null);
  const queryRef = useRef('');
  const genreRef = useRef('');
  const yearRef = useRef('');
  const detailsCache = useRef(new Map<string, Promise<StremioPluginCatalogItem>>());
  const discoverCache = useRef<DiscoverCacheState>(loadDiscoverCacheFromStorage());
  const currentSearch = location.search.startsWith('?') ? location.search.slice(1) : location.search;
  const isModern = theme.homeStyle === 'modern';
  const frameClass = isModern ? 'loom-modern-content-frame' : 'loom-frame';
  const topPaddingClass = isModern ? 'pt-28' : 'pt-24';

  const availableSections = useMemo(() => {
    if (plugins.length === 0) return [...DISCOVER_SECTIONS[contentType]];
    const supported = DISCOVER_SECTIONS[contentType].filter((candidate) => Boolean(catalogForSection(plugins, contentType, candidate)));
    return supported;
  }, [contentType, plugins]);

  const catalogSelection = useMemo(
    () => catalogForSection(plugins, contentType, section),
    [contentType, plugins, section],
  );

  const supportsSearch = Boolean(catalogSelection && providerCatalogSupports(catalogSelection.catalog, 'search'));
  const supportsGenre = Boolean(catalogSelection && providerCatalogSupports(catalogSelection.catalog, 'genre'));
  const supportsYear = Boolean(catalogSelection && providerCatalogSupports(catalogSelection.catalog, 'year'));

  useEffect(() => {
    const nextSearch = buildDiscoverSearch({ contentType, section, genreFilter, yearFilter, query });
    if (nextSearch === currentSearch) return;
    void navigate({ pathname: DISCOVER_ROUTE, search: nextSearch ? '?' + nextSearch : '' }, { replace: true });
  }, [contentType, currentSearch, genreFilter, navigate, query, section, yearFilter]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void desktopApi.listAvailableStremioPlugins()
      .then((available) => {
        if (active) setPlugins(available);
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [activeProfile?.id]);

  useEffect(() => {
    if (availableSections.length === 0) {
      setItems([]);
      return;
    }
    if (!availableSections.includes(section)) setSection(availableSections[0]);
  }, [availableSections, section]);

  useEffect(() => {
    setGenreFilter('');
    setYearFilter('');
    setYearOptions([]);
    setGenreOptions([]);
    detailsCache.current.clear();
  }, [contentType]);

  useEffect(() => {
    const definition = catalogSelection?.catalog.extra.find((extra) => extra.name.trim().toLowerCase() === 'genre');
    if (definition?.options?.length) {
      setGenreOptions(genreOptionsFrom(catalogSelection?.catalog || null, []));
    }
  }, [catalogSelection]);

  useEffect(() => {
    if (!pageRef.current) return;
    try {
      const raw = sessionStorage.getItem(DISCOVER_VIEW_STATE_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { search?: string; scrollTop?: number };
      if (saved.search !== location.search || typeof saved.scrollTop !== 'number' || saved.scrollTop <= 0) return;
      window.requestAnimationFrame(() => {
        if (pageRef.current) pageRef.current.scrollTop = Math.max(0, saved.scrollTop || 0);
      });
    } catch {
      // Ignore invalid or unavailable storage state.
    }
  }, [location.search]);

  useEffect(() => () => {
    if (!pageRef.current) return;
    try {
      sessionStorage.setItem(DISCOVER_VIEW_STATE_STORAGE_KEY, JSON.stringify({
        search: location.search,
        scrollTop: pageRef.current.scrollTop,
      }));
    } catch {
      // Ignore storage failures.
    }
  }, [location.search]);

  useEffect(() => {
    insertShimmerStyle();
  }, []);

  useEffect(() => { queryRef.current = query; }, [query]);
  useEffect(() => { genreRef.current = genreFilter; }, [genreFilter]);
  useEffect(() => { yearRef.current = yearFilter; }, [yearFilter]);

  const getCachedItems = useCallback((cacheId: string): readonly StremioPluginCatalogItem[] | null => {
    const cache = discoverCache.current;
    if (cache.date !== toLocalDateKey()) {
      discoverCache.current = { date: toLocalDateKey(), entries: {} };
      try { sessionStorage.removeItem(DISCOVER_CACHE_STORAGE_KEY); } catch { /* memory cache remains available */ }
      return null;
    }
    const cached = cache.entries[cacheId];
    if (!cached || cached.expiresAt < Date.now()) return null;
    return cached.items;
  }, []);

  const setCachedItems = useCallback((cacheId: string, nextItems: readonly StremioPluginCatalogItem[]) => {
    if (discoverCache.current.date !== toLocalDateKey()) discoverCache.current = { date: toLocalDateKey(), entries: {} };
    discoverCache.current.entries[cacheId] = { expiresAt: nextMidnightAt(), items: [...nextItems] };
    try { sessionStorage.setItem(DISCOVER_CACHE_STORAGE_KEY, JSON.stringify(discoverCache.current)); } catch { /* optional cache */ }
  }, []);

  const applyLocalFilters = useCallback((
    nextItems: readonly StremioPluginCatalogItem[],
    searchValue: string,
    genreValue: string,
    yearValue: string,
  ) => nextItems.filter((item) => {
    const localSearch = !supportsSearch && searchValue.trim()
      ? [item.title, item.description, item.releaseInfo, ...item.genres].filter(Boolean).some((value) => String(value).toLowerCase().includes(searchValue.trim().toLowerCase()))
      : true;
    const localGenre = !supportsGenre && hasGenreMatch(item, genreValue);
    const localYear = !supportsYear && hasYearMatch(item, yearValue);
    return localSearch && localGenre && localYear;
  }), [supportsGenre, supportsSearch, supportsYear]);

  const loadCatalog = useCallback(async (
    searchValue = '',
    genre = genreFilter,
    year = yearFilter,
  ) => {
    const requestRevision = ++catalogRequestRevision.current;
    if (!catalogSelection) {
      setItems([]);
      setLoading(false);
      return;
    }
    const trimmedQuery = searchValue.trim();
    const normalizedGenre = normalizeGenreFilter(genre);
    const normalizedYear = year.trim();
    const cacheId = makeCacheId(catalogSelection, section, trimmedQuery, normalizedGenre, normalizedYear);
    const cached = getCachedItems(cacheId);
    if (cached) {
      setGenreOptions(genreOptionsFrom(catalogSelection.catalog, cached));
      setYearOptions(toYearFilterOptions(cached));
      if (requestRevision === catalogRequestRevision.current) {
        setItems(applyLocalFilters(cached, trimmedQuery, normalizedGenre, normalizedYear));
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await desktopApi.getStremioCatalog(catalogSelection.plugin.addonId, {
        type: catalogSelection.catalog.type,
        catalogId: catalogSelection.catalog.id,
        filters: {
          ...(trimmedQuery ? { query: trimmedQuery } : {}),
          ...(normalizedGenre ? { genre: normalizedGenre } : {}),
          ...(normalizedYear ? { year: normalizedYear } : {}),
        },
      });
      // Pagination and unsupported-provider fallbacks are completed by the
      // host before renderer-visible data crosses IPC.
      const nextItems = result.items;
      if (requestRevision !== catalogRequestRevision.current) return;
      setGenreOptions(genreOptionsFrom(catalogSelection.catalog, nextItems));
      setYearOptions(toYearFilterOptions(nextItems));
      setCachedItems(cacheId, nextItems);
      setItems(applyLocalFilters(nextItems, trimmedQuery, normalizedGenre, normalizedYear));
    } catch (loadError) {
      if (requestRevision !== catalogRequestRevision.current) return;
      setItems([]);
      setError(errorMessage(loadError));
    } finally {
      if (requestRevision === catalogRequestRevision.current) setLoading(false);
    }
  }, [applyLocalFilters, catalogSelection, genreFilter, getCachedItems, section, setCachedItems, yearFilter]);

  useEffect(() => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      void loadCatalog(query, genreRef.current, yearRef.current);
    }, PROVIDER_SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    };
  }, [catalogSelection, loadCatalog, query, section]);

  useEffect(() => {
    const delayMs = Math.max(1_000, nextMidnightAt() - Date.now());
    const timer = window.setTimeout(() => {
      discoverCache.current = { date: toLocalDateKey(), entries: {} };
      try { sessionStorage.removeItem(DISCOVER_CACHE_STORAGE_KEY); } catch { /* optional cache */ }
      void loadCatalog(queryRef.current, genreRef.current, yearRef.current);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [loadCatalog]);

  const openItemDetails = useCallback((item: StremioPluginCatalogItem) => {
    if (!catalogSelection) return;
    const cacheKey = catalogSelection.plugin.addonId + ':' + item.type + ':' + item.id;
    const existing = detailsCache.current.get(cacheKey);
    const pending = existing || desktopApi.getStremioMeta(catalogSelection.plugin.addonId, {
      type: item.type,
      id: item.id,
    }).then((result) => result.item ? { ...item, ...result.item, type: item.type } : item).catch(() => item);
    detailsCache.current.set(cacheKey, pending);
    void pending.then((nextItem) => {
      const discoverSourceRoute = location.search ? DISCOVER_ROUTE + location.search : DISCOVER_ROUTE;
      cacheDiscoverReturnRoute(discoverSourceRoute);
      const routeType = providerUiType(nextItem.type) || contentType;
      const encodedItemId = encodeURIComponent(nextItem.id);
      const detailPath = routeType === 'movie' ? '/movie/' + encodedItemId : routeType === 'anime' ? '/anime/' + encodedItemId : '/tv/' + encodedItemId;
      navigate(detailPath, {
        state: {
          from: discoverSourceRoute,
          fromDiscover: true,
          addonId: catalogSelection.plugin.addonId,
          stremioCatalogItem: nextItem,
        },
      });
    });
  }, [catalogSelection, contentType, location.search, navigate]);

  const chipClass = (isActive: boolean) => 'h-8 shrink-0 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ' + (isActive
    ? 'border border-[var(--loom-accent)] bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]'
    : 'border border-[var(--loom-border)] bg-[var(--loom-surface-2)] text-[var(--loom-text)] hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)]');
  const gridEntries = useMemo<GridEntry[]>(() => items.map((item) => ({ id: item.type + ':' + item.id, item })), [items]);

  return (
    <div ref={pageRef} className="loom-page loom-library-page h-full overflow-y-auto">
      <LibrarySearch value={query} onChange={setQuery} placeholder="Search titles" />
      <div className={frameClass + ' loom-library-page-frame page-bottom-safe page-list-bottom-safe ' + topPaddingClass}>
        <header className="loom-library-page-heading mb-6 flex min-h-8 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-[var(--loom-text)]">Discover</h1>
            <p className="mt-1 text-sm text-[var(--loom-muted)]">Discover new anime, tvshows and movies to watch</p>
          </div>
          <div className="w-full">
            <div className="flex items-center gap-2 overflow-x-auto overflow-y-visible pb-1">
              {(Object.keys(DISCOVER_SECTIONS) as DiscoverType[]).map((type) => (
                <button key={type} type="button" onClick={() => setContentType(type)} aria-pressed={contentType === type} className={chipClass(contentType === type)}>
                  {DISCOVER_TYPE_LABELS[type]}
                </button>
              ))}
              <span aria-hidden="true" className="mx-1 my-auto inline-block h-6 w-px self-center bg-[var(--loom-border)] opacity-90" />
              <ThemeDropdown
                id="discover-section-select"
                label="Discover filter"
                value={section}
                options={availableSections.map((value) => ({ value, label: DISCOVER_SECTION_LABELS[value] }))}
                onChange={(value) => setSection(value as DiscoverSection)}
              />
              <ThemeDropdown
                id="discover-genre-select"
                label="Filter genre"
                value={genreFilter}
                options={[{ value: '', label: 'All Genres' }, ...genreOptions]}
                onChange={setGenreFilter}
              />
              <ThemeDropdown
                id="discover-year-select"
                label="Filter year"
                value={yearFilter}
                options={[{ value: '', label: 'All Years' }, ...yearOptions.map((value) => ({ value, label: value }))]}
                onChange={setYearFilter}
              />
            </div>
          </div>
        </header>

        {error && (
          <div role="alert" className="mt-4 rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <p className="flex items-start gap-2"><Compass className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>
          </div>
        )}

        {loading ? (
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
            {Array.from({ length: 18 }).map((_, index) => <DiscoverShimmerCard key={index} />)}
          </div>
        ) : gridEntries.length === 0 ? (
          <p className="mt-10 text-center text-sm text-[var(--loom-muted)]">
            {plugins.length === 0 ? 'No approved catalogs are available for this profile.' : 'No titles returned for this selection.'}
          </p>
        ) : (
          <VirtualPosterGrid
            items={gridEntries}
            renderItem={(entry) => (
              <StremioPosterCard item={entry.item} metaLine={stremioMetaLine(entry.item)} onSelect={openItemDetails} />
            )}
          />
        )}
      </div>
    </div>
  );
}
