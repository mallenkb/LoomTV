import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronDown, Compass, Info } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useTheme } from '@/components/ThemeProvider';
import { useProfiles } from '@/contexts/ProfileContext';
import LibrarySearch from '@/components/LibrarySearch';
import SafeArtwork from '@/components/SafeArtwork';
import StremioPosterCard from '@/components/StremioPosterCard';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import { Button } from '@/components/ui/button';
import {
  desktopApi,
  type StremioPluginCatalogDefinition,
  type StremioPluginCatalogExtra,
  type StremioPluginCatalogItem,
  type StremioPluginSummary,
} from '@/lib/desktopApi';

const PROVIDER_SEARCH_DEBOUNCE_MS = 450;
const DISCOVER_RESULT_LIMIT = 30;
const DISCOVER_CACHE_STORAGE_KEY = 'loomtv:discover-cache-v3';
const DISCOVER_VIEW_STATE_STORAGE_KEY = 'loomtv:discover-view-state-v1';
const DISCOVER_ROUTE = '/discover';

type DiscoverType = 'movie' | 'tv' | 'anime';
type DiscoverSection = 'trending' | 'popular' | 'top_rated' | 'new';
type CachedCacheId = `${string}:${string}:${string}:${string}:${string}:${string}:${string}`;
type GenreOption = { label: string; value: string };
type GridEntry = { id: string; item: StremioPluginCatalogItem };

interface CachedDiscoverItem {
  expiresAt: number;
  items: StremioPluginCatalogItem[];
}

interface DiscoverCacheState {
  date: string;
  entries: Record<string, CachedDiscoverItem>;
}

interface ParsedDiscoverFilterState {
  contentType: DiscoverType;
  section: DiscoverSection;
  providerId: string;
  catalogKey: string;
  genreFilter: string;
  yearFilter: string;
  query: string;
}

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

const SECTION_HINTS: Record<DiscoverSection, readonly string[]> = {
  trending: ['trending', 'trend'],
  popular: ['popular', 'most popular'],
  top_rated: ['top_rated', 'top-rated', 'top rated', 'rating', 'imdb', 'top'],
  new: ['new', 'latest', 'upcoming', 'on the air', 'on_the_air', 'recent'],
};

function parseDiscoverFilterState(search: string): ParsedDiscoverFilterState {
  const params = new URLSearchParams(search);
  const contentTypeParam = params.get('type');
  const sectionParam = params.get('section');
  const contentType = contentTypeParam === 'movie' || contentTypeParam === 'tv' || contentTypeParam === 'anime'
    ? contentTypeParam
    : 'movie';
  const section = sectionParam === 'trending'
    || sectionParam === 'popular'
    || sectionParam === 'top_rated'
    || sectionParam === 'new'
    ? sectionParam
    : 'trending';
  return {
    contentType,
    section,
    providerId: params.get('provider') || '',
    catalogKey: params.get('catalog') || '',
    genreFilter: params.get('genre') || '',
    yearFilter: params.get('year') || '',
    query: params.get('q') || '',
  };
}

function buildDiscoverSearch(state: ParsedDiscoverFilterState): string {
  const params = new URLSearchParams();
  if (state.contentType !== 'movie') params.set('type', state.contentType);
  if (state.section !== 'trending') params.set('section', state.section);
  if (state.providerId.trim()) params.set('provider', state.providerId.trim());
  if (state.catalogKey.trim()) params.set('catalog', state.catalogKey.trim());
  if (state.genreFilter.trim()) params.set('genre', state.genreFilter.trim());
  if (state.yearFilter.trim()) params.set('year', state.yearFilter.trim());
  if (state.query.trim()) params.set('q', state.query.trim());
  return params.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The provider request failed.';
}

function toLocalDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function nextMidnightAt(date = new Date()): number {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  if (next.getTime() <= date.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function catalogKey(catalog: StremioPluginCatalogDefinition): string {
  return `${catalog.type}:${catalog.id}`;
}

function uiTypeForProviderType(type: string): DiscoverType | null {
  if (type === 'movie') return 'movie';
  if (type === 'anime') return 'anime';
  if (type === 'series' || type === 'tv') return 'tv';
  return null;
}

function providerTypesForUiType(type: DiscoverType): readonly string[] {
  if (type === 'movie') return ['movie'];
  if (type === 'anime') return ['anime'];
  return ['series', 'tv'];
}

function canRequestCatalog(catalog: StremioPluginCatalogDefinition): boolean {
  return catalog.extra.every((extra) => !extra.isRequired || Boolean(extra.options?.length));
}

function requiredCatalogExtra(catalog: StremioPluginCatalogDefinition): Record<string, string> {
  return Object.fromEntries(catalog.extra
    .filter((extra) => extra.isRequired && extra.options?.length)
    .map((extra) => [extra.name, String(extra.options?.[0] || '')]));
}

function findExtra(catalog: StremioPluginCatalogDefinition | null, names: readonly string[]): StremioPluginCatalogExtra | null {
  if (!catalog) return null;
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return catalog.extra.find((extra) => wanted.has(extra.name.toLowerCase())) || null;
}

function catalogSupports(catalog: StremioPluginCatalogDefinition | null, names: readonly string[]): boolean {
  return Boolean(findExtra(catalog, names));
}

function catalogMatchesSection(catalog: StremioPluginCatalogDefinition, section: DiscoverSection): boolean {
  const haystack = `${catalog.id} ${catalog.name}`.toLowerCase().replace(/[_-]+/g, ' ');
  return SECTION_HINTS[section].some((hint) => haystack.includes(hint.replace(/[_-]+/g, ' ').toLowerCase()));
}

function normalizeGenre(value: string): string {
  return value.trim().toLowerCase();
}

function parseYearFromItem(item: StremioPluginCatalogItem): number {
  for (const candidate of [item.releaseInfo, item.released]) {
    const match = String(candidate || '').match(/\b(19\d{2}|20\d{2})\b/);
    if (match) return Number(match[1]);
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
  items.forEach((item) => {
    const year = parseYearFromItem(item);
    if (year > 0) years.add(year);
  });
  return [...years].sort((left, right) => right - left).map(String);
}

function toGenreOptions(items: readonly StremioPluginCatalogItem[]): GenreOption[] {
  const values = new Map<string, string>();
  items.forEach((item) => item.genres.forEach((genre) => {
    const label = String(genre || '').trim();
    if (label && !values.has(normalizeGenre(label))) values.set(normalizeGenre(label), label);
  }));
  return [...values.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function hasTextMatch(item: StremioPluginCatalogItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [item.title, item.description, item.releaseInfo, item.released, ...item.genres]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}

function hasGenreMatch(item: StremioPluginCatalogItem, genre: string): boolean {
  const normalized = normalizeGenre(genre);
  return !normalized || item.genres.some((candidate) => normalizeGenre(candidate) === normalized);
}

function hasYearMatch(item: StremioPluginCatalogItem, year: string): boolean {
  const normalized = Number(year);
  return !Number.isFinite(normalized) || normalized <= 0 || parseYearFromItem(item) === normalized;
}

function makeCacheId(
  addonId: string,
  catalog: StremioPluginCatalogDefinition,
  section: DiscoverSection,
  query: string,
  genre: string,
  year: string,
): CachedCacheId {
  return `${addonId}:${catalog.type}:${catalog.id}:${section}:${query.trim().toLowerCase()}:${genre.trim().toLowerCase()}:${year.trim().toLowerCase()}` as CachedCacheId;
}

function loadDiscoverCacheFromStorage(): DiscoverCacheState {
  const empty: DiscoverCacheState = { date: toLocalDateKey(), entries: {} };
  try {
    const raw = sessionStorage.getItem(DISCOVER_CACHE_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as DiscoverCacheState;
    if (!parsed || parsed.date !== empty.date || !parsed.entries || typeof parsed.entries !== 'object') return empty;
    return {
      date: parsed.date,
      entries: Object.fromEntries(Object.entries(parsed.entries).filter(([, entry]) => (
        typeof entry?.expiresAt === 'number' && Array.isArray(entry?.items)
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
  style.textContent = `
    @keyframes discover-shimmer-slide {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    .discover-shimmer-wave {
      background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 40%, rgba(255,255,255,0.22) 50%, rgba(255,255,255,0.08) 60%, transparent 100%);
      animation: discover-shimmer-slide 1.5s linear infinite;
    }
  `;
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
  buttonClassName,
}: {
  id: string;
  label: string;
  value: string;
  options: ThemeDropdownOption[];
  onChange: (value: string) => void;
  buttonClassName?: string;
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
    if (!isOpen) return undefined;
    computeMenuStyle();
    const reposition = () => computeMenuStyle();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
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
          if (event.key === 'Escape') {
            setIsOpen(false);
            return;
          }
          if (['ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            setIsOpen(true);
          }
        }}
        className={`relative z-10 inline-flex h-8 min-w-[9rem] items-center rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 pr-10 text-sm font-normal text-[var(--loom-text)] outline-none transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] ${buttonClassName || ''}`}
      >
        <span className="truncate whitespace-nowrap">{selectedLabel}</span>
        <ChevronDown className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && menuStyle ? createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          className="fixed z-[9999] mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-1 text-[var(--loom-text)] shadow-[0_18px_40px_rgba(0,0,0,0.30)]"
          style={{ left: menuStyle.left, top: menuStyle.top, width: menuStyle.width }}
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`relative z-10 flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${selected
                  ? 'bg-[var(--loom-active-bg)] text-[var(--loom-text)]'
                  : 'text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function DiscoverDetail({
  item,
  loading,
  error,
  onBack,
}: {
  item: StremioPluginCatalogItem | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
}) {
  if (loading && !item) {
    return (
      <div className="mt-8 grid gap-6 rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-panel)] p-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <DiscoverShimmerCard />
        <div className="space-y-4 py-2">
          <div className="h-8 w-2/3 bg-[var(--loom-surface)]" />
          <div className="h-4 w-1/3 bg-[var(--loom-surface)]" />
          <div className="h-24 w-full bg-[var(--loom-surface)]" />
        </div>
      </div>
    );
  }

  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-panel)]" aria-live="polite">
      <div className="relative min-h-[24rem] overflow-hidden">
        {item?.artwork?.background && (
          <SafeArtwork
            src={item.artwork.background}
            alt=""
            className="absolute inset-0 h-full w-full opacity-35"
            priority
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-[var(--loom-panel)] via-[var(--loom-panel)]/95 to-[var(--loom-panel)]/55" />
        <div className="relative p-6 md:p-8">
          <Button type="button" variant="ghost" size="sm" onClick={onBack} className="mb-6 gap-2 text-[var(--loom-text)]">
            <ArrowLeft className="h-4 w-4" />
            Back to Discover
          </Button>
          {error && !item ? (
            <div role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
          ) : item ? (
            <div className="grid gap-7 md:grid-cols-[220px_minmax(0,1fr)]">
              <SafeArtwork
                src={[item.artwork?.poster, item.artwork?.background, item.artwork?.logo].filter((value): value is string => Boolean(value))}
                alt={item.title}
                className="aspect-[2/3] w-full max-w-[220px] rounded-xl shadow-2xl"
                priority
              />
              <div className="min-w-0 self-end">
                <p className="text-xs uppercase tracking-[0.18em] text-[var(--loom-accent)]">Metadata preview</p>
                <h2 className="mt-2 text-3xl font-semibold text-[var(--loom-text)] md:text-4xl">{item.title}</h2>
                <p className="mt-3 text-sm text-[var(--loom-muted)]">{stremioMetaLine(item) || item.type}</p>
                {item.rating !== undefined && <p className="mt-3 text-sm font-medium text-yellow-200">Rating {item.rating.toFixed(1)}</p>}
                {item.genres.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {item.genres.map((genre) => <span key={genre} className="rounded-full border border-[var(--loom-border)] px-3 py-1 text-xs text-[var(--loom-muted)]">{genre}</span>)}
                  </div>
                )}
                {item.description && <p className="mt-6 max-w-3xl whitespace-pre-line text-sm leading-7 text-[var(--loom-muted)]">{item.description}</p>}
                <div className="mt-6 rounded-xl border border-blue-400/25 bg-blue-400/10 p-3 text-sm text-blue-100">
                  <p className="flex items-start gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0" /> Remote playback and subtitle attachment are not enabled in this foundation release.</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-[var(--loom-muted)]">No metadata was returned for this title.</div>
          )}
        </div>
      </div>
      {item?.cast && item.cast.length > 0 && (
        <div className="border-t border-[var(--loom-border)] p-6 md:p-8">
          <h3 className="text-lg font-semibold text-[var(--loom-text)]">Cast</h3>
          <div className="mt-4 flex gap-4 overflow-x-auto pb-2">
            {item.cast.slice(0, 12).map((actor) => (
              <div key={`${actor.name}:${actor.character || ''}`} className="w-20 flex-shrink-0 text-center">
                <SafeArtwork
                  src={actor.image || ''}
                  alt={actor.name}
                  className="mx-auto h-16 w-16 rounded-full"
                  fallback={<div className="grid h-full w-full place-items-center bg-[var(--loom-surface-3)] text-sm text-[var(--loom-text)]">{actor.name.charAt(0)}</div>}
                />
                <p className="mt-2 truncate text-xs font-medium text-[var(--loom-text)]">{actor.name}</p>
                {actor.character && <p className="truncate text-[10px] text-[var(--loom-muted)]">{actor.character}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export default function PluginDiscover() {
  const { theme } = useTheme();
  const { activeProfile } = useProfiles();
  const location = useLocation();
  const navigate = useNavigate();
  const { addonId: routeAddonId, type: routeType, itemId: routeItemId } = useParams<{
    addonId?: string;
    type?: string;
    itemId?: string;
  }>();
  const initialFilterState = useMemo(() => parseDiscoverFilterState(location.search), [location.search]);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [plugins, setPlugins] = useState<StremioPluginSummary[]>([]);
  const [providerId, setProviderId] = useState(initialFilterState.providerId);
  const [catalogKeyValue, setCatalogKeyValue] = useState(initialFilterState.catalogKey);
  const [query, setQuery] = useState(initialFilterState.query);
  const [contentType, setContentType] = useState<DiscoverType>(initialFilterState.contentType);
  const [section, setSection] = useState<DiscoverSection>(initialFilterState.section);
  const [genreFilter, setGenreFilter] = useState(initialFilterState.genreFilter);
  const [yearFilter, setYearFilter] = useState(initialFilterState.yearFilter);
  const [items, setItems] = useState<readonly StremioPluginCatalogItem[]>([]);
  const [yearOptions, setYearOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [pluginsLoading, setPluginsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<StremioPluginCatalogItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const catalogRequestRevision = useRef(0);
  const metaRequestRevision = useRef(0);
  const searchTimer = useRef<number | null>(null);
  const queryRef = useRef(query);
  const genreRef = useRef(genreFilter);
  const yearRef = useRef(yearFilter);
  const previousContentType = useRef(contentType);
  const discoverCache = useRef<DiscoverCacheState>(loadDiscoverCacheFromStorage());

  const isDetailRoute = Boolean(routeAddonId && routeType && routeItemId);
  const routeContentType = routeType ? uiTypeForProviderType(routeType) : null;
  const catalogPlugins = useMemo(
    () => plugins.filter((plugin) => !plugin.configurationRequired && plugin.catalogs.some(canRequestCatalog)),
    [plugins],
  );
  const plugin = useMemo(
    () => routeAddonId
      ? catalogPlugins.find((candidate) => candidate.addonId === routeAddonId) || null
      : catalogPlugins.find((candidate) => candidate.addonId === providerId) || catalogPlugins.find((candidate) => candidate.addonId === 'com.linvo.cinemeta') || catalogPlugins[0] || null,
    [catalogPlugins, providerId, routeAddonId],
  );
  const effectiveContentType = routeContentType || contentType;
  const catalogs = useMemo(
    () => plugin?.catalogs.filter((candidate) => (
      canRequestCatalog(candidate) && providerTypesForUiType(effectiveContentType).includes(candidate.type)
    )) || [],
    [effectiveContentType, plugin],
  );
  const catalog = useMemo(() => {
    const exact = catalogs.find((candidate) => catalogKey(candidate) === catalogKeyValue);
    return exact || catalogs.find((candidate) => catalogMatchesSection(candidate, section)) || catalogs[0] || null;
  }, [catalogKeyValue, catalogs, section]);
  const genreExtra = findExtra(catalog, ['genre', 'genres']);
  const yearExtra = findExtra(catalog, ['year', 'releaseYear', 'release_year']);
  const searchSupported = catalogSupports(catalog, ['search']);
  const genreOptions = useMemo(() => {
    const manifestOptions = genreExtra?.options?.filter(Boolean).map((value) => ({ label: value, value })) || [];
    return manifestOptions.length > 0 ? manifestOptions : toGenreOptions(items);
  }, [genreExtra, items]);
  const isModern = theme.homeStyle === 'modern';
  const frameClass = isModern ? 'loom-modern-content-frame' : 'loom-frame';
  const topPaddingClass = isModern ? 'pt-28' : 'pt-24';
  const currentSearch = location.search.startsWith('?') ? location.search.slice(1) : location.search;

  useEffect(() => {
    const next = parseDiscoverFilterState(location.search);
    setQuery(next.query);
    setContentType(next.contentType);
    setSection(next.section);
    setProviderId(next.providerId);
    setCatalogKeyValue(next.catalogKey);
    setGenreFilter(next.genreFilter);
    setYearFilter(next.yearFilter);
  }, [location.search]);

  useEffect(() => {
    if (isDetailRoute) return;
    const nextSearch = buildDiscoverSearch({
      contentType,
      section,
      providerId: plugin?.addonId || providerId,
      catalogKey: catalog ? catalogKey(catalog) : catalogKeyValue,
      genreFilter,
      yearFilter,
      query,
    });
    if (nextSearch === currentSearch) return;
    void navigate({ pathname: DISCOVER_ROUTE, search: nextSearch ? `?${nextSearch}` : '' }, { replace: true });
  }, [catalog, catalogKeyValue, contentType, currentSearch, genreFilter, isDetailRoute, navigate, plugin?.addonId, providerId, query, section, yearFilter]);

  useEffect(() => {
    let mounted = true;
    setPluginsLoading(true);
    void desktopApi.listAvailableStremioPlugins()
      .then((available) => {
        if (!mounted) return;
        setPlugins(available);
        setProviderId((current) => {
          if (routeAddonId) return routeAddonId;
          if (available.some((candidate) => candidate.addonId === current)) return current;
          return available.find((candidate) => candidate.addonId === 'com.linvo.cinemeta')?.addonId || available[0]?.addonId || '';
        });
      })
      .catch((loadError) => {
        if (mounted) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (mounted) setPluginsLoading(false);
      });
    return () => { mounted = false; };
  }, [activeProfile?.id, routeAddonId]);

  useEffect(() => {
    if (previousContentType.current === contentType) return;
    previousContentType.current = contentType;
    setSection('trending');
    setGenreFilter('');
    setYearFilter('');
    setYearOptions([]);
    setCatalogKeyValue('');
  }, [contentType]);

  useEffect(() => {
    if (!catalog) return;
    const nextKey = catalogKey(catalog);
    if (nextKey !== catalogKeyValue) setCatalogKeyValue(nextKey);
  }, [catalog, catalogKeyValue]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    genreRef.current = genreFilter;
  }, [genreFilter]);

  useEffect(() => {
    yearRef.current = yearFilter;
  }, [yearFilter]);

  useEffect(() => {
    insertShimmerStyle();
  }, []);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    try {
      const raw = sessionStorage.getItem(DISCOVER_VIEW_STATE_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { search?: string; scrollTop?: number };
      if (saved.search !== location.search || typeof saved.scrollTop !== 'number' || !Number.isFinite(saved.scrollTop) || saved.scrollTop <= 0) return;
      window.requestAnimationFrame(() => {
        if (pageRef.current) pageRef.current.scrollTop = Math.max(0, saved.scrollTop || 0);
      });
    } catch {
      // Ignore invalid or unavailable storage state.
    }
  }, [location.search]);

  useEffect(() => () => {
    const page = pageRef.current;
    if (!page) return;
    try {
      sessionStorage.setItem(DISCOVER_VIEW_STATE_STORAGE_KEY, JSON.stringify({
        search: location.search,
        scrollTop: page.scrollTop,
      }));
    } catch {
      // Ignore storage failures in constrained environments.
    }
  }, [location.search]);

  const getCachedItems = useCallback((cacheId: CachedCacheId): readonly StremioPluginCatalogItem[] | null => {
    const cache = discoverCache.current;
    const today = toLocalDateKey();
    if (cache.date !== today) {
      discoverCache.current = { date: today, entries: {} };
      try { sessionStorage.removeItem(DISCOVER_CACHE_STORAGE_KEY); } catch { /* best effort */ }
      return null;
    }
    const cached = cache.entries[cacheId];
    if (!cached || cached.expiresAt < Date.now()) return null;
    return cached.items;
  }, []);

  const setCachedItems = useCallback((cacheId: CachedCacheId, nextItems: readonly StremioPluginCatalogItem[]) => {
    const today = toLocalDateKey();
    if (discoverCache.current.date !== today) discoverCache.current = { date: today, entries: {} };
    discoverCache.current.entries[cacheId] = { expiresAt: nextMidnightAt(), items: [...nextItems] };
    try {
      sessionStorage.setItem(DISCOVER_CACHE_STORAGE_KEY, JSON.stringify(discoverCache.current));
    } catch {
      // Opaque resource references remain in memory when storage is unavailable.
    }
  }, []);

  const filterItems = useCallback((source: readonly StremioPluginCatalogItem[], searchValue: string, genre: string, year: string) => {
    return source
      .filter((item) => searchSupported || hasTextMatch(item, searchValue))
      .filter((item) => genreExtra || hasGenreMatch(item, genre))
      .filter((item) => yearExtra || hasYearMatch(item, year));
  }, [genreExtra, searchSupported, yearExtra]);

  const loadCatalog = useCallback(async (searchValue = query, genre = genreFilter, year = yearFilter) => {
    const requestRevision = ++catalogRequestRevision.current;
    if (!plugin || !catalog || isDetailRoute) {
      setItems([]);
      setLoading(false);
      return;
    }
    const trimmedQuery = searchValue.trim();
    const normalizedGenre = normalizeGenre(genre);
    const cacheId = makeCacheId(plugin.addonId, catalog, section, trimmedQuery, normalizedGenre, year);
    const cached = getCachedItems(cacheId);
    if (cached) {
      const availableYears = toYearFilterOptions(cached);
      setYearOptions(availableYears);
      if (requestRevision === catalogRequestRevision.current && year.trim() && !availableYears.includes(year.trim())) setYearFilter('');
      if (requestRevision === catalogRequestRevision.current) {
        setItems(cached);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const extra: Record<string, string | number | boolean> = requiredCatalogExtra(catalog);
      const searchDefinition = findExtra(catalog, ['search']);
      if (trimmedQuery && searchDefinition) extra[searchDefinition.name] = trimmedQuery;
      if (genre.trim() && genreExtra) extra[genreExtra.name] = genre.trim();
      if (year.trim() && yearExtra) extra[yearExtra.name] = year.trim();
      const result = await desktopApi.getStremioCatalog(plugin.addonId, {
        type: catalog.type,
        catalogId: catalog.id,
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
      });
      const nextItems = result.items.slice(0, DISCOVER_RESULT_LIMIT);
      const availableYears = toYearFilterOptions(nextItems);
      setYearOptions(availableYears);
      if (requestRevision === catalogRequestRevision.current && year.trim() && !availableYears.includes(year.trim())) setYearFilter('');
      if (requestRevision === catalogRequestRevision.current) {
        setItems(nextItems);
        setCachedItems(cacheId, nextItems);
      }
    } catch (loadError) {
      if (requestRevision === catalogRequestRevision.current) {
        setItems([]);
        setError(errorMessage(loadError));
      }
    } finally {
      if (requestRevision === catalogRequestRevision.current) setLoading(false);
    }
  }, [catalog, genreExtra, genreFilter, getCachedItems, isDetailRoute, plugin, query, section, setCachedItems, yearExtra, yearFilter]);

  useEffect(() => {
    if (isDetailRoute || !plugin || !catalog) return undefined;
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      void loadCatalog(query, genreFilter, yearFilter);
    }, PROVIDER_SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
        searchTimer.current = null;
      }
    };
  }, [catalog, genreFilter, isDetailRoute, loadCatalog, plugin, query, yearFilter]);

  useEffect(() => {
    if (isDetailRoute || !plugin || !catalog) return undefined;
    const delay = Math.max(1_000, nextMidnightAt() - Date.now());
    const timer = window.setTimeout(() => {
      discoverCache.current = { date: toLocalDateKey(), entries: {} };
      try { sessionStorage.removeItem(DISCOVER_CACHE_STORAGE_KEY); } catch { /* best effort */ }
      void loadCatalog(queryRef.current, genreRef.current, yearRef.current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [catalog, isDetailRoute, loadCatalog, plugin]);

  useEffect(() => {
    const requestRevision = ++metaRequestRevision.current;
    if (!isDetailRoute || !plugin || plugin.addonId !== routeAddonId || !routeType || !routeItemId) {
      setSelectedItem(null);
      setDetailLoading(false);
      return;
    }
    const fallback = items.find((item) => item.id === routeItemId && item.type === routeType) || null;
    setSelectedItem(fallback);
    setDetailLoading(true);
    setError(null);
    void desktopApi.getStremioMeta(plugin.addonId, { type: routeType, id: routeItemId })
      .then((result) => {
        if (requestRevision !== metaRequestRevision.current) return;
        setSelectedItem(result.item || fallback);
        if (!result.item && !fallback) setError('No metadata was returned for this title.');
      })
      .catch((metaError) => {
        if (requestRevision === metaRequestRevision.current) setError(errorMessage(metaError));
      })
      .finally(() => {
        if (requestRevision === metaRequestRevision.current) setDetailLoading(false);
      });
  }, [isDetailRoute, items, plugin, routeAddonId, routeItemId, routeType]);

  const visibleItems = useMemo(
    () => filterItems(items, query, genreFilter, yearFilter),
    [filterItems, genreFilter, items, query, yearFilter],
  );

  const inspectItem = useCallback((item: StremioPluginCatalogItem) => {
    if (!plugin) return;
    navigate({
      pathname: `${DISCOVER_ROUTE}/${encodeURIComponent(plugin.addonId)}/${encodeURIComponent(item.type)}/${encodeURIComponent(item.id)}`,
      search: location.search,
    });
  }, [location.search, navigate, plugin]);

  const returnToDiscover = useCallback(() => {
    navigate({ pathname: DISCOVER_ROUTE, search: location.search });
  }, [location.search, navigate]);

  const chipClass = (isActive: boolean) => `h-8 shrink-0 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${isActive
    ? 'border border-[var(--loom-accent)] bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]'
    : 'border border-[var(--loom-border)] bg-[var(--loom-surface-2)] text-[var(--loom-text)] hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)]'
  }`;
  const gridEntries = useMemo<GridEntry[]>(() => visibleItems.map((item) => ({ id: item.id, item })), [visibleItems]);
  const providerOptions = catalogPlugins.map((candidate) => ({ value: candidate.addonId, label: candidate.name }));
  const catalogOptions = catalogs.map((candidate) => ({ value: catalogKey(candidate), label: `${candidate.name} · ${candidate.type}` }));
  const genreDropdownOptions = [{ value: '', label: 'All Genres' }, ...genreOptions];
  const yearDropdownOptions = [{ value: '', label: 'All Years' }, ...yearOptions.map((year) => ({ value: year, label: year }))];

  return (
    <div ref={pageRef} className="loom-page loom-library-page h-full overflow-y-auto">
      {!isDetailRoute && <LibrarySearch value={query} onChange={setQuery} placeholder="Search titles" />}
      <div className={`${frameClass} loom-library-page-frame page-bottom-safe page-list-bottom-safe ${topPaddingClass}`}>
        <header className="loom-library-page-heading mb-6 flex min-h-8 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              {isDetailRoute && <Button type="button" variant="ghost" size="sm" onClick={returnToDiscover} className="gap-2 text-[var(--loom-text)]"><ArrowLeft className="h-4 w-4" />Back</Button>}
              <div>
                <h1 className="truncate text-xl font-semibold text-[var(--loom-text)]">Discover</h1>
                <p className="mt-1 text-sm text-[var(--loom-muted)]">Discover new anime, tvshows and movies to watch</p>
              </div>
            </div>
          </div>
          <span className="rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 py-1.5 text-xs text-[var(--loom-muted)]">Catalog &amp; metadata preview</span>
          {!isDetailRoute && (
            <div className="w-full">
              <div className="flex items-center gap-2 overflow-x-auto overflow-y-visible pb-1">
                {(Object.keys(DISCOVER_SECTIONS) as DiscoverType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setContentType(type)}
                    aria-pressed={contentType === type}
                    className={chipClass(contentType === type)}
                  >
                    {DISCOVER_TYPE_LABELS[type]}
                  </button>
                ))}
                <span aria-hidden="true" className="mx-1 inline-block h-6 w-px self-center bg-[var(--loom-border)] opacity-90" />
                {providerOptions.length > 0 && (
                  <ThemeDropdown
                    id="discover-provider-select"
                    label="Discover provider"
                    value={plugin?.addonId || providerId}
                    options={providerOptions}
                    onChange={(value) => {
                      setProviderId(value);
                      setCatalogKeyValue('');
                      setQuery('');
                      setGenreFilter('');
                      setYearFilter('');
                    }}
                  />
                )}
                <ThemeDropdown
                  id="discover-catalog-select"
                  label="Discover catalog"
                  value={catalog ? catalogKey(catalog) : ''}
                  options={catalogOptions.length > 0 ? catalogOptions : [{ value: '', label: 'No catalogs' }]}
                  onChange={(value) => {
                    setCatalogKeyValue(value);
                    setQuery('');
                  }}
                />
                <ThemeDropdown
                  id="discover-section-select"
                  label="Discover filter"
                  value={section}
                  options={DISCOVER_SECTIONS[contentType].map((discoverSection) => ({ value: discoverSection, label: DISCOVER_SECTION_LABELS[discoverSection] }))}
                  onChange={(value) => {
                    setSection(value as DiscoverSection);
                    setCatalogKeyValue('');
                  }}
                />
                <ThemeDropdown
                  id="discover-genre-select"
                  label="Filter genre"
                  value={genreFilter}
                  options={genreDropdownOptions}
                  onChange={setGenreFilter}
                />
                <ThemeDropdown
                  id="discover-year-select"
                  label="Filter year"
                  value={yearFilter}
                  options={yearDropdownOptions}
                  onChange={setYearFilter}
                />
              </div>
            </div>
          )}
        </header>

        {!isDetailRoute && (
          <div className="mt-4 rounded-xl border border-blue-400/25 bg-blue-400/10 p-3 text-sm text-blue-100">
            <p className="flex items-start gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0" />Remote playback and subtitle attachment are not enabled in this foundation release.</p>
          </div>
        )}

        {error && (
          <div role="alert" className="mt-4 rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <p className="flex items-start gap-2"><Compass className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>
          </div>
        )}

        {isDetailRoute ? (
          <DiscoverDetail item={selectedItem} loading={detailLoading} error={error} onBack={returnToDiscover} />
        ) : pluginsLoading ? (
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
            {Array.from({ length: 12 }).map((_, index) => <DiscoverShimmerCard key={index} />)}
          </div>
        ) : catalogPlugins.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-panel)] p-8 text-center">
            <Compass className="mx-auto h-8 w-8 text-[var(--loom-faint)]" />
            <h2 className="mt-4 text-lg font-semibold text-[var(--loom-text)]">No approved catalogs</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--loom-muted)]">An Owner can install and approve Cinemeta from Settings → Plugins. Kids and Guest profiles cannot use remote add-ons.</p>
          </div>
        ) : loading ? (
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
            {Array.from({ length: 18 }).map((_, index) => <DiscoverShimmerCard key={index} />)}
          </div>
        ) : gridEntries.length === 0 ? (
          <p className="mt-10 text-center text-sm text-[var(--loom-muted)]">No titles returned for this selection.</p>
        ) : (
          <VirtualPosterGrid
            items={gridEntries}
            renderItem={(entry) => (
              <StremioPosterCard item={entry.item} metaLine={stremioMetaLine(entry.item)} onSelect={inspectItem} />
            )}
          />
        )}
      </div>
    </div>
  );
}
