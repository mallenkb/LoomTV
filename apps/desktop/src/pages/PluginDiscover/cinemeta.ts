import { z } from 'zod';
import { desktopApi, type StremioPluginCatalogItem } from '@/lib/desktopApi';
import { cachedDesktopRead } from '@/lib/queryClient';
import type { DiscoverSection } from './discoverState';

const manifestSchema = z.object({ catalogs: z.array(z.object({
  type: z.string(), id: z.string(), genres: z.array(z.string()).optional(),
})) });
const metaSchema = z.object({
  id: z.string().regex(/^tt\d+$/), name: z.string(),
  genres: z.array(z.string()).nullish(), description: z.string().nullish(),
  poster: z.string().nullish(), background: z.string().nullish(), logo: z.string().nullish(),
  releaseInfo: z.string().nullish(), released: z.string().nullish(),
  imdbRating: z.union([z.string(), z.number()]).nullish(), runtime: z.string().nullish(),
  cast: z.array(z.string()).nullish(),
});
const catalogSchema = z.object({ metas: z.array(metaSchema) });

export function cinemetaGenres(type: 'movie' | 'tv') {
  return cachedDesktopRead('cinemeta-genres', [type], async () => {
    const manifest = manifestSchema.parse(await desktopApi.requestMetadataProvider({ provider: 'cinemeta', path: 'manifest.json' }));
    const genres = manifest.catalogs.find(c => c.type === (type === 'tv' ? 'series' : 'movie') && c.id === 'top')?.genres || [];
    return genres.map(genre => ({ label: genre, value: genre.toLowerCase() }));
  });
}

export function cinemetaCatalog(type: 'movie' | 'tv', section: DiscoverSection, search: string, genre: string, year: string) {
  return cachedDesktopRead('cinemeta-catalog', [type, section, search, genre, year], async () => {
    const providerType = type === 'tv' ? 'series' : 'movie';
    const options = genre ? await cinemetaGenres(type) : [];
    const selected = genre.split(',').filter(Boolean).map(value => options.find(option => option.value === value)?.label || value);
    const catalog = search ? 'top' : year || section === 'new' ? 'year' : section === 'top_rated' ? 'imdbRating' : 'top';
    // Cinemeta accepts one genre per catalog request. Merge selections as a union.
    const groups = catalog === 'year' ? [year || String(new Date().getFullYear())] : selected.length ? selected : [''];
    const items = new Map<string, StremioPluginCatalogItem>();
    for (const group of groups) {
      const extras = [search ? `search=${encodeURIComponent(search)}` : '', group ? `genre=${encodeURIComponent(group)}` : ''].filter(Boolean).join('&');
      const path = `catalog/${providerType}/${catalog}${extras ? `/${extras}` : ''}.json`;
      const response = catalogSchema.parse(await desktopApi.requestMetadataProvider({ provider: 'cinemeta', path }));
      for (const meta of response.metas) {
        const rating = Number(meta.imdbRating);
        items.set(meta.id, {
          id: meta.id, imdbId: meta.id, source: 'cinemeta', type,
          format: type === 'movie' ? 'Movie' : 'TV', title: meta.name,
          genres: meta.genres || [], description: meta.description || '',
          posterUrl: meta.poster || '', backgroundUrl: meta.background || '', logoUrl: meta.logo || '',
          releaseInfo: meta.releaseInfo || meta.released?.slice(0, 4) || '', released: meta.released || '',
          rating: meta.imdbRating != null && Number.isFinite(rating) ? rating : undefined,
          runtime: meta.runtime || undefined,
          cast: (meta.cast || []).map(name => ({ name, character: '', image: '' })),
        });
      }
    }
    return [...items.values()].filter(item =>
      (!selected.length || item.genres.some(g => selected.some(s => s.toLowerCase() === g.toLowerCase())))
      && (!year || (item.releaseInfo || '').slice(0, 4) === year),
    ).slice(0, 30);
  });
}
