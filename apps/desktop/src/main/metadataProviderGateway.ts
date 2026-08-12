import type { AppSettings } from './appContracts.ts';
import type { MetadataProviderRequest } from '../shared/desktopProtocol.ts';
import { safeFetch } from './safeFetch.ts';
import { z } from 'zod';

type GatewayDependencies = {
  loadSettings: () => AppSettings;
  getMetadataApiKey: (settings: AppSettings, providerId: string) => string | undefined;
};

const TMDB_PATH_PATTERN = /^[a-z0-9_/-]+$/i;
const finiteNumber = z.number().finite();
export const metadataProviderRequestSchema: z.ZodType<MetadataProviderRequest> = z.discriminatedUnion('provider', [
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
    const settings = deps.loadSettings();
    if (settings.metadataOfflineMode) {
      throw new Error('Metadata offline mode is enabled. Turn it off to contact metadata providers.');
    }
    if (request.provider === 'anilist') {
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

    if (request.provider === 'omdb') {
      const apiKey = deps.getMetadataApiKey(settings, 'omdb');
      if (!apiKey) throw new Error('OMDb API key is missing.');
      const url = queryUrl('https://www.omdbapi.com/', { ...request.query, apikey: apiKey });
      const response = await safeFetch(url, {}, {
        allowedHosts: ['www.omdbapi.com'],
        retries: 2,
        provider: 'omdb',
        operation: 'metadata.omdb.lookup',
      });
      return responseJson(response, 'OMDb');
    }

    if (!TMDB_PATH_PATTERN.test(request.path) || request.path.includes('..')) {
      throw new Error('TMDB path is not allowed.');
    }
    const credential = deps.getMetadataApiKey(settings, 'tmdb');
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
