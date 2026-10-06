import { z } from 'zod';
import { safeFetch } from '../safeFetch.ts';
import { remoteMatchesAnyLocalTitle } from './helpers.ts';
import type { EpisodeMeta, MediaItem } from './types.ts';

const CATALOG_ORIGIN = 'https://v3-cinemeta.strem.io';
const METADATA_ORIGIN = 'https://cinemeta-live.strem.io';
const IMDB_ID = /^tt\d{5,12}$/;
const MAX_CANDIDATES = 5;
const optionalText = z.string().nullable().optional();
const videoSchema = z.object({
  id: z.string(),
  title: optionalText,
  name: optionalText,
  season: z.number().int().nonnegative().nullable().optional(),
  episode: z.number().int().positive().nullable().optional(),
  number: z.number().int().positive().nullable().optional(),
  overview: optionalText,
  description: optionalText,
  thumbnail: optionalText,
  released: optionalText,
  firstAired: optionalText,
  imdbRating: z.union([z.string(), z.number().finite()]).nullable().optional(),
  rating: z.union([z.string(), z.number().finite()]).nullable().optional(),
});
const metaSchema = z.object({
  id: z.string().regex(IMDB_ID),
  type: z.enum(['movie', 'series']),
  name: z.string().trim().min(1),
  poster: optionalText,
  background: optionalText,
  logo: optionalText,
  description: optionalText,
  releaseInfo: optionalText,
  released: optionalText,
  runtime: optionalText,
  imdbRating: z.union([z.string(), z.number().finite()]).nullable().optional(),
  genres: z.array(z.string()).max(100).nullable().optional(),
  cast: z.array(z.string()).max(500).nullable().optional(),
  videos: z.array(videoSchema).max(20_000).nullable().optional(),
});
type CinemetaMeta = z.infer<typeof metaSchema>;

function artworkUrl(value?: string | null): string {
  if (!value || value.length > 8192) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function metadataYear(meta: CinemetaMeta): number | undefined {
  const value = meta.releaseInfo?.match(/^\d{4}/)?.[0] || meta.released?.match(/^\d{4}/)?.[0];
  return value ? Number(value) : undefined;
}

function normalizeMetadata(meta: CinemetaMeta): Partial<MediaItem> {
  const poster = artworkUrl(meta.poster);
  const backdrop = artworkUrl(meta.background);
  const logo = artworkUrl(meta.logo);
  const rating = Number(meta.imdbRating);
  const episodesByKey = new Map<string, EpisodeMeta>();
  if (meta.type === 'series') {
    for (const video of meta.videos || []) {
      const parts = /^tt\d+:(\d+):(\d+)$/.exec(video.id);
      const season = video.season ?? (parts ? Number(parts[1]) : undefined);
      const number = video.episode ?? video.number ?? (parts ? Number(parts[2]) : undefined);
      if (season === undefined || number === undefined || number < 1) continue;
      if (parts && (season !== Number(parts[1]) || number !== Number(parts[2]))) continue;
      const episodeRating = Number(video.imdbRating ?? video.rating);
      episodesByKey.set(`${season}-${number}`, {
        season, number,
        title: video.title?.trim() || video.name?.trim() || '',
        summary: video.overview?.trim() || video.description?.trim() || '',
        still: artworkUrl(video.thumbnail),
        rating: Number.isFinite(episodeRating) && episodeRating > 0 && episodeRating <= 10 ? episodeRating : 0,
        airDate: (video.released || video.firstAired)?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '',
      });
    }
  }
  const episodes = [...episodesByKey.values()].sort((left, right) => left.season - right.season || left.number - right.number);
  const seasonNumbers = [...new Set(episodes.map((episode) => episode.season))].sort((left, right) => left - right);
  return {
    title: meta.name,
    year: metadataYear(meta),
    providerIds: { imdbId: meta.id },
    poster, backdrop, logo,
    posterCandidates: poster ? [poster] : [],
    backdropCandidates: backdrop ? [backdrop] : [],
    logoCandidates: logo ? [logo] : [],
    summary: meta.description?.trim() || '',
    rating: Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating : 0,
    providerRatings: Number.isFinite(rating) && rating > 0 && rating <= 10
      ? { imdb: { value: rating, scale: 10 } } : undefined,
    runtime: meta.runtime?.trim() || undefined,
    genres: meta.genres || [],
    cast: (meta.cast || []).map((name) => ({ name, character: '', image: '' })),
    ...(episodes.length ? {
      episodes,
      episodeCount: episodes.length,
      seasonCount: seasonNumbers.filter((season) => season > 0).length,
      seasons: seasonNumbers.map((number) => ({
        number, title: number === 0 ? 'Specials' : `Season ${number}`,
        episodeCount: episodes.filter((episode) => episode.season === number).length,
      })),
    } : {}),
  };
}

async function requestJson(resource: string): Promise<unknown> {
  const request = async (origin: string): Promise<unknown> => {
    const response = await safeFetch(`${origin}/${resource}`, { headers: { accept: 'application/json', 'user-agent': 'LoomTV' } }, {
      allowedHosts: ['v3-cinemeta.strem.io', 'cinemeta-catalogs.strem.io', 'cinemeta-live.strem.io'],
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 15_000,
      retries: 1,
      maxRedirects: 1,
      provider: 'cinemeta',
      operation: 'metadata.cinemeta.lookup',
    });
    if (!response.ok) throw new Error(`Cinemeta request failed with status ${response.status}.`);
    return response.json() as Promise<unknown>;
  };
  if (!resource.startsWith('meta/')) return request(CATALOG_ORIGIN);
  try {
    return await request(METADATA_ORIGIN);
  } catch {
    return request(CATALOG_ORIGIN);
  }
}

export async function fetchCinemetaMetadataCandidates(
  title: string,
  type: 'movie' | 'series',
  year?: number,
  imdbId?: string,
  localTitles: string[] = [],
): Promise<Array<Partial<MediaItem>>> {
  const searchTitles = [...new Set([title, ...localTitles].map((value) => value.trim()).filter(Boolean))].slice(0, 3);
  const existingId = imdbId && IMDB_ID.test(imdbId) ? imdbId : undefined;
  const [known, catalogs] = await Promise.all([
    existingId ? requestJson(`meta/${type}/${existingId}.json`).then((value) => {
      const result = z.object({ meta: metaSchema.nullable() }).safeParse(value);
      return result.success && result.data.meta?.id === existingId && result.data.meta.type === type ? result.data.meta : null;
    }).catch(() => null) : Promise.resolve(null),
    Promise.all(searchTitles.map(async (query) => {
      try {
        const value = await requestJson(`catalog/${type}/top/search=${encodeURIComponent(query)}.json`);
        const response = z.object({ metas: z.array(z.unknown()).max(1000) }).parse(value);
        return response.metas.flatMap((entry) => {
          const parsed = metaSchema.safeParse(entry);
          return parsed.success && parsed.data.type === type
            && remoteMatchesAnyLocalTitle(searchTitles, parsed.data.name) ? [parsed.data] : [];
        });
      } catch {
        return [];
      }
    })),
  ]);
  const previews = [...new Map(catalogs.flat().map((meta) => [meta.id, meta])).values()]
    .filter((meta) => meta.id !== existingId || !known)
    .sort((left, right) => Number(metadataYear(right) === year) - Number(metadataYear(left) === year))
    .slice(0, MAX_CANDIDATES - (known ? 1 : 0));
  const detailed = await Promise.all(previews.map(async (preview) => {
    try {
      const result = z.object({ meta: metaSchema }).parse(await requestJson(`meta/${type}/${preview.id}.json`));
      return result.meta.id === preview.id && result.meta.type === type ? { ...preview, ...result.meta } : preview;
    } catch {
      return preview;
    }
  }));
  return (known ? [known, ...detailed] : detailed).map(normalizeMetadata);
}
