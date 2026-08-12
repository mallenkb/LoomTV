import { safeFetch } from '../safeFetch.ts';
import { normalizeContentRating } from './contentRatings.ts';
import type { ContentRating } from './types.ts';
import { z } from 'zod';

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
  imdbRating?: string;
  Rated?: string;
  [key: string]: string | undefined;
}

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
  imdbRating: z.string().optional(),
  Rated: z.string().optional(),
}).catchall(z.string().optional());

export function omdbContentRatings(metadata: OMDbResponse | null | undefined): Record<string, ContentRating> {
  const rating = normalizeContentRating('US', metadata?.Rated, 'omdb');
  return rating ? { US: rating } : {};
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
