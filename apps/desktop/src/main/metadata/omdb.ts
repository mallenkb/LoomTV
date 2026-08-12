import { safeFetch } from '../safeFetch.ts';
import { normalizeContentRating } from './contentRatings.ts';
import type { ContentRating, ProviderRatings } from './types.ts';
import { z } from 'zod';

export interface OMDbRating {
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

export function omdbContentRatings(metadata: OMDbResponse | null | undefined): Record<string, ContentRating> {
  const rating = normalizeContentRating('US', metadata?.Rated, 'omdb');
  return rating ? { US: rating } : {};
}

function ratingBySource(metadata: OMDbResponse | null | undefined, source: string): string | undefined {
  return metadata?.Ratings?.find((rating) => rating.Source === source)?.Value;
}

function scoreFromText(value: string | undefined, scale: 10 | 100): number | undefined {
  if (!value || value === 'N/A') return undefined;
  const score = Number.parseFloat(value);
  return Number.isFinite(score) && score >= 0 && score <= scale ? score : undefined;
}

function voteCountFromText(value: string | undefined): number | undefined {
  if (!value || value === 'N/A') return undefined;
  const votes = Number(value.replaceAll(',', '').trim());
  return Number.isSafeInteger(votes) && votes >= 0 ? votes : undefined;
}

export function omdbProviderRatings(metadata: OMDbResponse | null | undefined): ProviderRatings {
  const imdb = scoreFromText(
    metadata?.imdbRating || ratingBySource(metadata, 'Internet Movie Database'),
    10,
  );
  const rottenTomatoes = scoreFromText(ratingBySource(metadata, 'Rotten Tomatoes'), 100);
  const popcornmeter = scoreFromText(
    ratingBySource(metadata, 'Popcornmeter')
      || ratingBySource(metadata, 'Rotten Tomatoes Audience Score'),
    100,
  );
  const metacritic = scoreFromText(
    metadata?.Metascore || ratingBySource(metadata, 'Metacritic'),
    100,
  );
  const votes = voteCountFromText(metadata?.imdbVotes);

  return {
    ...(imdb === undefined ? {} : {
      imdb: {
        value: imdb,
        scale: 10,
        ...(votes === undefined ? {} : { votes }),
      },
    }),
    ...(rottenTomatoes === undefined ? {} : {
      rottenTomatoes: { value: rottenTomatoes, scale: 100 },
    }),
    ...(popcornmeter === undefined ? {} : {
      popcornmeter: { value: popcornmeter, scale: 100 },
    }),
    ...(metacritic === undefined ? {} : {
      metacritic: { value: metacritic, scale: 100 },
    }),
  };
}

export async function fetchOMDbMetadata(title: string, year?: number, omdbApiKey?: string): Promise<OMDbResponse | null> {
  if (!omdbApiKey) return null;
  try {
    const attempts = year ? [year, undefined] : [undefined];
    for (const attemptYear of attempts) {
      const yearParam = attemptYear ? `&y=${attemptYear}` : '';
      const url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(omdbApiKey)}${yearParam}`;
      const res = await safeFetch(url, {}, { allowedHosts: ['www.omdbapi.com'], retries: 2 });
      const data = omdbResponseSchema.parse(await res.json());
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
    const res = await safeFetch(url, {}, { allowedHosts: ['www.omdbapi.com'], retries: 2 });
    const data = omdbResponseSchema.parse(await res.json());
    return data.Response !== 'False' ? data : null;
  } catch {
    return null;
  }
}
