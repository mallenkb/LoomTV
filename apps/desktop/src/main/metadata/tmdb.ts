import { movieHitMatchesLocal, tmdbLogoCandidates, uniqueLocalTitles, uniqueMetadataSearchHits, yearFromDateString } from './helpers';
import type { ContentRating, EpisodeMeta, MediaItem, StreamingProvider } from './types';
import { safeFetch } from '../safeFetch';
import { normalizeContentRating } from './contentRatings.ts';
import { preferredProviderLogoUrl } from '../../shared/providerLogos';

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

interface TMDBWatchProvider {
  provider_id?: number;
  provider_name?: string;
  logo_path?: string | null;
  display_priority?: number;
}

interface TMDBWatchProviderRegion {
  flatrate?: TMDBWatchProvider[];
  ads?: TMDBWatchProvider[];
  free?: TMDBWatchProvider[];
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
  release_date?: string;
  first_air_date?: string;
  genres?: TMDBGenre[];
  credits?: { cast?: TMDBPerson[] };
  external_ids?: TMDBExternalIds;
  seasons?: TMDBSeasonSummary[];
  release_dates?: {
    results?: Array<{ iso_3166_1?: string; release_dates?: Array<{ certification?: string }> }>;
  };
  content_ratings?: {
    results?: Array<{ iso_3166_1?: string; rating?: string }>;
  };
  'watch/providers'?: TMDBWatchProviderResponse;
}

interface TMDBSearchResponse {
  results?: TMDBMedia[];
}

interface TMDBSeasonResponse {
  episodes?: TMDBEpisode[];
}

function normalizeTMDBCredential(value: string): string {
  return value.trim().replace(/^Bearer\s+/i, '');
}

function isTMDBReadAccessToken(value: string): boolean {
  const candidate = value.trim();
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate);
}

async function fetchTMDBJson<T>(path: string, tmdbCredential?: string): Promise<T | null> {
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

  return (await response.json()) as T;
}

function tmdbSearchResults(searchData: TMDBSearchResponse | null): TMDBMedia[] {
  const results = searchData?.results;
  return Array.isArray(results) ? results : [];
}

function tmdbPoster(path: string | null | undefined): string {
  return path ? `${TMDB_IMAGE_BASE}/w500${path}` : '';
}
function tmdbBackdrop(path: string | null | undefined): string {
  return path ? `${TMDB_IMAGE_BASE}/w1280${path}` : '';
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

function tmdbStreamingProvidersFromResponse(
  response: TMDBWatchProviderResponse | null | undefined,
  regionCode = 'US',
): StreamingProvider[] {
  const region = response?.results?.[regionCode.toUpperCase()];
  if (!region) return [];

  const seen = new Set<number>();
  return [
    ...(region.flatrate || []),
    ...(region.ads || []),
    ...(region.free || []),
  ]
    .filter((provider): provider is TMDBWatchProvider & { provider_id: number; provider_name: string; logo_path: string } => (
      Number.isFinite(provider.provider_id)
      && Boolean(provider.provider_name?.trim())
      && Boolean(provider.logo_path)
    ))
    .sort((left, right) => (
      (left.display_priority ?? Number.MAX_SAFE_INTEGER) - (right.display_priority ?? Number.MAX_SAFE_INTEGER)
      || left.provider_name.localeCompare(right.provider_name)
    ))
    .filter((provider) => {
      if (seen.has(provider.provider_id)) return false;
      seen.add(provider.provider_id);
      return true;
    })
    .map((provider) => {
      return {
        id: provider.provider_id,
        name: provider.provider_name,
        logoUrl: preferredProviderLogoUrl({
          id: provider.provider_id,
          name: provider.provider_name,
          logoPath: provider.logo_path,
        }),
      };
    });
}

function tmdbStreamingProviders(d: TMDBMedia): StreamingProvider[] {
  return tmdbStreamingProvidersFromResponse(d['watch/providers']);
}

export async function fetchTMDBStreamingProvidersById(
  type: 'movie' | 'tv',
  tmdbId: string | undefined,
  tmdbCredential?: string,
  regionCode = 'US',
): Promise<StreamingProvider[] | null> {
  if (!tmdbId || !tmdbCredential) return null;
  try {
    const response = await fetchTMDBJson<TMDBWatchProviderResponse>(
      `${type}/${encodeURIComponent(tmdbId)}/watch/providers`,
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
  const cast = (d.credits?.cast ?? []).slice(0, 8).map((c) => ({
    name: c.name ?? '',
    character: c.character ?? '',
    image: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : '',
  }));

  return {
    title: d.title || fallbackTitle,
    providerIds: {
      tmdbId: d.id ? String(d.id) : undefined,
      imdbId: d.imdb_id || d.external_ids?.imdb_id || undefined,
    },
    poster: tmdbPoster(d.poster_path),
    backdrop: tmdbBackdrop(d.backdrop_path),
    logo: tmdbLogoCandidates(d)[0] || '',
    logoCandidates: tmdbLogoCandidates(d),
    summary: d.overview || '',
    rating: d.vote_average ?? 0,
    contentRatings: tmdbContentRatings(d),
    streamingProviders: tmdbStreamingProviders(d),
    genres: (d.genres ?? []).map((g) => g.name as string),
    year: d.release_date ? new Date(d.release_date).getFullYear() : 0,
    cast,
  };
}

function tmdbMovieSearchResult(d: TMDBMedia | null, fallbackTitle: string): Partial<MediaItem> | null {
  if (!d) return null;
  return {
    title: d.title || fallbackTitle,
    providerIds: { tmdbId: d.id ? String(d.id) : undefined },
    poster: tmdbPoster(d.poster_path),
    backdrop: tmdbBackdrop(d.backdrop_path),
    summary: d.overview || '',
    rating: d.vote_average ?? 0,
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
      const searchData = await fetchTMDBJson<TMDBSearchResponse>(searchPath, tmdbCredential);
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
      const searchData = await fetchTMDBJson<TMDBSearchResponse>(searchPath, tmdbCredential);
      hit = tmdbSearchResults(searchData).find((candidate) => movieHitMatchesLocal(candidate, localTitles, year)) || null;
      if (hit) break;
    }
    if (!hit) return null;

    const d = await fetchTMDBJson<TMDBMedia>(`movie/${hit.id}?append_to_response=credits,images,external_ids,release_dates,watch/providers`, tmdbCredential);
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
    const d = await fetchTMDBJson<TMDBMedia>(`movie/${encodeURIComponent(tmdbId)}?append_to_response=credits,images,external_ids,release_dates,watch/providers`, tmdbCredential);
    return tmdbMovieResult(d, '');
  } catch (err) {
    console.error('[TMDB movie id]', err);
    return null;
  }
}

async function tmdbTVResultFromDetails(d: TMDBMedia | null, fallbackTitle: string, tmdbCredential?: string): Promise<TMDBTVResult | null> {
  if (!d) return null;

  const cast = (d.credits?.cast ?? []).slice(0, 8).map((c) => ({
    name: c.name ?? '',
    character: c.character ?? '',
    image: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : '',
  }));

  // Season 0 is TMDB's Specials season. Keep it so local S00E## files can be
  // enriched with provider metadata instead of falling back to embedded tags.
  const realSeasons = (d.seasons ?? []).filter((s) => (s.season_number ?? -1) >= 0);

  const tmdbSeasons = realSeasons.map((s) => ({
    number: s.season_number as number,
    title: (s.name as string) || `Season ${s.season_number}`,
    episodeCount: (s.episode_count as number) || 0,
  }));

  const seasonEpisodes = await Promise.all(
    realSeasons.slice(0, 15).map(async (s) => {
      try {
        const epData = await fetchTMDBJson<TMDBSeasonResponse>(`tv/${d.id}/season/${s.season_number}`, tmdbCredential);
        return epData?.episodes ?? [];
      } catch {
        return [] as TMDBEpisode[];
      }
    }),
  );

  const episodes: EpisodeMeta[] = seasonEpisodes.flat().map((e) => ({
    season: e.season_number as number,
    number: e.episode_number as number,
    title: (e.name as string) || '',
    summary: (e.overview as string) || '',
    still: e.still_path ? `${TMDB_IMAGE_BASE}/w300${e.still_path}` : '',
    rating: (e.vote_average as number) || 0,
    airDate: (e.air_date as string) || '',
  }));

  return {
    title: (d.name as string) || fallbackTitle,
    providerIds: {
      tmdbId: d.id ? String(d.id) : undefined,
      imdbId: d.external_ids?.imdb_id || undefined,
      tvdbId: d.external_ids?.tvdb_id ? String(d.external_ids.tvdb_id) : undefined,
    },
    poster: tmdbPoster(d.poster_path),
    backdrop: tmdbBackdrop(d.backdrop_path),
    logo: tmdbLogoCandidates(d)[0] || '',
    logoCandidates: tmdbLogoCandidates(d),
    summary: (d.overview as string) || '',
    rating: (d.vote_average as number) ?? 0,
    contentRatings: tmdbContentRatings(d),
    streamingProviders: tmdbStreamingProviders(d),
    genres: (d.genres ?? []).map((g) => g.name as string),
    year: d.first_air_date ? new Date(d.first_air_date as string).getFullYear() : 0,
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
      const searchData = await fetchTMDBJson<TMDBSearchResponse>(searchPath, tmdbCredential);
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
    const searchData = await fetchTMDBJson<TMDBSearchResponse>(searchPath, tmdbCredential);
    const hit = tmdbSearchResults(searchData)[0];
    if (!hit) return null;

    const d = await fetchTMDBJson<TMDBMedia>(`tv/${hit.id}?append_to_response=credits,images,external_ids,content_ratings,watch/providers`, tmdbCredential);
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
    const d = await fetchTMDBJson<TMDBMedia>(`tv/${encodeURIComponent(tmdbId)}?append_to_response=credits,images,external_ids,content_ratings,watch/providers`, tmdbCredential);
    return tmdbTVResultFromDetails(d, '', tmdbCredential);
  } catch (err) {
    console.error('[TMDB TV id]', err);
    return null;
  }
}
