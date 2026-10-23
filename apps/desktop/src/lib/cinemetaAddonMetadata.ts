import { z } from 'zod';
import { desktopApi, type StremioPluginCatalogItem } from './desktopApi';
import { addonRatings } from './addonRatings';
import { addonCastWithPortraits } from './addonCast';
import { cachedDesktopRead } from './queryClient';

const imdbId = z.string().regex(/^tt\d{5,12}$/);
const metadataSchema = z.object({
  providerIds: z.object({ imdbId }),
  title: z.string(), year: z.number().optional(), summary: z.string(),
  poster: z.string(), backdrop: z.string(), logo: z.string(),
  genres: z.array(z.string()), rating: z.number(), runtime: z.string().optional(),
  trailerUrl: z.string().optional(), seasonCount: z.number().optional(), episodeCount: z.number().optional(),
  episodes: z.array(z.object({ season: z.number().int().nonnegative(), number: z.number().int().positive(), title: z.string(), summary: z.string(), still: z.string(), airDate: z.string() })).optional(),
  cast: z.array(z.object({ name: z.string(), character: z.string(), image: z.string() })).optional(),
});

/** Shared by poster ratings and detail enrichment so each title is fetched once. */
export function cinemetaTitleMetadata(id: string, type: 'movie' | 'series') {
  return cachedDesktopRead('addon-cinemeta', [type, id], async () => {
    const result = await desktopApi.requestMetadataProvider({ provider: 'cinemeta', path: `meta/${type}/${id}.json` });
    const metadata = metadataSchema.parse(result);
    if (metadata.providerIds.imdbId !== id) throw new Error('Cinemeta returned a different title.');
    return metadata;
  }, 30 * 60_000);
}

/** Display metadata only. Add-on identities, episode IDs and stream bindings stay intact. */
export async function enrichWithCinemeta(item: StremioPluginCatalogItem, onMetadata?: (item: StremioPluginCatalogItem) => void): Promise<StremioPluginCatalogItem> {
  const id = [item.imdbId, item.providerId].find(value => imdbId.safeParse(value).success);
  const type = item.type === 'movie' ? 'movie' : ['series', 'tv', 'anime'].includes(item.type) ? 'series' : null;
  if (!id || !type) return item;
  const ratingsPending = addonRatings(id, type);
  try {
    const metadata = await cinemetaTitleMetadata(id, type);
    const originalCast = item.cast?.some(person => person.image) ? item.cast : metadata.cast?.length ? metadata.cast : item.cast || [];
    const enriched: StremioPluginCatalogItem = {
      ...item,
      imdbId: id,
      title: metadata.title || item.title,
      description: metadata.summary || item.description,
      releaseInfo: metadata.year ? String(metadata.year) : item.releaseInfo,
      runtime: metadata.runtime || item.runtime,
      genres: metadata.genres.length ? metadata.genres : item.genres,
      rating: metadata.rating || item.rating,
      providerRatings: {
        ...item.providerRatings,
        ...(metadata.rating ? { imdb: { value: metadata.rating, scale: 10 } } : {}),
      },
      cast: originalCast,
      // Cinemeta may supply a list for IMDb series without add-on metadata.
      // A provider's own video IDs and inline-stream bindings always win.
      ...(!item.videos?.length && type === 'series' && item.providerId === id && metadata.episodes?.length ? {
        videos: metadata.episodes.map(episode => ({
          id: `${id}:${episode.season}:${episode.number}`, title: episode.title,
          season: episode.season, episode: episode.number, overview: episode.summary,
          thumbnail: episode.still, released: episode.airDate || undefined,
        })),
      } : {}),
      trailerUrl: metadata.trailerUrl || item.trailerUrl,
      seasonCount: metadata.seasonCount ?? item.seasonCount,
      episodeCount: metadata.episodeCount ?? item.episodeCount,
      artwork: {
        ...item.artwork,
        ...(metadata.poster ? { poster: metadata.poster } : {}),
        ...(metadata.backdrop ? { background: metadata.backdrop } : {}),
        ...(metadata.logo ? { logo: metadata.logo } : {}),
      },
    };
    onMetadata?.(enriched);
    let latest = enriched;
    await Promise.all([
      addonCastWithPortraits(id, type, originalCast).then(cast => {
        latest = { ...latest, cast };
        onMetadata?.(latest);
      }),
      ratingsPending.then(providerRatings => {
        latest = { ...latest, providerRatings: { ...latest.providerRatings, ...providerRatings } };
        onMetadata?.(latest);
      }),
    ]);
    return latest;
  } catch {
    // Offline mode, unavailable metadata or a missing IMDb identity leave the catalog usable.
    const providerRatings = await ratingsPending;
    return { ...item, providerRatings: { ...item.providerRatings, ...providerRatings } };
  }
}
