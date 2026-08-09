import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Compass } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { useTheme } from '@/components/ThemeProvider';
import { useProfiles } from '@/contexts/ProfileContext';
import LibrarySearch from '@/components/LibrarySearch';
import StremioPosterCard from '@/components/StremioPosterCard';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import { desktopApi, type StremioPluginCatalogItem } from '@/lib/desktopApi';
import { cacheDiscoverReturnRoute, cacheExploreItem } from '@/lib/discoverNavigation';

const PROVIDER_SEARCH_DEBOUNCE_MS = 450;
const DISCOVER_RESULT_LIMIT = 30;
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const ANILIST_API_URL = 'https://graphql.anilist.co';
const DISCOVER_CACHE_STORAGE_KEY = 'loomtv:discover-cache-v2';
const DISCOVER_VIEW_STATE_STORAGE_KEY = 'loomtv:discover-view-state-v1';
const DISCOVER_ROUTE = '/discover';
const DEFAULT_AVAILABILITY_REGION = 'US';
const AVAILABILITY_REGIONS = ['US', 'GB', 'CA', 'AU'] as const;
const DISCOVER_MIN_RELEASE_YEAR = 1900;

type DiscoverType = 'movie' | 'tv' | 'anime';
type DiscoverSection = 'trending' | 'popular' | 'top_rated' | 'new';
type AvailabilityRegion = typeof AVAILABILITY_REGIONS[number];
type CachedCacheId = string;
type GenreSourceType = Exclude<DiscoverType, 'anime'>;

type GenreOption = {
  label: string;
  value: string;
};

type ProviderOption = GenreOption & {
  logoUrl: string;
  providerId: number;
};

type GridEntry = { id: string; item: StremioPluginCatalogItem };

interface CachedDiscoverItem {
  expiresAt: number;
  items: StremioPluginCatalogItem[];
}

interface DiscoverCacheState {
  date: string;
  entries: Record<string, CachedDiscoverItem>;
}

interface TmdbListResult {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
}

interface TmdbCreditsPerson {
  name?: string;
  character?: string;
  profile_path?: string | null;
}

interface TmdbCreditsResponse {
  cast?: TmdbCreditsPerson[];
}

interface TmdbListResponse {
  results?: TmdbListResult[];
}

interface TmdbProvider {
  provider_id: number;
  provider_name: string;
  logo_path?: string | null;
  display_priority?: number;
}

interface TmdbProviderListResponse {
  results?: TmdbProvider[];
}

interface TmdbWatchProviderRegion {
  flatrate?: TmdbProvider[];
}

interface TmdbWatchProviderDetailResponse {
  results?: Record<string, TmdbWatchProviderRegion>;
}

interface TmdbGenre {
  id: number;
  name: string;
}

interface TmdbGenreResponse {
  genres?: TmdbGenre[];
}

interface TmdbDetailResponse extends TmdbListResult {
  credits?: TmdbCreditsResponse;
  genres?: TmdbGenre[];
}

interface AniListDate {
  year?: number | null;
  month?: number | null;
  day?: number | null;
}

interface AniListMediaTitle {
  userPreferred?: string;
  english?: string;
  native?: string;
}

interface AniListPersonName {
  full?: string;
}

interface AniListPersonImage {
  medium?: string | null;
  large?: string | null;
}

interface AniListCharacter {
  name?: AniListPersonName | null;
  image?: AniListPersonImage | null;
}

interface AniListVoiceActor {
  name?: AniListPersonName | null;
  image?: AniListPersonImage | null;
  languageV2?: string | null;
}

interface AniListCharacterEdge {
  node?: AniListCharacter | null;
  role?: string | null;
  voiceActors?: AniListVoiceActor[] | null;
}

interface AniListCoverImage {
  extraLarge?: string | null;
  large?: string | null;
  medium?: string | null;
}

interface AniListMediaResult {
  id: number;
  title?: AniListMediaTitle;
  description?: string | null;
  genres?: string[];
  averageScore?: number | null;
  startDate?: AniListDate | null;
  coverImage?: AniListCoverImage | null;
  bannerImage?: string | null;
  episodes?: number | null;
  characters?: {
    edges?: AniListCharacterEdge[];
  };
}

type ParsedDiscoverFilterState = {
  contentType: DiscoverType;
  section: DiscoverSection;
  genreFilter: string;
  yearFilter: string;
  platformFilter: string;
  region: string;
  query: string;
};

function parseDiscoverFilterState(search: string): ParsedDiscoverFilterState {
  const params = new URLSearchParams(search);
  const contentTypeParam = params.get('type');
  const sectionParam = params.get('section');
  const genreParam = params.get('genre') ?? '';
  const yearParam = params.get('year') ?? '';
  const platformParam = params.get('provider') ?? '';
  const regionParam = params.get('region') ?? '';
  const query = params.get('q') ?? '';

  const contentType = (contentTypeParam === 'movie' || contentTypeParam === 'tv' || contentTypeParam === 'anime')
    ? contentTypeParam
    : 'movie';
  const section = (sectionParam === 'trending' || sectionParam === 'popular' || sectionParam === 'top_rated' || sectionParam === 'new')
    ? sectionParam
    : 'trending';

  return {
    contentType,
    section,
    genreFilter: genreParam,
    yearFilter: yearParam,
    platformFilter: platformParam,
    region: regionParam,
    query,
  };
}

function buildDiscoverSearch(state: ParsedDiscoverFilterState): string {
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

interface AniListResponse {
  data?: {
    Page?: {
      media?: AniListMediaResult[];
    };
  };
  errors?: { message?: string }[];
}

interface AniListGenreCollectionResponse {
  data?: {
    GenreCollection?: string[];
  };
  errors?: { message?: string }[];
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

const TMDB_SECTION_ENDPOINTS: Record<Exclude<DiscoverType, 'anime'>, Record<DiscoverSection, string>> = {
  movie: {
    trending: 'trending/movie/day',
    popular: 'movie/popular',
    top_rated: 'movie/top_rated',
    new: 'movie/upcoming',
  },
  tv: {
    trending: 'trending/tv/day',
    popular: 'tv/popular',
    top_rated: 'tv/top_rated',
    new: 'tv/on_the_air',
  },
};

const ANILIST_SECTION_SORT: Record<DiscoverSection, readonly string[]> = {
  trending: ['TRENDING_DESC'],
  popular: ['POPULARITY_DESC'],
  top_rated: ['SCORE_DESC'],
  new: ['START_DATE_DESC'],
};

const ANILIST_DISCOVER_QUERY = `
query DiscoverAnime($page: Int, $perPage: Int, $sort: [MediaSort], $search: String, $genre: String, $seasonYear: Int) {
  Page(page: $page, perPage: $perPage) {
    media(
      type: ANIME
      isAdult: false
      sort: $sort
      search: $search
      genre: $genre
      seasonYear: $seasonYear
    ) {
      id
      title {
        userPreferred
        english
        native
      }
      description(asHtml: false)
      genres
      averageScore
      episodes
      startDate {
        year
        month
        day
      }
      coverImage {
        extraLarge
        large
        medium
      }
      bannerImage
      characters(page: 1, perPage: 10) {
        edges {
          node {
            name {
              full
            }
            image {
              medium
              large
            }
          }
          role
          voiceActors {
            name {
              full
            }
            image {
              medium
              large
            }
            languageV2
          }
        }
      }
    }
  }
}
`;

const ANILIST_GENRE_QUERY = `
query {
  GenreCollection
}
`;

function anilistImageUrl(value?: string | null): string {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/^http:\/\//i, 'https://');
}

function pickImageUrl(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const next = anilistImageUrl(value);
    if (next) return next;
  }
  return '';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The provider request failed.';
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

function normalizeTmdbCredential(raw: string): string {
  return raw.trim().replace(/^Bearer\s+/i, '');
}

function isTMDBReadAccessToken(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tmdbImage(path: string | null | undefined, size: 'w45' | 'w92' | 'w185' | 'w300' | 'w500' | 'w1280'): string {
  if (!path) return '';
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

function normalizeAvailabilityRegion(value: string): AvailabilityRegion {
  const normalized = value.trim().toUpperCase();
  return (AVAILABILITY_REGIONS as readonly string[]).includes(normalized)
    ? normalized as AvailabilityRegion
    : DEFAULT_AVAILABILITY_REGION;
}

function releaseYearOptions(): string[] {
  const currentYear = new Date().getFullYear();
  return Array.from(
    { length: Math.max(1, currentYear - DISCOVER_MIN_RELEASE_YEAR + 1) },
    (_, index) => String(currentYear - index),
  );
}

function providerDisplayName(value: string): string {
  const normalized = value.trim();
  if (/netflix/i.test(normalized)) return 'Netflix';
  if (/hulu/i.test(normalized)) return 'Hulu';
  if (/disney/i.test(normalized)) return 'Disney+';
  if (/amazon\s+prime|prime\s+video/i.test(normalized)) return 'Prime Video';
  if (/\b(max|hbo max)\b/i.test(normalized)) return 'Max';
  return normalized;
}

function providerPriority(provider: TmdbProvider): number {
  const label = providerDisplayName(provider.provider_name);
  const recognized = ['Netflix', 'Hulu', 'Disney+', 'Prime Video', 'Max'];
  const index = recognized.indexOf(label);
  return index === -1 ? recognized.length : index;
}

function yearFromDateValue(value: string | undefined): number {
  const match = value?.match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : 0;
}

function parseYearFromItem(item: StremioPluginCatalogItem): number {
  const candidates = [item.releaseInfo, item.released].filter(Boolean).map((value) => String(value));
  for (const value of candidates) {
    const match = value.match(/(19\d{2}|20\d{2})/);
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

function hasCachedImageCandidate(items: readonly StremioPluginCatalogItem[]): boolean {
  return items.some((item) => Boolean(
    (item.posterUrl && item.posterUrl.trim())
    || (item.backgroundUrl && item.backgroundUrl.trim())
    || (item.logoUrl && item.logoUrl.trim()),
  ));
}

function getValidCachedItems(
  cache: DiscoverCacheState,
  cacheId: CachedCacheId,
  now = Date.now(),
): readonly StremioPluginCatalogItem[] | null {
  if (cache.date !== toLocalDateKey()) return null;
  const cached = cache.entries[cacheId];
  if (!cached || cached.expiresAt < now || !hasCachedImageCandidate(cached.items)) return null;
  return cached.items;
}

function hasYearMatch(item: StremioPluginCatalogItem, yearFilter: string): boolean {
  const normalizedYear = Number(yearFilter);
  if (!Number.isFinite(normalizedYear) || normalizedYear <= 0) return true;
  return parseYearFromItem(item) === normalizedYear;
}

function voiceActorLanguagePriority(language?: string | null): number {
  return language?.trim().toLowerCase() === 'japanese' ? 0 : 1;
}

function mapAnilistToCatalog(media: AniListMediaResult): StremioPluginCatalogItem {
  const title = media.title?.userPreferred || media.title?.english || media.title?.native || 'Unknown title';
  const score = typeof media.averageScore === 'number' ? Number((media.averageScore / 10).toFixed(1)) : undefined;
  const releaseYear = media.startDate?.year;
  const releaseInfo = releaseYear ? String(releaseYear) : '';
  const posterUrl = pickImageUrl(
    media.coverImage?.extraLarge,
    media.coverImage?.large,
    media.coverImage?.medium,
  );
  const backgroundUrl = pickImageUrl(
    media.bannerImage,
    media.coverImage?.extraLarge,
    media.coverImage?.large,
    media.coverImage?.medium,
  );
  const cast = (media.characters?.edges || [])
    .filter((entry) => Boolean(entry?.node?.name?.full))
    .slice(0, 10)
    .flatMap((entry) => {
      const characterName = entry.node?.name?.full || 'Unknown character';
      const characterRole = entry.role || '';
      const characterImage = pickImageUrl(entry.node?.image?.large, entry.node?.image?.medium);
      const voiceActors = [...(entry.voiceActors || [])]
        .filter((voiceActor) => Boolean(voiceActor?.name?.full))
        .sort((left, right) => (
          voiceActorLanguagePriority(left.languageV2) - voiceActorLanguagePriority(right.languageV2)
        ));

      if (voiceActors.length === 0) {
        return [{
          name: characterName,
          character: characterRole,
          image: '',
          characterName,
          characterRole,
          characterImage,
        }];
      }

      return voiceActors.slice(0, 4).map((voiceActor) => ({
        name: voiceActor.name?.full || 'Unknown voice actor',
        character: characterRole,
        image: pickImageUrl(voiceActor.image?.large, voiceActor.image?.medium),
        characterName,
        characterRole,
        characterImage,
        voiceActorName: voiceActor.name?.full || '',
        voiceActorImage: pickImageUrl(voiceActor.image?.large, voiceActor.image?.medium),
        voiceActorLanguage: voiceActor.languageV2 || '',
      }));
    });
  return {
    id: String(media.id),
    type: 'anime',
    title,
    genres: media.genres || [],
    description: stripHtml(media.description || ''),
    releaseInfo,
    released: releaseInfo,
    rating: score,
    runtime: typeof media.episodes === 'number' ? `${media.episodes} eps` : undefined,
    cast,
    posterUrl,
    backgroundUrl,
    logoUrl: '',
  };
}

function mapTmdbToCatalog(media: TmdbListResult, type: 'movie' | 'tv'): StremioPluginCatalogItem {
  const title = media.title || media.name || 'Unknown title';
  const releaseDate = type === 'movie' ? media.release_date : media.first_air_date;
  const releaseYear = yearFromDateValue(releaseDate || '');
  const releaseInfo = releaseYear ? String(releaseYear) : releaseDate || '';
  return {
    id: String(media.id),
    type,
    title,
    genres: (media.genre_ids || []).map((genreId) => String(genreId)),
    description: media.overview || '',
    releaseInfo,
    released: releaseInfo,
    rating: typeof media.vote_average === 'number' ? media.vote_average : undefined,
    posterUrl: tmdbImage(media.poster_path, 'w500'),
    backgroundUrl: tmdbImage(media.backdrop_path, 'w1280') || tmdbImage(media.poster_path, 'w1280'),
    logoUrl: '',
  };
}

function mapTmdbCredits(media: TmdbCreditsResponse | undefined, existing: StremioPluginCatalogItem): StremioPluginCatalogItem {
  if (!media?.cast?.length) return existing;
  const cast = media.cast
    .filter((person): person is Required<TmdbCreditsPerson> => Boolean(person?.name))
    .slice(0, 10)
    .map((person) => ({
      name: person.name || '',
      character: person.character || '',
      image: tmdbImage(person.profile_path, 'w185'),
    }));

  return {
    ...existing,
    cast,
  };
}

function makeCacheId(
  type: DiscoverType,
  section: DiscoverSection,
  query: string,
  genre = '',
  year = '',
  provider = '',
  region = DEFAULT_AVAILABILITY_REGION,
): CachedCacheId {
  if (!year.trim() && !provider.trim() && normalizeAvailabilityRegion(region) === DEFAULT_AVAILABILITY_REGION) {
    return `${type}:${section}:${query.trim().toLowerCase()}:${genre.trim().toLowerCase()}`;
  }
  return [type, section, query, genre, year, provider, region]
    .map((value) => encodeURIComponent(value.trim().toLowerCase()))
    .join(':');
}

function normalizeGenreFilter(value: string): string {
  return value.trim().toLowerCase();
}

function hasGenreMatch(item: StremioPluginCatalogItem, genreValue: string, type: DiscoverType): boolean {
  const normalizedGenre = normalizeGenreFilter(genreValue);
  if (!normalizedGenre) return true;
  if (type === 'anime') {
    return item.genres.some((genre) => normalizeGenreFilter(genre) === normalizedGenre);
  }
  return item.genres.includes(normalizedGenre);
}

function loadDiscoverCacheFromStorage(): DiscoverCacheState {
  const empty: DiscoverCacheState = {
    date: toLocalDateKey(),
    entries: {},
  };
  try {
    const raw = localStorage.getItem(DISCOVER_CACHE_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as DiscoverCacheState;
    if (!parsed || typeof parsed.date !== 'string' || parsed.date !== toLocalDateKey()) return empty;
    if (!parsed.entries || typeof parsed.entries !== 'object') return empty;
    return {
      date: parsed.date,
      entries: Object.fromEntries(
        Object.entries(parsed.entries).filter(([, cached]) =>
          typeof cached?.expiresAt === 'number'
          && Array.isArray(cached?.items),
        ),
      ),
    };
  } catch {
    return empty;
  }
}

async function requestTmdbJson<T>(path: string, credential: string, query: Record<string, string | number | boolean> = {}): Promise<T> {
  const normalized = normalizeTmdbCredential(credential);
  if (!normalized) {
    throw new Error('TMDB API key is missing. Add it in Settings → Metadata API keys.');
  }

  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  url.searchParams.set('language', 'en-US');
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const requestInit: RequestInit = isTMDBReadAccessToken(normalized)
    ? { headers: { Authorization: `Bearer ${normalized}` } }
    : { };
  if (!isTMDBReadAccessToken(normalized)) {
    url.searchParams.set('api_key', normalized);
  }

  const response = await fetch(url, requestInit);
  if (!response.ok) {
    throw new Error(`TMDB request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function discoverTmdbGenres(type: GenreSourceType, credential: string): Promise<GenreOption[]> {
  const response = await requestTmdbJson<TmdbGenreResponse>(`genre/${type}/list`, credential);
  return (response.genres || [])
    .map((genre): GenreOption => ({ label: genre.name, value: String(genre.id) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverTmdbProviders(
  type: GenreSourceType,
  region: AvailabilityRegion,
  credential: string,
): Promise<ProviderOption[]> {
  const response = await requestTmdbJson<TmdbProviderListResponse>(`watch/providers/${type}`, credential, {
    watch_region: region,
  });
  return (response.results || [])
    .filter((provider) => Number.isFinite(provider.provider_id) && Boolean(provider.provider_name?.trim()))
    .sort((left, right) => (
      providerPriority(left) - providerPriority(right)
      || (left.display_priority ?? Number.MAX_SAFE_INTEGER) - (right.display_priority ?? Number.MAX_SAFE_INTEGER)
      || left.provider_name.localeCompare(right.provider_name)
    ))
    .map((provider) => ({
      providerId: provider.provider_id,
      value: String(provider.provider_id),
      label: providerDisplayName(provider.provider_name),
      logoUrl: tmdbImage(provider.logo_path, 'w92'),
    }));
}

async function discoverAniListGenres(): Promise<GenreOption[]> {
  const response = await fetch(ANILIST_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: ANILIST_GENRE_QUERY }),
  });

  if (!response.ok) {
    throw new Error(`AniList request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as AniListGenreCollectionResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message || 'AniList request returned an error.');
  }

  const genres = payload.data?.GenreCollection || [];
  return genres
    .filter((genre): genre is string => typeof genre === 'string' && genre.trim().length > 0)
    .map((genre) => ({
      label: genre.trim(),
      value: genre.trim(),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

type TmdbCatalogFilters = {
  genre: string;
  year: string;
  provider: string;
  region: AvailabilityRegion;
};

function tmdbDiscoverySort(type: 'movie' | 'tv', section: DiscoverSection): string {
  if (section === 'top_rated') return 'vote_average.desc';
  if (section === 'new') return type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc';
  return 'popularity.desc';
}

function tmdbUsesDiscoveryFilters(filters: TmdbCatalogFilters): boolean {
  return Boolean(filters.genre || filters.year || filters.provider);
}

async function hasTmdbFlatrateProvider(
  type: 'movie' | 'tv',
  itemId: string,
  providerId: string,
  region: AvailabilityRegion,
  credential: string,
): Promise<boolean> {
  try {
    const response = await requestTmdbJson<TmdbWatchProviderDetailResponse>(`${type}/${itemId}/watch/providers`, credential);
    return Boolean(response.results?.[region]?.flatrate?.some((provider) => String(provider.provider_id) === providerId));
  } catch {
    return false;
  }
}

async function discoverMoviesOrTv(
  type: 'movie' | 'tv',
  section: DiscoverSection,
  query: string,
  credential: string,
  filters: TmdbCatalogFilters,
): Promise<readonly StremioPluginCatalogItem[]> {
  const normalizedQuery = query.trim();
  const isSearch = normalizedQuery.length > 0;
  const useDiscoveryEndpoint = !isSearch && tmdbUsesDiscoveryFilters(filters);
  const path = isSearch
    ? `search/${type}`
    : useDiscoveryEndpoint
      ? `discover/${type}`
      : TMDB_SECTION_ENDPOINTS[type][section];
  const discoveryQuery = useDiscoveryEndpoint
    ? {
      include_adult: false,
      sort_by: tmdbDiscoverySort(type, section),
      ...(filters.genre ? { with_genres: filters.genre } : {}),
      ...(filters.year
        ? type === 'movie'
          ? {
            'primary_release_date.gte': `${filters.year}-01-01`,
            'primary_release_date.lte': `${filters.year}-12-31`,
          }
          : {
            'first_air_date.gte': `${filters.year}-01-01`,
            'first_air_date.lte': `${filters.year}-12-31`,
          }
        : {}),
      ...(filters.provider
        ? {
          watch_region: filters.region,
          with_watch_providers: filters.provider,
          with_watch_monetization_types: 'flatrate',
        }
        : {}),
    }
    : {};

  const response = await requestTmdbJson<TmdbListResponse>(path, credential, {
    ...(isSearch ? { query: normalizedQuery, include_adult: false } : {}),
    ...discoveryQuery,
    page: 1,
  });
  let items = (response.results || [])
    .slice(0, DISCOVER_RESULT_LIMIT)
    .map((item) => mapTmdbToCatalog(item, type));

  if (isSearch) {
    items = items
      .filter((item) => hasGenreMatch(item, filters.genre, type))
      .filter((item) => hasYearMatch(item, filters.year));
    if (filters.provider) {
      const providerMatches = await Promise.all(items.map((item) => hasTmdbFlatrateProvider(
        type,
        item.id,
        filters.provider,
        filters.region,
        credential,
      )));
      items = items.filter((_, index) => providerMatches[index]);
    }
  }

  return items;
}

async function enrichCatalogItemWithTmdbCredits(
  item: StremioPluginCatalogItem,
  type: 'movie' | 'tv',
  credential: string,
): Promise<StremioPluginCatalogItem> {
  const response = await requestTmdbJson<TmdbDetailResponse>(`${type}/${item.id}`, credential, {
    append_to_response: 'credits',
  });
  return mapTmdbCredits(response.credits, {
    ...item,
    description: response.overview || item.description,
    posterUrl: response.poster_path ? tmdbImage(response.poster_path, 'w500') : item.posterUrl,
    backgroundUrl: response.backdrop_path
      ? tmdbImage(response.backdrop_path, 'w1280')
      : item.backgroundUrl || (response.poster_path ? tmdbImage(response.poster_path, 'w1280') : item.posterUrl),
    rating: typeof response.vote_average === 'number'
      ? response.vote_average
      : item.rating,
    genres: response.genres?.map((genre) => genre.name).filter(Boolean) || item.genres,
  });
}

async function discoverAnime(
  query: string,
  section: DiscoverSection,
  genre = '',
  year = '',
): Promise<readonly StremioPluginCatalogItem[]> {
  const response = await fetch(ANILIST_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query: ANILIST_DISCOVER_QUERY,
      variables: {
        page: 1,
        perPage: DISCOVER_RESULT_LIMIT,
        sort: ANILIST_SECTION_SORT[section],
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(genre.trim() ? { genre: genre.trim() } : {}),
        ...(year.trim() ? { seasonYear: Number(year) } : {}),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`AniList request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as AniListResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message || 'AniList request returned an error.');
  }

  const media = payload.data?.Page?.media || [];
  return media
    .slice(0, DISCOVER_RESULT_LIMIT)
    .map(mapAnilistToCatalog);
}

function insertShimmerStyle() {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('loom-discover-shimmer-style');
  if (existing) return;
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

type ThemeDropdownOption = {
  value: string;
  label: string;
  logoUrl?: string;
};

function ProviderLogo({ src, label }: { src?: string; label: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => {
    setFailedSrc(null);
  }, [src]);

  if (!src || failedSrc === src) {
    return (
      <span
        aria-hidden="true"
        className="grid h-6 w-6 shrink-0 place-items-center rounded bg-[var(--loom-surface-3)] text-[10px] font-semibold text-[var(--loom-muted)]"
      >
        {label.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className="h-6 w-6 shrink-0 rounded object-contain"
      onError={() => setFailedSrc(src)}
    />
  );
}

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
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = useMemo(
    () => options.find((option) => option.value === value)?.label || options[0]?.label || 'Select',
    [options, value],
  );

  const computeMenuStyle = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const buttonRect = button.getBoundingClientRect();
    setMenuStyle({
      left: buttonRect.left,
      top: buttonRect.bottom + 6,
      width: buttonRect.width,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    computeMenuStyle();
    const handleReposition = () => computeMenuStyle();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
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
          if (['Escape', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
            if (event.key === 'Escape') {
              setIsOpen(false);
              return;
            }
            event.preventDefault();
            setIsOpen(true);
          }
        }}
        className={`relative z-10 inline-flex h-8 min-w-[9rem] items-center gap-2 rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 pr-10 text-[var(--loom-text)] text-sm font-normal outline-none transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] ${buttonClassName || ''}`}
      >
        {selectedOption?.logoUrl !== undefined && <ProviderLogo src={selectedOption.logoUrl} label={selectedOption.label} />}
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
                {option.logoUrl !== undefined && <ProviderLogo src={option.logoUrl} label={option.label} />}
                <span className="truncate">{option.label}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default function PluginDiscover() {
  return <DiscoverCatalog mode="discover" />;
}

export function DiscoverCatalog({ mode = 'discover' }: { mode?: 'discover' | 'home' }) {
  const { theme } = useTheme();
  const { activeProfile } = useProfiles();
  const location = useLocation();
  const initialFilterState = useMemo(() => parseDiscoverFilterState(location.search), [location.search]);
  const isHome = mode === 'home';
  const routePath = isHome ? '/' : DISCOVER_ROUTE;
  const pageRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollTopRef = useRef(0);
  const discoverCache = useRef<DiscoverCacheState>(loadDiscoverCacheFromStorage());
  const initialRegion = normalizeAvailabilityRegion(initialFilterState.region);
  const initialYearFilter = initialFilterState.yearFilter.trim();
  const initialResolvedYearFilter = /^(19|20)\d{2}$/.test(initialYearFilter) ? initialYearFilter : '';
  const initialCacheId = makeCacheId(
    initialFilterState.contentType,
    initialFilterState.section,
    initialFilterState.query,
    normalizeGenreFilter(initialFilterState.genreFilter),
    initialResolvedYearFilter,
    initialFilterState.platformFilter,
    initialRegion,
  );
  const initialCachedItems = getValidCachedItems(discoverCache.current, initialCacheId);
  const [tmdbCredential, setTmdbCredential] = useState('');
  const [query, setQuery] = useState(initialFilterState.query);
  const [contentType, setContentType] = useState<DiscoverType>(initialFilterState.contentType);
  const [section, setSection] = useState<DiscoverSection>(initialFilterState.section);
  const [genreFilter, setGenreFilter] = useState(initialFilterState.genreFilter);
  const [genreOptions, setGenreOptions] = useState<GenreOption[]>([]);
  const [yearFilter, setYearFilter] = useState(initialResolvedYearFilter);
  const [platformFilter, setPlatformFilter] = useState(initialFilterState.platformFilter);
  const [availabilityRegion, setAvailabilityRegion] = useState<AvailabilityRegion>(initialRegion);
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([]);
  const [providerOptionsLoading, setProviderOptionsLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [items, setItems] = useState<readonly StremioPluginCatalogItem[]>(() => initialCachedItems
    ? initialCachedItems.filter((item) => hasYearMatch(item, initialResolvedYearFilter))
    : []);
  const [loading, setLoading] = useState(() => !initialCachedItems);
  const [error, setError] = useState<string | null>(null);
  const catalogRequestRevision = useRef(0);
  const searchTimer = useRef<number | null>(null);
  const queryRef = useRef('');
  const genreRef = useRef('');
  const yearRef = useRef('');
  const platformRef = useRef('');
  const regionRef = useRef<AvailabilityRegion>(initialRegion);
  const detailsCache = useRef(new Map<string, Promise<StremioPluginCatalogItem>>());
  const providerOptionsCache = useRef<Record<string, ProviderOption[]>>({});
  const providerLoadTracker = useRef<Record<string, Promise<ProviderOption[]> | null>>({});
  const regionWasExplicitRef = useRef(Boolean(initialFilterState.region.trim()));
  const genreOptionsCache = useRef<Record<DiscoverType, GenreOption[]>>({
    movie: [],
    tv: [],
    anime: [],
  });
  const activeContentTypeRef = useRef<DiscoverType>(contentType);
  const previousContentTypeRef = useRef<DiscoverType>(contentType);
  const genreLoadTracker = useRef<Record<DiscoverType, Promise<GenreOption[]> | null>>({
    movie: null,
    tv: null,
    anime: null,
  });
  const navigate = useNavigate();

  const availableSections = useMemo(() => DISCOVER_SECTIONS[contentType], [contentType]);
  const yearOptions = useMemo(() => releaseYearOptions(), []);
  const isModern = theme.homeStyle === 'modern';
  const frameClass = isModern ? 'loom-modern-content-frame' : 'loom-frame';
  const topPaddingClass = isModern ? 'pt-28' : 'pt-24';
  const currentSearch = location.search.startsWith('?') ? location.search.slice(1) : location.search;
  const viewStateStorageKey = isHome ? 'loomtv:home-discover-view-state-v1' : DISCOVER_VIEW_STATE_STORAGE_KEY;

  useEffect(() => {
    const nextSearch = buildDiscoverSearch({
      contentType,
      section,
      genreFilter,
      yearFilter,
      platformFilter,
      region: availabilityRegion,
      query,
    });
    if (nextSearch === currentSearch) return;
    void navigate(
      {
        pathname: routePath,
        search: nextSearch ? `?${nextSearch}` : '',
      },
      { replace: true },
    );
  }, [availabilityRegion, contentType, genreFilter, platformFilter, query, currentSearch, navigate, routePath, section, yearFilter]);

  useEffect(() => {
    let isActive = true;
    void (async () => {
      try {
        const settings = await desktopApi.getSettings();
        if (!isActive) return;
        setTmdbCredential(normalizeTmdbCredential(settings.metadataApiKeys?.tmdb || settings.tmdbApiKey || ''));
        if (!regionWasExplicitRef.current && activeProfile?.id) {
          try {
            const restrictions = await desktopApi.getProfileRestrictions(activeProfile.id);
            if (isActive) setAvailabilityRegion(normalizeAvailabilityRegion(restrictions.country));
          } catch {
            // US remains the conservative availability fallback.
          }
        }
      } catch (settingsError) {
        if (!isActive) return;
        setError(errorMessage(settingsError));
      }
    })();
    return () => {
      isActive = false;
    };
  }, [activeProfile?.id]);

  useEffect(() => {
    if (!pageRef.current) return;
    try {
      const raw = sessionStorage.getItem(viewStateStorageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { search?: string; scrollTop?: number };
      if (saved.search !== location.search || typeof saved.scrollTop !== 'number' || !Number.isFinite(saved.scrollTop) || saved.scrollTop <= 0) {
        return;
      }
      pendingScrollTopRef.current = Math.max(0, saved.scrollTop);
    } catch {
      // Ignore invalid or unavailable storage state.
    }
  }, [location.search, viewStateStorageKey]);

  useEffect(() => {
    if (loading || items.length === 0 || pendingScrollTopRef.current <= 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const page = pageRef.current;
      if (!page) return;
      page.scrollTop = pendingScrollTopRef.current;
      pendingScrollTopRef.current = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [items.length, loading, location.search]);

  useEffect(() => {
    const page = pageRef.current;
    return () => {
      if (!page) return;
      try {
        sessionStorage.setItem(
          viewStateStorageKey,
          JSON.stringify({
            search: location.search,
            scrollTop: page.scrollTop,
          }),
        );
      } catch {
        // Ignore storage persistence failures.
      }
    };
  }, [location.search, viewStateStorageKey]);

  useEffect(() => {
    insertShimmerStyle();
  }, []);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    activeContentTypeRef.current = contentType;
  }, [contentType]);

  useEffect(() => {
    genreRef.current = genreFilter;
  }, [genreFilter]);

  useEffect(() => {
    yearRef.current = yearFilter;
  }, [yearFilter]);

  useEffect(() => {
    platformRef.current = platformFilter;
  }, [platformFilter]);

  useEffect(() => {
    regionRef.current = availabilityRegion;
  }, [availabilityRegion]);

  const getCachedItems = useCallback((cacheId: CachedCacheId): readonly StremioPluginCatalogItem[] | null => {
    const now = Date.now();
    const today = toLocalDateKey();
    const cache = discoverCache.current;
    if (cache.date !== today) {
      discoverCache.current = { date: today, entries: {} };
      try {
        localStorage.removeItem(DISCOVER_CACHE_STORAGE_KEY);
      } catch {
        // Ignore cache storage failures, fallback to memory cache only.
      }
      return null;
    }

    const cached = getValidCachedItems(cache, cacheId, now);
    if (!cached) {
      const entry = cache.entries[cacheId];
      const shouldCleanEntry = Boolean(entry && entry.expiresAt >= now && !hasCachedImageCandidate(entry.items));
      if (shouldCleanEntry) {
        delete cache.entries[cacheId];
        try {
          localStorage.setItem(DISCOVER_CACHE_STORAGE_KEY, JSON.stringify(cache));
        } catch {
          // Ignore cache cleanup persistence failures.
        }
      }
      return null;
    }
    return cached.items;
  }, []);

  const setCachedItems = useCallback((cacheId: CachedCacheId, nextItems: readonly StremioPluginCatalogItem[]) => {
    const today = toLocalDateKey();
    if (discoverCache.current.date !== today) {
      discoverCache.current = { date: today, entries: {} };
    }

    discoverCache.current.entries[cacheId] = {
      expiresAt: nextMidnightAt(),
      items: [...nextItems],
    };

    try {
      localStorage.setItem(DISCOVER_CACHE_STORAGE_KEY, JSON.stringify(discoverCache.current));
    } catch {
      // Ignore persistence failures.
    }
  }, []);

  const ensureGenreOptions = useCallback(async (type: DiscoverType) => {
    const cached = genreOptionsCache.current[type];
    if (cached.length > 0) {
      setGenreOptions(cached);
      return;
    }

    if (genreLoadTracker.current[type]) {
      const inFlight = genreLoadTracker.current[type];
      if (!inFlight) return;
      try {
        const options = await inFlight;
        if (type === activeContentTypeRef.current) {
          setGenreOptions(options);
        }
      } catch {
        if (type === activeContentTypeRef.current) {
          setGenreOptions([]);
        }
      }
      return;
    }

    const loader = type === 'anime'
      ? discoverAniListGenres()
      : (async () => {
        if (!tmdbCredential) return [] as GenreOption[];
        return discoverTmdbGenres(type, tmdbCredential);
      })();

    genreLoadTracker.current[type] = loader;
    try {
      const options = await loader;
      genreLoadTracker.current[type] = null;
      genreOptionsCache.current = {
        ...genreOptionsCache.current,
        [type]: [...options],
      };
      if (type === activeContentTypeRef.current) {
        setGenreOptions(options);
      }
    } catch {
      genreLoadTracker.current[type] = null;
      if (type === activeContentTypeRef.current) {
        setGenreOptions([]);
      }
    }
  }, [tmdbCredential]);

  const ensureProviderOptions = useCallback(async (type: GenreSourceType, region: AvailabilityRegion) => {
    const cacheKey = `${type}:${region}`;
    const cached = providerOptionsCache.current[cacheKey];
    if (cached) {
      if (type === activeContentTypeRef.current && region === regionRef.current) setProviderOptions(cached);
      return;
    }

    const inFlight = providerLoadTracker.current[cacheKey];
    if (inFlight) {
      try {
        const options = await inFlight;
        if (type === activeContentTypeRef.current && region === regionRef.current) setProviderOptions(options);
      } catch {
        // The original request owns the visible provider error state.
      }
      return;
    }

    if (!tmdbCredential) {
      if (type === activeContentTypeRef.current && region === regionRef.current) setProviderOptions([]);
      return;
    }

    const loader = discoverTmdbProviders(type, region, tmdbCredential);
    providerLoadTracker.current[cacheKey] = loader;
    if (type === activeContentTypeRef.current && region === regionRef.current) {
      setProviderOptionsLoading(true);
      setProviderError(null);
    }
    try {
      const options = await loader;
      providerOptionsCache.current[cacheKey] = [...options];
      if (type === activeContentTypeRef.current && region === regionRef.current) {
        setProviderOptions(options);
        setProviderOptionsLoading(false);
        setPlatformFilter((current) => current && !options.some((option) => option.value === current) ? '' : current);
      }
    } catch (loadError) {
      if (type === activeContentTypeRef.current && region === regionRef.current) {
        setProviderOptions([]);
        setProviderOptionsLoading(false);
        setProviderError(errorMessage(loadError));
      }
    } finally {
      providerLoadTracker.current[cacheKey] = null;
    }
  }, [tmdbCredential]);

  useEffect(() => {
    const contentTypeChanged = previousContentTypeRef.current !== contentType;
    previousContentTypeRef.current = contentType;
    if (contentTypeChanged) {
      setSection('trending');
      setGenreFilter('');
      setYearFilter('');
      setPlatformFilter('');
      detailsCache.current.clear();
      setError(null);
    }
    const cachedGenres = genreOptionsCache.current[contentType];
    setGenreOptions(cachedGenres);
    if (cachedGenres.length === 0) {
      void ensureGenreOptions(contentType);
    }
  }, [contentType, ensureGenreOptions]);

  useEffect(() => {
    setProviderError(null);
    if (contentType === 'anime') {
      setProviderOptions([]);
      return;
    }
    void ensureProviderOptions(contentType, availabilityRegion);
  }, [availabilityRegion, contentType, ensureProviderOptions]);

  useEffect(() => {
    if (contentType === 'anime') return;
    if (!tmdbCredential) return;
    if (genreOptionsCache.current[contentType].length > 0) return;
    void ensureGenreOptions(contentType);
  }, [contentType, tmdbCredential, ensureGenreOptions]);

  const loadCatalog = useCallback(async (
    searchValue = '',
    genre = genreFilter,
    year = yearFilter,
    provider = platformFilter,
    region = availabilityRegion,
  ) => {
    const requestRevision = ++catalogRequestRevision.current;
    const trimmedQuery = searchValue.trim();
    const normalizedGenre = normalizeGenreFilter(genre);
    const providerGenre = contentType === 'anime'
      ? genreOptions.find((option) => normalizeGenreFilter(option.value) === normalizedGenre)?.value || genre.trim()
      : normalizedGenre;
    const normalizedYear = year.trim();
    const normalizedProvider = provider.trim();
    const normalizedRegion = normalizeAvailabilityRegion(region);
    const cacheId = makeCacheId(
      contentType,
      section,
      trimmedQuery,
      normalizedGenre,
      normalizedYear,
      normalizedProvider,
      normalizedRegion,
    );
    const cached = getCachedItems(cacheId);
    if (cached) {
      if (requestRevision !== catalogRequestRevision.current) return;
      setItems(cached);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let nextItems: readonly StremioPluginCatalogItem[];
      if (contentType === 'anime') {
        nextItems = await discoverAnime(trimmedQuery, section, providerGenre, normalizedYear);
      } else {
        if (!tmdbCredential) {
          throw new Error('TMDB API key is missing. Add it in Settings → Metadata API keys before browsing Movies or TV.');
        }
        nextItems = await discoverMoviesOrTv(contentType, section, trimmedQuery, tmdbCredential, {
          genre: normalizedGenre,
          year: normalizedYear,
          provider: normalizedProvider,
          region: normalizedRegion,
        });
      }

      const filteredItems = nextItems
        .filter((item) => hasGenreMatch(item, normalizedGenre, contentType))
        .filter((item) => hasYearMatch(item, normalizedYear));
      if (requestRevision !== catalogRequestRevision.current) return;
      setItems(filteredItems);
      setCachedItems(cacheId, filteredItems);
    } catch (loadError) {
      if (requestRevision !== catalogRequestRevision.current) return;
      setItems([]);
      setError(errorMessage(loadError));
    } finally {
      if (requestRevision === catalogRequestRevision.current) setLoading(false);
    }
  }, [availabilityRegion, contentType, genreFilter, genreOptions, getCachedItems, platformFilter, section, setCachedItems, tmdbCredential, yearFilter]);

  useEffect(() => {
    if (searchTimer.current !== null) {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    catalogRequestRevision.current += 1;
    const cacheId = makeCacheId(
      contentType,
      section,
      query,
      normalizeGenreFilter(genreFilter),
      yearFilter,
      platformFilter,
      availabilityRegion,
    );
    if (getCachedItems(cacheId)) {
      void loadCatalog(query, genreFilter, yearFilter, platformFilter, availabilityRegion);
      return () => {
        catalogRequestRevision.current += 1;
      };
    }

    setLoading(true);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      void loadCatalog(query, genreFilter, yearFilter, platformFilter, availabilityRegion);
    }, PROVIDER_SEARCH_DEBOUNCE_MS);

    return () => {
      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
        searchTimer.current = null;
      }
      catalogRequestRevision.current += 1;
    };
  }, [availabilityRegion, contentType, genreFilter, getCachedItems, loadCatalog, platformFilter, query, section, tmdbCredential, yearFilter]);

  useEffect(() => {
    const now = Date.now();
    const delayMs = Math.max(1_000, nextMidnightAt(new Date(now)) - now);
    const timer = window.setTimeout(() => {
      discoverCache.current = { date: toLocalDateKey(), entries: {} };
      try {
        localStorage.removeItem(DISCOVER_CACHE_STORAGE_KEY);
      } catch {
        // Ignore cache storage failures.
      }
      void loadCatalog(queryRef.current, genreRef.current, yearRef.current, platformRef.current, regionRef.current);
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [loadCatalog]);

  const enrichWithCast = useCallback(async (item: StremioPluginCatalogItem): Promise<StremioPluginCatalogItem> => {
    if (!tmdbCredential || item.type === 'anime') return item;
    const cacheKey = `detail:${item.type}:${item.id}`;
    const existing = detailsCache.current.get(cacheKey);
    if (existing) return existing;

    if (item.type !== 'movie' && item.type !== 'tv') return item;
    const pending = enrichCatalogItemWithTmdbCredits(item, item.type, tmdbCredential)
      .catch(() => item);
    detailsCache.current.set(cacheKey, pending);
    const resolved = await pending;
    detailsCache.current.set(cacheKey, Promise.resolve(resolved));
    return resolved;
  }, [tmdbCredential]);

  const openItemDetails = useCallback((item: StremioPluginCatalogItem) => {
    void (async () => {
      const nextItem = await enrichWithCast(item);
      const discoverSourceRoute = location.search
        ? `${routePath}${location.search}`
        : routePath;
      cacheDiscoverReturnRoute(discoverSourceRoute);
      cacheExploreItem(nextItem);
      const detailPath = nextItem.type === 'movie'
        ? `/movie/${nextItem.id}`
        : nextItem.type === 'anime'
          ? `/anime/${nextItem.id}`
          : `/tv/${nextItem.id}`;
      navigate(detailPath, {
        state: {
          from: discoverSourceRoute,
          fromDiscover: true,
          stremioCatalogItem: nextItem,
        },
      });
    })();
  }, [enrichWithCast, location.search, navigate, routePath]);

  const chipClass = (isActive: boolean) => `h-8 shrink-0 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${
    isActive
      ? 'border border-[var(--loom-accent)] bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]'
      : 'border border-[var(--loom-border)] bg-[var(--loom-surface-2)] text-[var(--loom-text)] hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)]'
  }`;

  const gridEntries = useMemo<GridEntry[]>(() => items.map((item) => ({ id: `${item.type}:${item.id}`, item })), [items]);
  const providerDropdownOptions = useMemo<ThemeDropdownOption[]>(() => [
    { value: '', label: providerOptionsLoading ? 'Loading platforms…' : 'All platforms' },
    ...providerOptions.map((provider) => ({
      value: provider.value,
      label: provider.label,
      logoUrl: provider.logoUrl,
    })),
  ], [providerOptions, providerOptionsLoading]);
  const regionDropdownOptions = useMemo<ThemeDropdownOption[]>(() => AVAILABILITY_REGIONS.map((region) => ({
    value: region,
    label: region === DEFAULT_AVAILABILITY_REGION ? `${region} · Default` : region,
  })), []);
  const activeProviderLabel = providerOptions.find((provider) => provider.value === platformFilter)?.label || 'the selected platform';
  const emptyStateMessage = yearFilter
    ? `No ${DISCOVER_TYPE_LABELS[contentType].toLowerCase()} match release year ${yearFilter}${genreFilter ? ' and the selected genre' : ''}${platformFilter ? ` while streaming on ${activeProviderLabel}` : ''}. Try another release year or clear the filters.`
    : genreFilter
      ? `No ${DISCOVER_TYPE_LABELS[contentType].toLowerCase()} match the selected genre in this provider catalog.`
      : platformFilter
        ? `No ${DISCOVER_TYPE_LABELS[contentType].toLowerCase()} are listed as streaming on ${activeProviderLabel} in ${availabilityRegion}.`
        : 'No titles returned for this selection.';
  const historicalTrendingNote = yearFilter && section === 'trending'
    ? contentType === 'anime'
      ? 'Release year is applied by AniList; Trending remains the provider’s current ranking, not a historical trend snapshot.'
      : 'Release year is applied by TMDB; historical Trending is not available, so filtered results use popularity ordering.'
    : '';

  return (
    <div ref={pageRef} className={isHome ? 'mt-10' : 'loom-page loom-library-page h-full overflow-y-auto'}>
      {!isHome && (
        <LibrarySearch
          value={query}
          onChange={setQuery}
          placeholder="Search titles"
        />
      )}
      <div className={`${frameClass} ${isHome ? 'rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-5 sm:p-6' : 'loom-library-page-frame page-bottom-safe page-list-bottom-safe'} ${isHome ? 'pt-0' : topPaddingClass}`}>
        <header className="loom-library-page-heading mb-6 flex min-h-8 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-[var(--loom-text)]">{isHome ? 'Browse more titles' : 'Discover'}</h1>
            <p className="mt-1 text-sm text-[var(--loom-muted)]">
              {isHome ? 'Browse provider catalogs without leaving Home.' : 'Discover new anime, TV shows, and movies to watch.'}
            </p>
          </div>
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
              <span
                aria-hidden="true"
                className="mx-1 inline-block h-6 w-px self-center bg-[var(--loom-border)] my-auto opacity-90"
              />
              <ThemeDropdown
                id="discover-section-select"
                label="Discover filter"
                value={section}
                options={availableSections.map((discoverSection) => ({
                  value: discoverSection,
                  label: DISCOVER_SECTION_LABELS[discoverSection],
                }))}
                onChange={(value) => setSection(value as DiscoverSection)}
              />

              <ThemeDropdown
                id="discover-genre-select"
                label="Filter genre"
                value={genreFilter}
                options={[{ value: '', label: 'All Genres' }, ...genreOptions]}
                onChange={(value) => setGenreFilter(value)}
              />
              <ThemeDropdown
                id="discover-year-select"
                label="Filter year"
                value={yearFilter}
                options={[{ value: '', label: 'All release years' }, ...yearOptions.map((year) => ({ value: year, label: year }))]
                }
                onChange={setYearFilter}
              />
              {contentType !== 'anime' ? (
                <>
                  <ThemeDropdown
                    id="discover-platform-select"
                    label={`Streaming on in ${availabilityRegion}`}
                    value={platformFilter}
                    options={providerDropdownOptions}
                    onChange={setPlatformFilter}
                  />
                  <ThemeDropdown
                    id="discover-region-select"
                    label="Streaming availability region"
                    value={availabilityRegion}
                    options={regionDropdownOptions}
                    onChange={(value) => {
                      regionWasExplicitRef.current = true;
                      setAvailabilityRegion(normalizeAvailabilityRegion(value));
                    }}
                  />
                </>
              ) : (
                <span className="inline-flex h-8 items-center rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 text-xs text-[var(--loom-muted)]" title="AniList does not provide region-aware streaming-provider availability.">
                  Streaming availability unavailable for Anime
                </span>
              )}
            </div>
            {providerError && contentType !== 'anime' && (
              <p role="status" className="mt-2 text-xs text-[var(--loom-muted)]">Streaming platforms could not be loaded for {availabilityRegion}; browse filters remain available.</p>
            )}
            {historicalTrendingNote && <p className="mt-2 text-xs text-[var(--loom-muted)]">{historicalTrendingNote}</p>}
          </div>
        </header>

        {error && (
          <div role="alert" className="mt-4 rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <p className="flex items-start gap-2">
              <Compass className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          </div>
        )}

        {loading ? (
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
            {Array.from({ length: 18 }).map((_, index) => (
              <DiscoverShimmerCard key={index} />
            ))}
          </div>
        ) : gridEntries.length === 0 ? (
          <p className="mt-10 text-center text-sm text-[var(--loom-muted)]">{emptyStateMessage}</p>
        ) : (
          <VirtualPosterGrid
            items={gridEntries}
            renderItem={(entry) => (
              <StremioPosterCard
                item={entry.item}
                metaLine={stremioMetaLine(entry.item)}
                onSelect={(selected) => {
                  void openItemDetails(selected);
                }}
              />
            )}
          />
        )}
      </div>
    </div>
  );
}
