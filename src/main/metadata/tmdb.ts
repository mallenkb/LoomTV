import { fetchWithTimeout, movieHitMatchesLocal, tmdbLogoCandidates, uniqueLocalTitles, uniqueMetadataSearchHits, yearFromDateString } from './helpers';
import type { EpisodeMeta, MediaItem } from './types';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

export interface TMDBTVResult extends Partial<MediaItem> {
  episodes?: EpisodeMeta[];
  tmdbSeasons?: { number: number; title: string; episodeCount: number }[];
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

  const response = await fetchWithTimeout(url.toString(), requestInit);
  if (!response.ok) {
    throw new Error(`TMDB request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

function tmdbPoster(path: string | null | undefined): string {
  return path ? `${TMDB_IMAGE_BASE}/w500${path}` : '';
}
function tmdbBackdrop(path: string | null | undefined): string {
  return path ? `${TMDB_IMAGE_BASE}/w1280${path}` : '';
}

function tmdbMovieResult(d: any, fallbackTitle: string): Partial<MediaItem> | null {
  if (!d) return null;
  const cast = ((d.credits?.cast ?? []) as any[]).slice(0, 8).map((c: any) => ({
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
    genres: ((d.genres ?? []) as any[]).map((g: any) => g.name as string),
    year: d.release_date ? new Date(d.release_date).getFullYear() : 0,
    cast,
  };
}

function tmdbMovieSearchResult(d: any, fallbackTitle: string): Partial<MediaItem> | null {
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
    const hits: any[] = [];
    for (const searchPath of searchPaths) {
      const searchData = await fetchTMDBJson<any>(searchPath, tmdbCredential);
      const results = Array.isArray(searchData?.results) ? searchData.results : [];
      hits.push(...results.slice(0, 6));
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
    let hit: any = null;
    for (const searchPath of searchPaths) {
      const searchData = await fetchTMDBJson<any>(searchPath, tmdbCredential);
      const results = Array.isArray(searchData?.results) ? searchData.results : [];
      hit = results.find((candidate: any) => movieHitMatchesLocal(candidate, localTitles, year)) || null;
      if (hit) break;
    }
    if (!hit) return null;

    const d = await fetchTMDBJson<any>(`movie/${hit.id}?append_to_response=credits,images,external_ids`, tmdbCredential);
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
    const d = await fetchTMDBJson<any>(`movie/${encodeURIComponent(tmdbId)}?append_to_response=credits,images,external_ids`, tmdbCredential);
    return tmdbMovieResult(d, '');
  } catch (err) {
    console.error('[TMDB movie id]', err);
    return null;
  }
}

async function tmdbTVResultFromDetails(d: any, fallbackTitle: string, tmdbCredential?: string): Promise<TMDBTVResult | null> {
  if (!d) return null;

  const cast = ((d.credits?.cast ?? []) as any[]).slice(0, 8).map((c: any) => ({
    name: c.name ?? '',
    character: c.character ?? '',
    image: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : '',
  }));

  const realSeasons: any[] = ((d.seasons ?? []) as any[]).filter(
    (s: any) => s.season_number > 0,
  );

  const tmdbSeasons = realSeasons.map((s: any) => ({
    number: s.season_number as number,
    title: (s.name as string) || `Season ${s.season_number}`,
    episodeCount: (s.episode_count as number) || 0,
  }));

  const seasonEpisodes = await Promise.all(
    realSeasons.slice(0, 15).map(async (s: any) => {
      try {
        const epData = await fetchTMDBJson<any>(`tv/${d.id}/season/${s.season_number}`, tmdbCredential);
        return ((epData?.episodes ?? []) as any[]);
      } catch {
        return [] as any[];
      }
    }),
  );

  const episodes: EpisodeMeta[] = seasonEpisodes.flat().map((e: any) => ({
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
    genres: ((d.genres ?? []) as any[]).map((g: any) => g.name as string),
    year: d.first_air_date ? new Date(d.first_air_date as string).getFullYear() : 0,
    cast,
    episodes,
    tmdbSeasons,
  };
}

function tmdbTVSearchResult(d: any, fallbackTitle: string): TMDBTVResult | null {
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
    const hits: any[] = [];
    for (const searchPath of searchPaths) {
      const searchData = await fetchTMDBJson<any>(searchPath, tmdbCredential);
      const results = Array.isArray(searchData?.results) ? searchData.results : [];
      hits.push(...results.slice(0, 6));
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
    const searchData = await fetchTMDBJson<any>(searchPath, tmdbCredential);
    const hit = searchData?.results?.[0];
    if (!hit) return null;

    const d = await fetchTMDBJson<any>(`tv/${hit.id}?append_to_response=credits,images,external_ids`, tmdbCredential);
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
    const d = await fetchTMDBJson<any>(`tv/${encodeURIComponent(tmdbId)}?append_to_response=credits,images,external_ids`, tmdbCredential);
    return tmdbTVResultFromDetails(d, '', tmdbCredential);
  } catch (err) {
    console.error('[TMDB TV id]', err);
    return null;
  }
}
