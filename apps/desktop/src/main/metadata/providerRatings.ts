import type { LanProviderRatings } from '@loom-media-server/lan-protocol';
import { mdblistProviderRatings } from '../../shared/mdblistRatings.ts';
import { omdbProviderRatings } from '../../shared/omdbRatings.ts';
import { resolveVideoRatings } from '../../shared/videoRatings.ts';
import { fetchOMDbMetadataById } from './omdb.ts';
import { requestRatingsProvider } from './ratingsRequest.ts';

export async function fetchVideoProviderRatings(
  imdbId: string | undefined,
  type: 'movie' | 'series',
  options: {
    omdbApiKey?: string;
    mdblistApiKey?: string;
    existing?: LanProviderRatings;
    fetchOMDb?: typeof fetchOMDbMetadataById;
  },
): Promise<LanProviderRatings> {
  if (!imdbId || !/^tt\d{5,12}$/.test(imdbId)) return options.existing || {};
  return resolveVideoRatings({
    existing: options.existing,
    loadOMDb: async () => {
      if (!options.omdbApiKey) return {};
      const result = await (options.fetchOMDb || fetchOMDbMetadataById)(imdbId, options.omdbApiKey);
      if (!result || result.imdbID !== imdbId || (result.Type && result.Type !== type)) return {};
      return omdbProviderRatings(result);
    },
    loadMDBList: async () => {
      if (!options.mdblistApiKey) return {};
      const url = new URL(`https://api.mdblist.com/imdb/${type === 'series' ? 'show' : 'movie'}/${imdbId}`);
      url.searchParams.set('apikey', options.mdblistApiKey);
      return mdblistProviderRatings(await requestRatingsProvider('mdblist', options.mdblistApiKey, url), imdbId, type);
    },
  });
}
