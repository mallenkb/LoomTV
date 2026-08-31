import { movieHitMatchesLocal, tmdbLogoCandidates, uniqueLocalTitles, uniqueMetadataSearchHits, yearFromDateString } from './helpers.ts';
import type { ContentRating, EpisodeMeta, MediaItem, StreamingOfferType, StreamingProvider } from './types.ts';
import { safeFetch } from '../safeFetch.ts';
import { normalizeContentRating } from './contentRatings.ts';
import { preferredProviderLogoUrl } from '../../shared/providerLogos.ts';
import { z } from 'zod';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

export interface TMDBTVResult extends Partial<MediaItem> {
  episodes?: EpisodeMeta[];
  tmdbSeasons?: { number: number; title: string; episodeCount: number }[];
}

interface TMDBPerson {
  name?: string;
  character?: string;
  profile_path?: string | null;
}

interface TMDBGenre {
  name?: string;
}

interface TMDBExternalIds {
  imdb_id?: string;
  tvdb_id?: string | number;
}

interface TMDBSeasonSummary {
  season_number?: number;
  name?: string;
  episode_count?: number;
}

interface TMDBEpisode {
  season_number?: number;
  episode_number?: number;
  name?: string;
  overview?: string;
  still_path?: string | null;
  vote_average?: number;
  air_date?: string;
}

interface TMDBVideo {
  key?: string;
  site?: string;
  type?: string;
  official?: boolean;
}

interface TMDBImage {
  file_path?: string | null;
  iso_639_1?: string | null;
  vote_average?: number;
}

interface TMDBWatchProvider {
  provider_id?: number;
  provider_name?: string;
  logo_path?: string | null;
  display_priority?: number;
}

interface TMDBWatchProviderRegion {
  link?: string;
  flatrate?: TMDBWatchProvider[];
  ads?: TMDBWatchProvider[];
  free?: TMDBWatchProvider[];
  rent?: TMDBWatchProvider[];
  buy?: TMDBWatchProvider[];
}

interface TMDBWatchProviderResponse {
  results?: Record<string, TMDBWatchProviderRegion>;
}

interface TMDBMedia {
  id?: number;
  title?: string;
  name?: string;
  original_title?: string;
  imdb_id?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  runtime?: number;
  number_of_seasons?: number;
  number_of_episodes?: number;
  episode_run_time?: number[];
  release_date?: string;
  first_air_date?: string;
  genres?: TMDBGenre[];
  credits?: { cast?: TMDBPerson[] };
  external_ids?: TMDBExternalIds;
  images?: {
    posters?: TMDBImage[];
    backdrops?: TMDBImage[];
    logos?: TMDBImage[];
  };
  seasons?: TMDBSeasonSummary[];
  release_dates?: {
    results?: Array<{ iso_3166_1?: string; release_dates?: Array<{ certification?: string }> }>;
  };
  content_ratings?: {
    results?: Array<{ iso_3166_1?: string; rating?: string }>;
  };
  'watch/providers'?: TMDBWatchProviderResponse;
  videos?: { results?: TMDBVideo[] };
}

interface TMDBSearchResponse {
  results?: TMDBMedia[];
}

interface TMDBSeasonResponse {
  episodes?: TMDBEpisode[];
}

const tmdbPersonSchema: z.ZodType<TMDBPerson> = z.object({
  name: z.string().optional(),
  character: z.string().optional(),
  profile_path: z.string().nullable().optional(),
});

const tmdbGenreSchema: z.ZodType<TMDBGenre> = z.object({ name: z.string().optional() });
const tmdbSeasonSummarySchema: z.ZodType<TMDBSeasonSummary> = z.object({
  season_number: z.number().finite().optional(),
  name: z.string().optional(),
  episode_count: z.number().finite().nonnegative().optional(),
});
const tmdbEpisodeSchema: z.ZodType<TMDBEpisode> = z.object({
  season_number: z.number().finite().optional(),
  episode_number: z.number().finite().optional(),
  name: z.string().optional(),
  overview: z.string().optional(),
  still_path: z.string().nullable().optional(),
  vote_average: z.number().finite().optional(),
  air_date: z.string().optional(),
});
const tmdbVideoSchema: z.ZodType<TMDBVideo> = z.object({
  key: z.string().optional(),
  site: z.string().optional(),
  type: z.string().optional(),
  official: z.boolean().optional(),
});
const tmdbImageSchema: z.ZodType<TMDBImage> = z.object({
  file_path: z.string().nullable().optional(),
  iso_639_1: z.string().nullable().optional(),
  vote_average: z.number().finite().optional(),
});
const tmdbWatchProviderSchema: z.ZodType<TMDBWatchProvider> = z.object({
  provider_id: z.number().finite().optional(),
  provider_name: z.string().optional(),
  logo_path: z.string().nullable().optional(),
  display_priority: z.number().finite().optional(),
});
const tmdbWatchProviderRegionSchema: z.ZodType<TMDBWatchProviderRegion> = z.object({
  flatrate: z.array(tmdbWatchProviderSchema).optional(),
  ads: z.array(tmdbWatchProviderSchema).optional(),
  free: z.array(tmdbWatchProviderSchema).optional(),
});
const tmdbWatchProviderResponseSchema: z.ZodType<TMDBWatchProviderResponse> = z.object({
  results: z.record(z.string(), tmdbWatchProviderRegionSchema).optional(),
});
const tmdbMediaSchema: z.ZodType<TMDBMedia> = z.object({
  id: z.number().finite().optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  original_title: z.string().optional(),
  imdb_id: z.string().optional(),
  poster_path: z.string().nullable().optional(),
  backdrop_path: z.string().nullable().optional(),
  overview: z.string().optional(),
  vote_average: z.number().finite().optional(),
  runtime: z.number().finite().nonnegative().optional(),
  number_of_seasons: z.number().finite().nonnegative().optional(),
  number_of_episodes: z.number().finite().nonnegative().optional(),
  episode_run_time: z.array(z.number().finite().nonnegative()).optional(),
  release_date: z.string().optional(),
  first_air_date: z.string().optional(),
  genres: z.array(tmdbGenreSchema).optional(),
  credits: z.object({ cast: z.array(tmdbPersonSchema).optional() }).optional(),
  external_ids: z.object({
    imdb_id: z.string().optional(),
    tvdb_id: z.union([z.string(), z.number().finite()]).optional(),
  }).optional(),
  images: z.object({
    posters: z.array(tmdbImageSchema).optional(),
    backdrops: z.array(tmdbImageSchema).optional(),
    logos: z.array(tmdbImageSchema).optional(),
  }).optional(),
  seasons: z.array(tmdbSeasonSummarySchema).optional(),
  release_dates: z.object({
    results: z.array(z.object({
      iso_3166_1: z.string().optional(),
      release_dates: z.array(z.object({ certification: z.string().optional() })).optional(),
    })).optional(),
  }).optional(),
  content_ratings: z.object({
    results: z.array(z.object({
      iso_3166_1: z.string().optional(),
      rating: z.string().optional(),
    })).optional(),
  }).optional(),
  'watch/providers': tmdbWatchProviderResponseSchema.optional(),
  videos: z.object({ results: z.array(tmdbVideoSchema).optional() }).optional(),
});
const tmdbSearchResponseSchema: z.ZodType<TMDBSearchResponse> = z.object({
  results: z.array(tmdbMediaSchema).optional(),
});
const tmdbSeasonResponseSchema: z.ZodType<TMDBSeasonResponse> = z.object({
  episodes: z.array(tmdbEpisodeSchema).optional(),
});

function normalizeTMDBCredential(value: string): string {
  return value.trim().replace(/^Bearer\s+/i, '');
}

function isTMDBReadAccessToken(value: string): boolean {
  const candidate = value.trim();
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate);
}

async function fetchTMDBJson<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  tmdbCredential?: string,
): Promise<z.output<TSchema> | null> {
  const credential = normalizeTMDBCredential(tmdbCredential || '');
  if (!credential) return null;

  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  url.searchParams.set('language', 'en-US');

  const requestInit: RequestInit = {};
  if (isTMDBReadAccessToken(credential)) {
    requestInit.headers = {
      Authorization: `Bearer ${credential}`,
    };
  } else {
    url.searchParams.set('api_key', credential);
  }

  const response = await safeFetch(url, requestInit, { allowedHosts: ['api.themoviedb.org'], retries: 2 });
  if (!response.ok) {
    throw new Error(`TMDB request failed with ${response.status}`);
  }

  return schema.parse(await response.json());
}

function tmdbSearchResults(searchData: TMDBSearchResponse | null): TMDBMedia[] {
  const results = searchData?.results;
  return Array.isArray(results) ? results : [];
}

function tmdbPoster(path: string | null | undefined): string {
  return path ? `${TMDB_IMAGE_BASE}/original${path}` : '';
}
function tmdbBackdrop(path: string | null | undefined): string {
  return path ? `${TMDB_IMAGE_BASE}/original${path}` : '';
}

function tmdbArtworkCandidates(
  primaryPath: string | null | undefined,
  images: TMDBImage[] | undefined,
): string[] {
  const orderedPaths = [
    primaryPath,
    ...(images || [])
      .filter((image) => image.file_path)
      .sort((left, right) => {
        const leftLanguage = left.iso_639_1 === 'en' ? 1 : left.iso_639_1 === null ? 0 : -1;
        const rightLanguage = right.iso_639_1 === 'en' ? 1 : right.iso_639_1 === null ? 0 : -1;
        return rightLanguage - leftLanguage
          || (right.vote_average || 0) - (left.vote_average || 0);
      })
      .map((image) => image.file_path),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return [...new Set(orderedPaths)]
    .map((candidate) => `${TMDB_IMAGE_BASE}/original${candidate}`)
    .slice(0, 20);
}

function tmdbPosterCandidates(d: TMDBMedia): string[] {
  return tmdbArtworkCandidates(d.poster_path, d.images?.posters);
}

function tmdbBackdropCandidates(d: TMDBMedia): string[] {
  return tmdbArtworkCandidates(d.backdrop_path, d.images?.backdrops);
}

function tmdbContentRatings(d: TMDBMedia): Record<string, ContentRating> {
  const ratings: Record<string, ContentRating> = {};
  const accept = (country?: string, code?: string) => {
    const normalized = normalizeContentRating(country || '', code, 'tmdb');
    if (!normalized || !country) return;
    if (!ratings[country] || normalized.minimumAge > ratings[country].minimumAge) ratings[country] = normalized;
  };
  for (const result of d.release_dates?.results || []) {
    for (const release of result.release_dates || []) accept(result.iso_3166_1, release.certification);
  }
  for (const result of d.content_ratings?.results || []) accept(result.iso_3166_1, result.rating);
  return ratings;
}

function tmdbTrailerUrl(d: TMDBMedia): string {
  const videos = d.videos?.results || [];
  const trailer = [...videos]
    .filter((video) => video.key && video.site?.toLowerCase() === 'youtube')
    .sort((left, right) => {
      const score = (video: TMDBVideo) => (
        (video.type?.toLowerCase() === 'trailer' ? 2 : 0)
        + (video.official ? 1 : 0)
      );
      return score(right) - score(left);
    })[0];
  return trailer?.key
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(trailer.key)}`
    : '';
}

function systemRegionCode(): string {
  try {
    return new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).region || 'US';
  } catch {
    return 'US';
  }
}

function tmdbStreamingProvidersFromResponse(
  response: TMDBWatchProviderResponse | null | undefined,
  regionCode = systemRegionCode(),
): StreamingProvider[] {
  type ProviderAggregate = {
    provider: TMDBWatchProvider & { provider_id: number; provider_name: string };
    regions: Set<string>;
    offerTypes: Set<StreamingOfferType>;
    priority: number;
  };

  const preferredRegion = regionCode.trim().toUpperCase() || 'US';
  const aggregates = new Map<number, ProviderAggregate>();
  const offerGroups: Array<[
    'flatrate' | 'free' | 'ads' | 'rent' | 'buy',
    StreamingOfferType,
  ]> = [
    ['flatrate', 'subscription'],
    ['free', 'free'],
    ['ads', 'ads'],
    ['rent', 'rent'],
    ['buy', 'buy'],
  ];

  for (const [region, availability] of Object.entries(response?.results || {})) {
    for (const [group, offerType] of offerGroups) {
      const providers = availability[group];
      if (!Array.isArray(providers)) continue;
      for (const provider of providers) {
        if (!Number.isFinite(provider.provider_id) || !provider.provider_name?.trim()) continue;
        const id = provider.provider_id as number;
        const existing = aggregates.get(id);
        const aggregate = existing || {
          provider: provider as ProviderAggregate['provider'],
          regions: new Set<string>(),
          offerTypes: new Set<StreamingOfferType>(),
          priority: Number.MAX_SAFE_INTEGER,
        };
        aggregate.regions.add(region.toUpperCase());
        aggregate.offerTypes.add(offerType);
        aggregate.priority = Math.min(
          aggregate.priority,
          provider.display_priority ?? Number.MAX_SAFE_INTEGER,
        );
        aggregates.set(id, aggregate);
      }
    }
  }

  const offerPriority = (offerTypes: Set<StreamingOfferType>) => {
    if (offerTypes.has('subscription')) return 0;
    if (offerTypes.has('free')) return 1;
    if (offerTypes.has('ads')) return 2;
    if (offerTypes.has('rent')) return 3;
    return 4;
  };

  return [...aggregates.values()]
    .sort((left, right) => {
      const leftIsPreferred = left.regions.has(preferredRegion);
      const rightIsPreferred = right.regions.has(preferredRegion);
      if (leftIsPreferred !== rightIsPreferred) return leftIsPreferred ? -1 : 1;
      return offerPriority(left.offerTypes) - offerPriority(right.offerTypes)
        || left.priority - right.priority
        || right.regions.size - left.regions.size
        || left.provider.provider_name.localeCompare(right.provider.provider_name);
    })
    .map(({ provider, regions, offerTypes }) => ({
      id: provider.provider_id,
      name: provider.provider_name,
      logoUrl: preferredProviderLogoUrl({
        id: provider.provider_id,
        name: provider.provider_name,
        logoPath: provider.logo_path,
      }),
      regions: [...regions].sort(),
      offerTypes: [...offerTypes],
      availability: regions.has(preferredRegion) ? 'preferred-region' : 'other-region',
      source: 'tmdb',
    }));
}

function tmdbStreamingProviders(d: TMDBMedia): StreamingProvider[] {
  return tmdbStreamingProvidersFromResponse(d['watch/providers']);
}

export async function fetchTMDBStreamingProvidersById(
  type: 'movie' | 'tv',
  tmdbId: string | undefined,
  tmdbCredential?: string,
  regionCode = systemRegionCode(),
): Promise<StreamingProvider[] | null> {
  if (!tmdbId || !tmdbCredential) return null;
  try {
    const response = await fetchTMDBJson(
      `${type}/${encodeURIComponent(tmdbId)}/watch/providers`,
      tmdbWatchProviderResponseSchema,
      tmdbCredential,
    );
    return tmdbStreamingProvidersFromResponse(response, regionCode);
  } catch (err) {
    console.error(`[TMDB ${type} streaming providers]`, err);
    return null;
  }
}

function tmdbMovieResult(d: TMDBMedia | null, fallbackTitle: string): Partial<MediaItem> | null {
  if (!d) return null;
  const cast = (d.credits?.cast ?? []).slice(0, 10).map((c) => ({
    name: c.name ?? '',
    character: c.character ?? '',
    image: c.profile_path ? `${TMDB_IMAGE_BASE}/w500${c.profile_path}` : '',
  }));

  return {
    title: d.title || fallbackTitle,
    providerIds: {
      tmdbId: d.id ? String(d.id) : undefined,
      imdbId: d.imdb_id || d.external_ids?.imdb_id || undefined,
    },
    poster: tmdbPosterCandidates(d)[0] || tmdbPoster(d.poster_path),
    backdrop: tmdbBackdropCandidates(d)[0] || tmdbBackdrop(d.backdrop_path),
    posterCandidates: tmdbPosterCandidates(d),
    backdropCandidates: tmdbBackdropCandidates(d),
    logo: tmdbLogoCandidates(d)[0] || '',
    logoCandidates: tmdbLogoCandidates(d),
    summary: d.overview || '',
    rating: d.vote_average ?? 0,
    runtime: d.runtime && d.runtime > 0 ? `${d.runtime}m` : undefined,
    trailerUrl: tmdbTrailerUrl(d) || undefined,
    contentRatings: tmdbContentRatings(d),
    streamingProviders: tmdbStreamingProviders(d),
    genres: (d.genres ?? []).flatMap((genre) => genre.name ? [genre.name] : []),
    year: d.release_date ? new Date(d.release_date).getFullYear() : 0,
    cast,
  };
}

function tmdbMovieSearchResult(d: TMDBMedia | null, fallbackTitle: string): Partial<MediaItem> | null {
  if (!d) return null;
  return {
    title: d.title || fallbackTitle,
    providerIds: { tmdbId: d.id ? String(d.id) : undefined },
    poster: tmdbPosterCandidates(d)[0] || tmdbPoster(d.poster_path),
    backdrop: tmdbBackdropCandidates(d)[0] || tmdbBackdrop(d.backdrop_path),
    posterCandidates: tmdbPosterCandidates(d),
    backdropCandidates: tmdbBackdropCandidates(d),
    summary: d.overview || '',
    rating: d.vote_average ?? 0,
    runtime: d.runtime && d.runtime > 0 ? `${d.runtime}m` : undefined,
    trailerUrl: tmdbTrailerUrl(d) || undefined,
    genres: [],
    year: d.release_date ? yearFromDateString(d.release_date) : 0,
    cast: [],
  };
}

export async function fetchTMDBMovieMetadataCandidates(
  title: string,
  year?: number,
  tmdbCredential?: string,
): Promise<Partial<MediaItem>[]> {
  if (!tmdbCredential) return [];
  try {
    const searchPaths = [
      `search/movie?query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`,
      year ? `search/movie?query=${encodeURIComponent(title)}` : '',
    ].filter(Boolean);
    const hits: TMDBMedia[] = [];
    for (const searchPath of searchPaths) {
      const searchData = await fetchTMDBJson(searchPath, tmdbSearchResponseSchema, tmdbCredential);
      hits.push(...tmdbSearchResults(searchData).slice(0, 6));
    }
    return uniqueMetadataSearchHits(hits, (hit) => `tmdb-movie:${hit.id}`)
      .map((hit) => tmdbMovieSearchResult(hit, title))
      .filter((result): result is Partial<MediaItem> => Boolean(result));
  } catch (err) {
    console.error('[TMDB movie candidates]', err);
    return [];
  }
}

export async function fetchTMDBMovieMetadata(
  title: string,
  year?: number,
  tmdbCredential?: string,
): Promise<Partial<MediaItem> | null> {
  if (!tmdbCredential) return null;
  try {
    const localTitles = uniqueLocalTitles([title]);
    const searchPaths = [
      `search/movie?query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`,
      year ? `search/movie?query=${encodeURIComponent(title)}` : '',
    ].filter(Boolean);
    let hit: TMDBMedia | null = null;
    for (const searchPath of searchPaths) {
      const searchData = await fetchTMDBJson(searchPath, tmdbSearchResponseSchema, tmdbCredential);
      hit = tmdbSearchResults(searchData).find((candidate) => movieHitMatchesLocal(candidate, localTitles, year)) || null;
      if (hit) break;
    }
    if (!hit) return null;

    const d = await fetchTMDBJson(
      `movie/${hit.id}?append_to_response=credits,images,external_ids,release_dates,watch/providers,videos`,
      tmdbMediaSchema,
      tmdbCredential,
    );
    const result = tmdbMovieResult(d, hit.title || title);
    return result ? { ...result, year: result.year || year || 0 } : null;
  } catch (err) {
    console.error('[TMDB movie]', err);
    return null;
  }
}

export async function fetchTMDBMovieMetadataById(
  tmdbId: string | undefined,
  tmdbCredential?: string,
): Promise<Partial<MediaItem> | null> {
  if (!tmdbId || !tmdbCredential) return null;
  try {
    const d = await fetchTMDBJson(
      `movie/${encodeURIComponent(tmdbId)}?append_to_response=credits,images,external_ids,release_dates,watch/providers,videos`,
      tmdbMediaSchema,
      tmdbCredential,
    );
    return tmdbMovieResult(d, '');
  } catch (err) {
    console.error('[TMDB movie id]', err);
    return null;
  }
}

async function tmdbTVResultFromDetails(d: TMDBMedia | null, fallbackTitle: string, tmdbCredential?: string): Promise<TMDBTVResult | null> {
  if (!d) return null;

  const cast = (d.credits?.cast ?? []).slice(0, 10).map((c) => ({
    name: c.name ?? '',
    character: c.character ?? '',
    image: c.profile_path ? `${TMDB_IMAGE_BASE}/w500${c.profile_path}` : '',
  }));

  // Season 0 is TMDB's Specials season. Keep it so local S00E## files can be
  // enriched with provider metadata instead of falling back to embedded tags.
  const realSeasons = (d.seasons ?? []).filter(
    (season): season is TMDBSeasonSummary & { season_number: number } => (
      typeof season.season_number === 'number' && season.season_number >= 0
    ),
  );

  const tmdbSeasons = realSeasons.map((s) => ({
    number: s.season_number,
    title: s.name || `Season ${s.season_number}`,
    episodeCount: s.episode_count || 0,
  }));

  const seasonEpisodes = await Promise.all(
    realSeasons.slice(0, 15).map(async (s) => {
      try {
        const epData = await fetchTMDBJson(
          `tv/${d.id}/season/${s.season_number}`,
          tmdbSeasonResponseSchema,
          tmdbCredential,
        );
        return epData?.episodes ?? [];
      } catch {
        return [];
      }
    }),
  );

  const episodes: EpisodeMeta[] = seasonEpisodes.flat().map((e) => ({
    season: e.season_number ?? 0,
    number: e.episode_number ?? 0,
    title: e.name || '',
    summary: e.overview || '',
    still: e.still_path ? `${TMDB_IMAGE_BASE}/w780${e.still_path}` : '',
    rating: e.vote_average || 0,
    airDate: e.air_date || '',
  }));

  return {
    title: d.name || fallbackTitle,
    providerIds: {
      tmdbId: d.id ? String(d.id) : undefined,
      imdbId: d.external_ids?.imdb_id || undefined,
      tvdbId: d.external_ids?.tvdb_id ? String(d.external_ids.tvdb_id) : undefined,
    },
    poster: tmdbPosterCandidates(d)[0] || tmdbPoster(d.poster_path),
    backdrop: tmdbBackdropCandidates(d)[0] || tmdbBackdrop(d.backdrop_path),
    posterCandidates: tmdbPosterCandidates(d),
    backdropCandidates: tmdbBackdropCandidates(d),
    logo: tmdbLogoCandidates(d)[0] || '',
    logoCandidates: tmdbLogoCandidates(d),
    summary: d.overview || '',
    rating: d.vote_average ?? 0,
    contentRatings: tmdbContentRatings(d),
    streamingProviders: tmdbStreamingProviders(d),
    runtime: d.episode_run_time?.[0] && d.episode_run_time[0] > 0
      ? `${d.episode_run_time[0]}m`
      : undefined,
    seasonCount: d.number_of_seasons,
    episodeCount: d.number_of_episodes,
    trailerUrl: tmdbTrailerUrl(d) || undefined,
    genres: (d.genres ?? []).flatMap((genre) => genre.name ? [genre.name] : []),
    year: d.first_air_date ? new Date(d.first_air_date).getFullYear() : 0,
    cast,
    episodes,
    tmdbSeasons,
  };
}

function tmdbTVSearchResult(d: TMDBMedia | null, fallbackTitle: string): TMDBTVResult | null {
  if (!d) return null;
  return {
    title: d.name || fallbackTitle,
    providerIds: { tmdbId: d.id ? String(d.id) : undefined },
    poster: tmdbPoster(d.poster_path),
    backdrop: tmdbBackdrop(d.backdrop_path),
    summary: d.overview || '',
    rating: d.vote_average ?? 0,
    runtime: d.episode_run_time?.[0] && d.episode_run_time[0] > 0
      ? `${d.episode_run_time[0]}m`
      : undefined,
    seasonCount: d.number_of_seasons,
    episodeCount: d.number_of_episodes,
    trailerUrl: tmdbTrailerUrl(d) || undefined,
    genres: [],
    year: d.first_air_date ? yearFromDateString(d.first_air_date) : 0,
    cast: [],
  };
}

export async function fetchTMDBTVMetadataCandidates(
  title: string,
  year?: number,
  tmdbCredential?: string,
): Promise<TMDBTVResult[]> {
  if (!tmdbCredential) return [];
  try {
    const searchPaths = [
      `search/tv?query=${encodeURIComponent(title)}${year ? `&first_air_date_year=${year}` : ''}`,
      year ? `search/tv?query=${encodeURIComponent(title)}` : '',
    ].filter(Boolean);
    const hits: TMDBMedia[] = [];
    for (const searchPath of searchPaths) {
      const searchData = await fetchTMDBJson(searchPath, tmdbSearchResponseSchema, tmdbCredential);
      hits.push(...tmdbSearchResults(searchData).slice(0, 6));
    }
    return uniqueMetadataSearchHits(hits, (hit) => `tmdb-tv:${hit.id}`)
      .map((hit) => tmdbTVSearchResult(hit, title))
      .filter((result): result is TMDBTVResult => Boolean(result));
  } catch (err) {
    console.error('[TMDB TV candidates]', err);
    return [];
  }
}

export async function fetchTMDBTVMetadata(
  title: string,
  year?: number,
  tmdbCredential?: string,
): Promise<TMDBTVResult | null> {
  if (!tmdbCredential) return null;
  try {
    const searchPath = `search/tv?query=${encodeURIComponent(title)}${year ? `&first_air_date_year=${year}` : ''}`;
    const searchData = await fetchTMDBJson(searchPath, tmdbSearchResponseSchema, tmdbCredential);
    const hit = tmdbSearchResults(searchData)[0];
    if (!hit) return null;

    const d = await fetchTMDBJson(
      `tv/${hit.id}?append_to_response=credits,images,external_ids,content_ratings,watch/providers,videos`,
      tmdbMediaSchema,
      tmdbCredential,
    );
    const result = await tmdbTVResultFromDetails(d, hit.name || title, tmdbCredential);
    return result ? { ...result, year: result.year || year || 0 } : null;
  } catch (err) {
    console.error('[TMDB TV]', err);
    return null;
  }
}

export async function fetchTMDBTVMetadataById(
  tmdbId: string | undefined,
  tmdbCredential?: string,
): Promise<TMDBTVResult | null> {
  if (!tmdbId || !tmdbCredential) return null;
  try {
    const d = await fetchTMDBJson(
      `tv/${encodeURIComponent(tmdbId)}?append_to_response=credits,images,external_ids,content_ratings,watch/providers,videos`,
      tmdbMediaSchema,
      tmdbCredential,
    );
    return tmdbTVResultFromDetails(d, '', tmdbCredential);
  } catch (err) {
    console.error('[TMDB TV id]', err);
    return null;
  }
}
