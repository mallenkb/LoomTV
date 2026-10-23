import { z } from 'zod';
import { desktopApi } from './desktopApi';
import { cachedDesktopRead } from './queryClient';
import { mdblistProviderRatings } from '@/shared/mdblistRatings';
import { omdbProviderRatings } from '@/shared/omdbRatings';
import type { LanProviderRatings } from '@loom-media-server/lan-protocol';

const responseSchema = z.object({
  Response: z.string().optional(),
  imdbID: z.string(), Type: z.string().optional(),
  imdbRating: z.string().optional(), imdbVotes: z.string().optional(), Metascore: z.string().optional(),
  Ratings: z.array(z.object({ Source: z.string(), Value: z.string() })).max(100).optional(),
});

/** The host supplies the saved key. Exact IMDb identity is required before merging scores. */
async function omdbRatings(imdbId: string, type: 'movie' | 'series'): Promise<LanProviderRatings> {
  if (!/^tt\d{5,12}$/.test(imdbId)) return {};
  try {
    return await cachedDesktopRead('addon-omdb-ratings', [type, imdbId], async () => {
      const result = responseSchema.parse(await desktopApi.requestMetadataProvider({
        provider: 'omdb', query: { i: imdbId, type },
      }));
      if (result.Response === 'False' || result.imdbID !== imdbId || (result.Type && result.Type !== type)) return {};
      return omdbProviderRatings(result);
    }, 30 * 60_000);
  } catch {
    // Missing keys, quota limits and unavailable metadata do not block the detail page.
    return {};
  }
}

/** Preserve OMDb scores and fill only gaps from MDBList, including quota failures. */
export async function addonRatings(imdbId: string, type: 'movie' | 'series'): Promise<LanProviderRatings> {
  if (!/^tt\d{5,12}$/.test(imdbId)) return {};
  const primary = await omdbRatings(imdbId, type);
  if (primary.imdb && primary.rottenTomatoes && primary.metacritic && primary.popcornmeter) return primary;
  try {
    const fallback = await cachedDesktopRead('addon-mdblist-ratings', [type, imdbId], async () => (
      mdblistProviderRatings(await desktopApi.requestMetadataProvider({ provider: 'mdblist', imdbId, type }), imdbId, type)
    ), 30 * 60_000);
    return { ...fallback, ...primary };
  } catch {
    return primary;
  }
}
