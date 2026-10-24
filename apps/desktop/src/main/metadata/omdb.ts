import { requestRatingsProvider } from './ratingsRequest.ts';
import { normalizeContentRating } from './contentRatings.ts';
import type { ContentRating, EpisodeMeta } from './types.ts';
import { z } from 'zod';
import { scoreFromText } from '../../shared/omdbRatings.ts';
export { omdbProviderRatings } from '../../shared/omdbRatings.ts';

interface OMDbRating {
  Source: string;
  Value: string;
}

export interface OMDbResponse {
  Response?: string;
  Title?: string;
  Year?: string;
  Type?: string;
  Genre?: string;
  Country?: string;
  Language?: string;
  Plot?: string;
  Poster?: string;
  imdbID?: string;
  imdbRating?: string;
  imdbVotes?: string;
  Metascore?: string;
  Ratings?: OMDbRating[];
  Rated?: string;
}

interface OMDbSeasonEpisode {
  Title?: string;
  Released?: string;
  Episode?: string;
  imdbRating?: string;
  imdbID?: string;
}

interface OMDbSeasonResponse {
  Response?: string;
  Title?: string;
  Season?: string;
  totalSeasons?: string;
  Episodes?: OMDbSeasonEpisode[];
  Error?: string;
}

const omdbRatingSchema = z.object({
  Source: z.string(),
  Value: z.string(),
});

const omdbResponseSchema: z.ZodType<OMDbResponse> = z.object({
  Response: z.string().optional(),
  Title: z.string().optional(),
  Year: z.string().optional(),
  Type: z.string().optional(),
  Genre: z.string().optional(),
  Country: z.string().optional(),
  Language: z.string().optional(),
  Plot: z.string().optional(),
  Poster: z.string().optional(),
  imdbID: z.string().optional(),
  imdbRating: z.string().optional(),
  imdbVotes: z.string().optional(),
  Metascore: z.string().optional(),
  Ratings: z.array(omdbRatingSchema).optional(),
  Rated: z.string().optional(),
}).passthrough();

const omdbSeasonEpisodeSchema: z.ZodType<OMDbSeasonEpisode> = z.object({
  Title: z.string().optional(),
  Released: z.string().optional(),
  Episode: z.string().optional(),
  imdbRating: z.string().optional(),
  imdbID: z.string().optional(),
}).passthrough();

const omdbSeasonResponseSchema: z.ZodType<OMDbSeasonResponse> = z.object({
  Response: z.string().optional(),
  Title: z.string().optional(),
  Season: z.string().optional(),
  totalSeasons: z.string().optional(),
  Episodes: z.array(omdbSeasonEpisodeSchema).optional(),
  Error: z.string().optional(),
}).passthrough();

export function omdbContentRatings(metadata: OMDbResponse | null | undefined): Record<string, ContentRating> {
  const rating = normalizeContentRating('US', metadata?.Rated, 'omdb');
  return rating ? { US: rating } : {};
}

export async function fetchOMDbMetadata(title: string, year?: number, omdbApiKey?: string, mediaType?: 'movie' | 'series'): Promise<OMDbResponse | null> {
  if (!omdbApiKey) return null;
  try {
    const attempts = year ? [year, undefined] : [undefined];
    for (const attemptYear of attempts) {
      const yearParam = attemptYear ? `&y=${attemptYear}` : '';
      const typeParam = mediaType ? `&type=${mediaType}` : '';
      const url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(omdbApiKey)}${yearParam}${typeParam}`;
      const data = omdbResponseSchema.parse(await requestRatingsProvider('omdb', omdbApiKey, url));
      if (data.Response !== 'False') return data;
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchOMDbMetadataById(imdbId: string | undefined, omdbApiKey?: string): Promise<OMDbResponse | null> {
  if (!imdbId || !omdbApiKey) return null;
  try {
    const url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(omdbApiKey)}`;
    const data = omdbResponseSchema.parse(await requestRatingsProvider('omdb', omdbApiKey, url));
    return data.Response !== 'False' && data.imdbID === imdbId ? data : null;
  } catch {
    return null;
  }
}

function seasonNumberFromText(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function omdbSeasonEpisodeMetadata(
  metadata: OMDbSeasonResponse | null | undefined,
  requestedSeason: number,
): EpisodeMeta[] {
  const season = seasonNumberFromText(metadata?.Season, requestedSeason);
  return (metadata?.Episodes || []).flatMap((episode) => {
    const number = Number(episode.Episode);
    if (!Number.isSafeInteger(number) || number <= 0) return [];
    return [{
      season,
      number,
      title: episode.Title && episode.Title !== 'N/A' ? episode.Title : `Episode ${number}`,
      summary: '',
      still: '',
      rating: scoreFromText(episode.imdbRating, 10) || 0,
      airDate: episode.Released && episode.Released !== 'N/A' ? episode.Released : '',
    }];
  });
}

export async function fetchOMDbSeasonEpisodes(
  seriesImdbId: string | undefined,
  seasonNumbers: number[],
  omdbApiKey?: string,
): Promise<EpisodeMeta[]> {
  if (!seriesImdbId || !/^tt\d{7,12}$/i.test(seriesImdbId) || !omdbApiKey) return [];
  const seasons = [...new Set(seasonNumbers)]
    .filter((season) => Number.isSafeInteger(season) && season >= 0 && season <= 200)
    .sort((left, right) => left - right);
  const episodes: EpisodeMeta[] = [];

  // OMDb accepts one season per request. Keep these calls sequential to avoid
  // spending a small API-key quota in a burst when a completed series is large.
  for (const season of seasons) {
    try {
      const url = new URL('https://www.omdbapi.com/');
      url.searchParams.set('i', seriesImdbId);
      url.searchParams.set('Season', String(season));
      url.searchParams.set('apikey', omdbApiKey);
      const metadata = omdbSeasonResponseSchema.parse(await requestRatingsProvider('omdb', omdbApiKey, url));
      if (metadata.Response === 'False') continue;
      episodes.push(...omdbSeasonEpisodeMetadata(metadata, season));
    } catch {
      // Keep ratings already returned by earlier seasons.
    }
  }

  return episodes;
}
