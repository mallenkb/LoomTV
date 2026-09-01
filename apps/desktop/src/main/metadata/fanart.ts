import { z } from 'zod';

const FANART_BASE = 'https://webservice.fanart.tv/v3';

type FanartImage = {
  url?: string;
  lang?: string;
  likes?: string | number;
};

function normalizeFanartKey(value?: string): string {
  return (value || '').trim();
}

interface FanartResponse {
  hdmovielogo?: FanartImage[];
  movieposter?: FanartImage[];
  moviebackground?: FanartImage[];
  hdtvlogo?: FanartImage[];
  tvposter?: FanartImage[];
  showbackground?: FanartImage[];
}

export type FanartArtwork = {
  posterCandidates: string[];
  backdropCandidates: string[];
  logoCandidates: string[];
};

const fanartImageSchema: z.ZodType<FanartImage> = z.object({
  url: z.string().optional(),
  lang: z.string().optional(),
  likes: z.union([z.string(), z.number().finite()]).optional(),
});
const fanartResponseSchema: z.ZodType<FanartResponse> = z.object({
  hdmovielogo: z.array(fanartImageSchema).optional(),
  movieposter: z.array(fanartImageSchema).optional(),
  moviebackground: z.array(fanartImageSchema).optional(),
  hdtvlogo: z.array(fanartImageSchema).optional(),
  tvposter: z.array(fanartImageSchema).optional(),
  showbackground: z.array(fanartImageSchema).optional(),
});

async function fetchFanartJson(path: string, apiKey?: string): Promise<FanartResponse | null> {
  const key = normalizeFanartKey(apiKey);
  if (!key) return null;

  const url = new URL(`${FANART_BASE}/${path}`);
  url.searchParams.set('api_key', key);

  const response = await safeFetch(url, {}, { allowedHosts: ['webservice.fanart.tv'], retries: 2 });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Fanart.tv request failed with ${response.status}`);
  return fanartResponseSchema.parse(await response.json());
}

function imageUrls(images: FanartImage[]): string[] {
  const sorted = images
    .filter((image) => image?.url)
    .sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0))
    .sort((a, b) => {
      const leftLanguageScore = !a.lang || a.lang === 'en' ? 1 : 0;
      const rightLanguageScore = !b.lang || b.lang === 'en' ? 1 : 0;
      return rightLanguageScore - leftLanguageScore;
    });
  return Array.from(new Set(sorted.map((image) => String(image.url).replace(/^http:\/\//i, 'https://'))));
}

export async function fetchFanartMovieArtwork(
  tmdbId: string | undefined,
  apiKey?: string,
): Promise<FanartArtwork> {
  if (!tmdbId) return { posterCandidates: [], backdropCandidates: [], logoCandidates: [] };
  try {
    const data = await fetchFanartJson(`movies/${encodeURIComponent(tmdbId)}`, apiKey);
    return {
      posterCandidates: imageUrls(data?.movieposter || []),
      backdropCandidates: imageUrls(data?.moviebackground || []),
      logoCandidates: imageUrls(data?.hdmovielogo || []),
    };
  } catch (err) {
    console.error('[Fanart.tv movie artwork]', err);
    return { posterCandidates: [], backdropCandidates: [], logoCandidates: [] };
  }
}

export async function fetchFanartTVArtwork(
  tvdbId: string | undefined,
  apiKey?: string,
): Promise<FanartArtwork> {
  if (!tvdbId) return { posterCandidates: [], backdropCandidates: [], logoCandidates: [] };
  try {
    const data = await fetchFanartJson(`tv/${encodeURIComponent(tvdbId)}`, apiKey);
    return {
      posterCandidates: imageUrls(data?.tvposter || []),
      backdropCandidates: imageUrls(data?.showbackground || []),
      logoCandidates: imageUrls(data?.hdtvlogo || []),
    };
  } catch (err) {
    console.error('[Fanart.tv TV artwork]', err);
    return { posterCandidates: [], backdropCandidates: [], logoCandidates: [] };
  }
}

export async function fetchFanartMovieLogos(
  tmdbId: string | undefined,
  apiKey?: string,
): Promise<string[]> {
  return (await fetchFanartMovieArtwork(tmdbId, apiKey)).logoCandidates;
}

export async function fetchFanartTVLogos(
  tvdbId: string | undefined,
  apiKey?: string,
): Promise<string[]> {
  return (await fetchFanartTVArtwork(tvdbId, apiKey)).logoCandidates;
}
import { safeFetch } from '../safeFetch.ts';
