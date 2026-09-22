export const DISCOVER_CACHE_STORAGE_KEY = 'loomtv:discover-cache-v3';
export const DISCOVER_ROUTE = '/discover';
export const DEFAULT_AVAILABILITY_REGION = 'US';
export const AVAILABILITY_REGIONS = ['US', 'GB', 'CA', 'AU'] as const;
export const ALL_AVAILABILITY_REGION = 'ALL' as const;
const DISCOVER_MIN_RELEASE_YEAR = 1900;

export type DiscoverType = 'movie' | 'tv' | 'anime';
export type DiscoverSection = 'trending' | 'popular' | 'top_rated' | 'new';
export type AvailabilityRegion = typeof AVAILABILITY_REGIONS[number] | typeof ALL_AVAILABILITY_REGION;
export type CachedCacheId = string;

export type ParsedDiscoverFilterState = {
  contentType: DiscoverType;
  section: DiscoverSection;
  genreFilter: string;
  yearFilter: string;
  platformFilter: string;
  region: string;
  query: string;
};

export function parseDiscoverFilterState(search: string): ParsedDiscoverFilterState {
  const params = new URLSearchParams(search);
  const contentTypeParam = params.get('type');
  const sectionParam = params.get('section');
  const contentType = contentTypeParam === 'movie' || contentTypeParam === 'tv' || contentTypeParam === 'anime'
    ? contentTypeParam
    : 'movie';
  const section = sectionParam === 'trending' || sectionParam === 'popular' || sectionParam === 'top_rated' || sectionParam === 'new'
    ? sectionParam
    : 'trending';

  return {
    contentType,
    section,
    genreFilter: params.get('genre') ?? '',
    yearFilter: params.get('year') ?? '',
    platformFilter: params.get('provider') ?? '',
    region: params.get('region') ?? '',
    query: params.get('q') ?? '',
  };
}

export function buildDiscoverSearch(state: ParsedDiscoverFilterState): string {
  const params = new URLSearchParams();
  if (state.contentType !== 'movie') params.set('type', state.contentType);
  if (state.section !== 'trending') params.set('section', state.section);
  if (state.genreFilter.trim()) params.set('genre', state.genreFilter.trim());
  if (state.yearFilter.trim()) params.set('year', state.yearFilter.trim());
  if (state.platformFilter.trim()) params.set('provider', state.platformFilter.trim());
  if (state.platformFilter.trim() || state.region.trim().toUpperCase() !== DEFAULT_AVAILABILITY_REGION) {
    params.set('region', state.region.trim().toUpperCase() || DEFAULT_AVAILABILITY_REGION);
  }
  const query = state.query.trim();
  if (query) params.set('q', query);
  return params.toString();
}

export function nextMidnightAt(date = new Date()): number {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  if (next.getTime() <= date.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function normalizeAvailabilityRegion(value: string): AvailabilityRegion {
  const normalized = value.trim().toUpperCase();
  if (normalized === ALL_AVAILABILITY_REGION) return ALL_AVAILABILITY_REGION;
  return AVAILABILITY_REGIONS.includes(normalized as typeof AVAILABILITY_REGIONS[number])
    ? normalized as typeof AVAILABILITY_REGIONS[number]
    : DEFAULT_AVAILABILITY_REGION;
}

export function releaseYearOptions(): string[] {
  const currentYear = new Date().getFullYear();
  return Array.from(
    { length: Math.max(1, currentYear - DISCOVER_MIN_RELEASE_YEAR + 1) },
    (_, index) => String(currentYear - index),
  );
}

export function makeCacheId(
  type: DiscoverType,
  section: DiscoverSection,
  query: string,
  genre = '',
  year = '',
  provider = '',
  region = DEFAULT_AVAILABILITY_REGION,
): string {
  if (!year.trim() && !provider.trim() && normalizeAvailabilityRegion(region) === DEFAULT_AVAILABILITY_REGION) {
    return `${type}:${section}:${query.trim().toLowerCase()}:${genre.trim().toLowerCase()}`;
  }
  return [type, section, query, genre, year, provider, region]
    .map((value) => encodeURIComponent(value.trim().toLowerCase()))
    .join(':');
}
