import { desktopApi, type StremioPluginCatalogItem } from './desktopApi';
import { cachedDesktopRead } from './queryClient';
import { tmdbFindResponseSchema, tmdbProviderListResponseSchema, tmdbWatchProviderDetailSchema } from './tmdbSchemas';
import { preferredProviderLogoUrl } from '@/shared/providerLogos';
import type { z } from 'zod';

export type WatchProviderRegions = NonNullable<z.infer<typeof tmdbWatchProviderDetailSchema>['results']>;
export type WatchProviderLogo = NonNullable<z.infer<typeof tmdbProviderListResponseSchema>['results']>[number];
export const providerNameKey = (name: string) => name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Reuse the metadata gateway, profile cache, exact IMDb lookup and TMDB logo policy. */
export async function loadWatchProviders(item: StremioPluginCatalogItem) {
  const type = item.type === 'movie' ? 'movie' : 'tv';
  const availability = async () => {
    let id = item.tmdbId;
    if (!id || !/^\d+$/.test(id)) {
      const imdbId = [item.imdbId, item.providerId, item.id].find(value => value && /^tt\d{5,12}$/.test(value));
      if (!imdbId) throw new Error('No provider identity is available for this title.');
      const found = tmdbFindResponseSchema.parse(await desktopApi.requestMetadataProvider({
        provider: 'tmdb', path: `find/${imdbId}`, query: { external_source: 'imdb_id' },
      }));
      const matches = type === 'movie' ? found.movie_results : found.tv_results;
      if (matches?.length !== 1) throw new Error('No exact provider match is available for this title.');
      id = String(matches[0].id);
    }
    return tmdbWatchProviderDetailSchema.parse(await desktopApi.requestMetadataProvider({
      provider: 'tmdb', path: `${type}/${id}/watch/providers`,
    })).results || {};
  };
  const [offers, logos] = await Promise.allSettled([
    cachedDesktopRead('watch-provider-availability', [type, item.tmdbId || '', item.imdbId || item.providerId || item.id], availability, 30 * 60_000),
    cachedDesktopRead('watch-provider-logos', [type], async () => tmdbProviderListResponseSchema.parse(
      await desktopApi.requestMetadataProvider({ provider: 'tmdb', path: `watch/providers/${type}` }),
    ).results || [], 24 * 60 * 60_000),
  ]);
  return {
    regions: offers.status === 'fulfilled' ? offers.value : {},
    logos: logos.status === 'fulfilled' ? logos.value : [],
    error: offers.status === 'rejected' ? 'Provider availability could not be loaded.' : '',
  };
}

export function watchProviderLogo(name: string, logos: readonly WatchProviderLogo[]): string {
  const provider = logos.find(candidate => providerNameKey(candidate.provider_name) === providerNameKey(name));
  return provider ? preferredProviderLogoUrl({ name: provider.provider_name, logoPath: provider.logo_path }) : '';
}

export function defaultWatchRegion(): string {
  try { return new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).region || 'US'; }
  catch { return 'US'; }
}

export function watchRegionName(region: string): string {
  try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(region) || region; }
  catch { return region; }
}
