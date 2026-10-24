import type { AppSettings } from './appContracts.ts';
import type { MetadataProviderRequest } from '../shared/desktopProtocol.ts';
import { safeFetch } from './safeFetch.ts';
import { z } from 'zod';
import { fetchCinemetaMeta } from './metadata/cinemeta.ts';
import { requestRatingsProvider } from './metadata/ratingsRequest.ts';

type GatewayDependencies = {
  loadSettings: () => AppSettings;
  loadMetadataOfflineMode?: () => boolean;
  getMetadataApiKey: (settings: AppSettings, providerId: string) => string | undefined;
};

const TMDB_PATH_PATTERN = /^[a-z0-9_/-]+$/i;
const JIKAN_PATHS = new Set(['anime', 'genres/anime', 'seasons/now', 'top/anime']);
const TVMAZE_PATHS = new Set(['schedule', 'schedule/web', 'search/shows', 'lookup/shows']);
const finiteNumber = z.number().finite();
export const metadataProviderRequestSchema: z.ZodType<MetadataProviderRequest> = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('mdblist'), imdbId: z.string().regex(/^tt\d{5,12}$/), type: z.enum(['movie', 'series']) }),
  z.object({ provider: z.literal('cinemeta'), path: z.string().min(1).max(4000) }),
  z.object({
    provider: z.literal('omdb'),
    query: z.record(z.string(), z.union([z.string(), finiteNumber, z.boolean()])),
  }),
  z.object({
    provider: z.literal('tmdb'),
    path: z.string().trim().min(1).max(240),
    query: z.record(z.string(), z.union([z.string(), finiteNumber, z.boolean()])).optional(),
  }),
  z.object({
    provider: z.literal('anilist'),
    query: z.string().trim().min(1).max(30_000),
    variables: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    provider: z.literal('jikan'),
    path: z.string().trim().min(1).max(64),
    query: z.record(z.string(), z.union([z.string(), finiteNumber, z.boolean()])).optional(),
  }),
  z.object({
    provider: z.literal('tvmaze'),
    path: z.string().trim().min(1).max(64),
    query: z.record(z.string(), z.union([z.string(), finiteNumber, z.boolean()])).optional(),
  }),
]);

function queryUrl(origin: string, query: Record<string, string | number | boolean> = {}): URL {
  const url = new URL(origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

async function responseJson(response: Response, provider: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${provider} request failed with status ${response.status}.`);
  return response.json() as Promise<unknown>;
}

export function createMetadataProviderGateway(deps: GatewayDependencies) {
  return async function requestMetadataProvider(request: MetadataProviderRequest): Promise<unknown> {
    // Public providers only need the offline preference, not saved credentials.
    if (deps.loadMetadataOfflineMode ? deps.loadMetadataOfflineMode() : deps.loadSettings().metadataOfflineMode) {
      throw new Error('Metadata offline mode is enabled. Turn it off to contact metadata providers.');
    }
    if (request.provider === 'anilist') {
      // GraphQL requests use the provider's fixed endpoint below.
      const response = await safeFetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ query: request.query, variables: request.variables }),
      }, {
        allowedHosts: ['graphql.anilist.co'],
        maxBytes: 4 * 1024 * 1024,
        provider: 'anilist',
        operation: 'metadata.anilist.graphql',
      });
      return responseJson(response, 'AniList');
    }

    if (request.provider === 'cinemeta') {
      const meta = /^meta\/(movie|series)\/(tt\d{5,12})\.json$/.exec(request.path);
      if (meta) return fetchCinemetaMeta(meta[1] as 'movie' | 'series', meta[2]);
      if (!/^(?:manifest\.json|catalog\/(?:movie|series)\/(?:top|year|imdbRating)(?:\/[^/?#]+)?\.json)$/.test(request.path)
        || request.path.includes('..')) throw new Error('Cinemeta path is not allowed.');
      const fetchCatalog = async (url: string): Promise<unknown> => {
        const response = await safeFetch(url, {
          headers: { accept: 'application/json' },
        }, {
          allowedHosts: ['v3-cinemeta.strem.io', 'cinemeta-catalogs.strem.io'], maxBytes: 4 * 1024 * 1024,
          // These are interactive requests. A scan's host cooldown must not
          // prevent the user from explicitly retrying the catalog.
          ignoreSkipWindow: true,
          retries: 1, provider: 'cinemeta', operation: 'metadata.cinemeta.catalog',
        });
        return responseJson(response, 'Cinemeta');
      };
      // The unfiltered popular catalogs redirect to this fixed CDN path.
      // Avoid an extra DNS/TLS request on the most common browse operation.
      // Keep other routes on the official router, including search and genres.
      if (/^catalog\/(?:movie|series)\/top\.json$/.test(request.path)) {
        try { return await fetchCatalog(`https://cinemeta-catalogs.strem.io/top/${request.path}`); }
        catch { /* Fall back if Cinemeta changes its CDN routing. */ }
      }
      return fetchCatalog(`https://v3-cinemeta.strem.io/${request.path}`);
    }

    if (request.provider === 'omdb') {
      const settings = deps.loadSettings();
      const apiKey = deps.getMetadataApiKey(settings, 'omdb');
      if (!apiKey) throw new Error('OMDb API key is missing.');
      const url = queryUrl('https://www.omdbapi.com/', { ...request.query, apikey: apiKey });
      return requestRatingsProvider('omdb', apiKey, url);
    }

    if (request.provider === 'mdblist') {
      const key = deps.getMetadataApiKey(deps.loadSettings(), 'mdblist');
      if (!key) throw new Error('MDBList API key is missing.');
      const url = queryUrl(`https://api.mdblist.com/imdb/${request.type === 'series' ? 'show' : 'movie'}/${request.imdbId}`, { apikey: key });
      return requestRatingsProvider('mdblist', key, url);
    }

    if (request.provider === 'jikan') {
      if (!JIKAN_PATHS.has(request.path)) throw new Error('Jikan path is not allowed.');
      const url = queryUrl(`https://api.jikan.moe/v4/${request.path}`, request.query);
      const response = await safeFetch(url, { headers: { accept: 'application/json' } }, {
        allowedHosts: ['api.jikan.moe'],
        maxBytes: 4 * 1024 * 1024,
        retries: 2,
        timeoutMs: 5_000,
        provider: 'jikan',
        operation: `metadata.jikan.${request.path.replaceAll('/', '.')}`,
      });
      return responseJson(response, 'Jikan');
    }

    if (request.provider === 'tvmaze') {
      if (!TVMAZE_PATHS.has(request.path) && !/^shows\/[1-9]\d{0,9}$/.test(request.path)) throw new Error('TVmaze path is not allowed.');
      const url = queryUrl(`https://api.tvmaze.com/${request.path}`, request.query);
      const response = await safeFetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'LoomTV/desktop' },
      }, {
        allowedHosts: ['api.tvmaze.com'],
        maxBytes: 4 * 1024 * 1024,
        retries: 2,
        provider: 'tvmaze',
        operation: `metadata.tvmaze.${request.path.replaceAll('/', '.')}`,
      });
      return responseJson(response, 'TVmaze');
    }

    if (!TMDB_PATH_PATTERN.test(request.path) || request.path.includes('..')) {
      throw new Error('TMDB path is not allowed.');
    }
    const credential = deps.getMetadataApiKey(deps.loadSettings(), 'tmdb');
    if (!credential) throw new Error('TMDB API key is missing.');
    const url = queryUrl(`https://api.themoviedb.org/3/${request.path}`, {
      language: 'en-US',
      ...(request.query || {}),
    });
    const isBearer = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential);
    if (!isBearer) url.searchParams.set('api_key', credential);
    const response = await safeFetch(url, isBearer ? { headers: { authorization: `Bearer ${credential}` } } : {}, {
      allowedHosts: ['api.themoviedb.org'],
      retries: 2,
      provider: 'tmdb',
      operation: 'metadata.tmdb.request',
    });
    return responseJson(response, 'TMDB');
  };
}
