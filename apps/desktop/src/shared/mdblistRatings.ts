import { z } from 'zod';
import { omdbProviderRatings, type OMDbRatingFields } from './omdbRatings';
import type { LanProviderRatings } from '@loom-media-server/lan-protocol';

const schema = z.object({
  imdbid: z.string().nullish(), imdb_id: z.string().nullish(),
  mediatype: z.string().optional(), type: z.string().optional(),
  ratings: z.array(z.object({
    source: z.string(), value: z.union([z.number().finite(), z.string()]).nullish(),
    votes: z.number().int().nonnegative().nullish(),
  })).max(100),
});

/** Normalize native scores through the same bounds and scales as OMDb/local metadata. */
export function mdblistProviderRatings(value: unknown, imdbId: string, type: 'movie' | 'series'): LanProviderRatings {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return {};
  const result = parsed.data;
  const mediaType = result.mediatype || result.type;
  if ((result.imdbid || result.imdb_id) !== imdbId || (mediaType && mediaType !== (type === 'series' ? 'show' : 'movie') && mediaType !== type)) return {};
  const sources: Record<string, string> = {
    imdb: 'Internet Movie Database', tomatoes: 'Rotten Tomatoes',
    popcorn: 'Popcornmeter', tomatoesaudience: 'Rotten Tomatoes Audience Score', metacritic: 'Metacritic',
  };
  const fields: OMDbRatingFields = { Ratings: [] };
  for (const rating of result.ratings) {
    const source = sources[rating.source];
    const text = String(rating.value ?? '').trim();
    if (!source || !/^\d+(?:\.\d+)?$/.test(text)) continue;
    fields.Ratings?.push({ Source: source, Value: text });
    if (rating.source === 'imdb' && rating.votes != null) fields.imdbVotes = String(rating.votes);
  }
  return omdbProviderRatings(fields);
}
