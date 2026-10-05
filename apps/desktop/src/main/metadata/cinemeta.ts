import { z } from 'zod';
import { safeFetch } from '../safeFetch.ts';
import type { EpisodeMeta } from './types.ts';

/**
 * Stremio's Cinemeta catalog, looked up by IMDb ID. It needs no API key and
 * supplies a poster, background, logo, description, trailer and a dated
 * episode list with thumbnails, used as one more source for library titles.
 */

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io/meta';

const cinemetaSchema = z.object({
  meta: z.object({
    name: z.string().nullable().optional(),
    poster: z.string().nullable().optional(),
    background: z.string().nullable().optional(),
    logo: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    imdbRating: z.string().nullable().optional(),
    genres: z.array(z.string()).nullable().optional(),
    trailerStreams: z.array(z.object({ ytId: z.string().nullable().optional() }).nullable()).nullable().optional(),
    videos: z.array(z.object({
      season: z.union([z.number(), z.string()]).nullable().optional(),
      episode: z.union([z.number(), z.string()]).nullable().optional(),
      number: z.union([z.number(), z.string()]).nullable().optional(),
      name: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      released: z.string().nullable().optional(),
      firstAired: z.string().nullable().optional(),
      thumbnail: z.string().nullable().optional(),
      overview: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      rating: z.union([z.number(), z.string()]).nullable().optional(),
    }).nullable()).nullable().optional(),
  }).nullable().optional(),
});

export type CinemetaMeta = {
  title: string;
  poster: string;
  backdrop: string;
  logo: string;
  summary: string;
  rating: number;
  genres: string[];
  trailerUrl?: string;
  episodes: EpisodeMeta[];
};

const https = (value?: string | null) => value?.trim().replace(/^http:\/\//i, 'https://') || '';
const integer = (value: unknown) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : -1;
};
const day = (value?: string | null) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '');

export async function fetchCinemetaMeta(type: 'series' | 'movie', imdbId: string | undefined): Promise<CinemetaMeta | null> {
  const id = imdbId?.trim();
  if (!id || !/^tt\d{5,12}$/.test(id)) return null;
  const response = await safeFetch(`${CINEMETA_BASE}/${type}/${id}.json`, { headers: { accept: 'application/json' } }, {
    allowedHosts: ['v3-cinemeta.strem.io'],
    timeoutMs: 8_000,
    maxBytes: 4 * 1024 * 1024,
    retries: 1,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cinemeta request failed: ${response.status}`);
  const meta = cinemetaSchema.parse(await response.json()).meta;
  if (!meta) return null;
  const trailerId = meta.trailerStreams?.find((stream) => stream?.ytId && /^[\w-]{6,20}$/.test(stream.ytId))?.ytId;
  return {
    title: meta.name?.trim() || '',
    poster: https(meta.poster),
    backdrop: https(meta.background),
    logo: https(meta.logo),
    summary: meta.description?.trim() || '',
    rating: Number.parseFloat(meta.imdbRating || '') || 0,
    genres: (meta.genres || []).filter(Boolean),
    trailerUrl: trailerId ? `https://www.youtube.com/watch?v=${trailerId}` : undefined,
    episodes: (meta.videos || []).flatMap((video) => {
      const season = integer(video?.season);
      const number = integer(video?.episode ?? video?.number);
      if (!video || season < 0 || number <= 0) return [];
      return [{
        season,
        number,
        title: (video.name || video.title || '').trim(),
        summary: (video.overview || video.description || '').trim(),
        still: https(video.thumbnail),
        rating: Number.parseFloat(String(video.rating ?? '')) || 0,
        airDate: day(video.released || video.firstAired),
      }];
    }),
  };
}
