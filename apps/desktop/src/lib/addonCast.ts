import { z } from 'zod';
import { desktopApi } from './desktopApi';
import { cachedDesktopRead } from './queryClient';
import { tmdbFindResponseSchema } from './tmdbSchemas';
import type { StremioPluginCastMember } from '@/shared/desktopProtocol';

const creditsSchema = z.object({
  id: z.number().int().positive(),
  cast: z.array(z.object({ name: z.string(), character: z.string().optional(), profile_path: z.string().nullish() })).max(2000),
});
const nameKey = (name: string) => name.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLocaleLowerCase();

/** Resolve people through the exact work's credits, never a global actor-name search. */
export async function addonCastWithPortraits(imdbId: string, type: 'movie' | 'series', cast: readonly StremioPluginCastMember[]): Promise<readonly StremioPluginCastMember[]> {
  if (cast.length && cast.every(person => person.image)) return cast;
  try {
    const credits = await cachedDesktopRead('addon-cast', [type, imdbId], async () => {
      const found = tmdbFindResponseSchema.parse(await desktopApi.requestMetadataProvider({
        provider: 'tmdb', path: `find/${imdbId}`, query: { external_source: 'imdb_id' },
      }));
      const matches = type === 'movie' ? found.movie_results : found.tv_results;
      if (matches?.length !== 1) return [];
      const id = matches[0].id;
      const result = creditsSchema.parse(await desktopApi.requestMetadataProvider({
        provider: 'tmdb', path: `${type === 'movie' ? 'movie' : 'tv'}/${id}/credits`,
      }));
      if (result.id !== id) return [];
      return result.cast.slice(0, 100).map(person => ({
        name: person.name, character: person.character || '',
        image: person.profile_path && /^\/[a-zA-Z0-9_.-]+$/.test(person.profile_path)
          ? `https://image.tmdb.org/t/p/w185${person.profile_path}` : '',
      }));
    }, 30 * 60_000);
    if (!cast.length) return credits;
    const byName = new Map(credits.map(person => [nameKey(person.name), person]));
    return cast.map(person => {
      const credit = byName.get(nameKey(person.name));
      return { ...person, image: person.image || credit?.image || '', character: person.character || credit?.character || '' };
    });
  } catch {
    // Missing credentials and offline mode keep the original Cinemeta credits.
    return cast;
  }
}
