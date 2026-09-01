import { yearFromDateString } from './helpers.ts';
import type { EpisodeMeta, OriginPlatform, TVMetadata } from './types.ts';
import { safeFetch } from '../safeFetch.ts';
import { preferredProviderLogoUrl } from '../../shared/providerLogos.ts';
import { z } from 'zod';

interface TVMazeImage {
  medium?: string;
  original?: string;
}

interface TVMazeGalleryImage {
  type?: string | null;
  main?: boolean;
  resolutions?: {
    original?: { url?: string; width?: number; height?: number } | null;
    medium?: { url?: string; width?: number; height?: number } | null;
  };
}

type TVMazeArtwork = {
  posterCandidates: string[];
  backdropCandidates: string[];
  logoCandidates: string[];
};

interface TVMazeEpisode {
  season?: number;
  number?: number;
  name?: string;
  summary?: string;
  image?: TVMazeImage;
  rating?: { average?: number };
  airdate?: string;
}

interface TVMazeSeason {
  number?: number;
  name?: string;
  episodeOrder?: number;
}

interface TVMazeCastEntry {
  person?: { name?: string; image?: TVMazeImage };
  character?: { name?: string };
}

interface TVMazePlatform {
  id?: number;
  name?: string;
  officialSite?: string | null;
  country?: {
    code?: string;
    name?: string;
  } | null;
}

interface TVMazeShow {
  id?: number;
  name?: string;
  image?: TVMazeImage;
  summary?: string;
  rating?: { average?: number };
  genres?: string[];
  premiered?: string;
  language?: string;
  type?: string;
  status?: string;
  externals?: { imdb?: string; thetvdb?: string | number };
  network?: TVMazePlatform | null;
  webChannel?: TVMazePlatform | null;
  _embedded?: { seasons?: TVMazeSeason[]; cast?: TVMazeCastEntry[] };
}

interface TVMazeSearchEntry {
  show?: TVMazeShow;
}

const tvMazeImageSchema: z.ZodType<TVMazeImage> = z.object({
  medium: z.string().optional(),
  original: z.string().optional(),
});
const tvMazeGalleryResolutionSchema = z.object({
  url: z.string().optional(),
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
});
const tvMazeGalleryImageSchema: z.ZodType<TVMazeGalleryImage> = z.object({
  type: z.string().nullable().optional(),
  main: z.boolean().optional(),
  resolutions: z.object({
    original: tvMazeGalleryResolutionSchema.nullable().optional(),
    medium: tvMazeGalleryResolutionSchema.nullable().optional(),
  }).optional(),
});
const nullableString = z.string().nullable().optional().transform((value) => value ?? undefined);
const nullableNumber = z.number().finite().nullable().optional().transform((value) => value ?? undefined);
const tvMazeEpisodeSchema: z.ZodType<TVMazeEpisode> = z.object({
  season: z.number().finite().optional(),
  number: z.number().finite().optional(),
  name: z.string().optional(),
  summary: nullableString,
  image: tvMazeImageSchema.nullable().optional().transform((value) => value ?? undefined),
  rating: z.object({ average: nullableNumber }).optional(),
  airdate: z.string().optional(),
});
const tvMazePlatformSchema: z.ZodType<TVMazePlatform> = z.object({
  id: z.number().finite().optional(),
  name: z.string().optional(),
  officialSite: z.string().nullable().optional(),
  country: z.object({
    code: z.string().optional(),
    name: z.string().optional(),
  }).nullable().optional(),
});
const tvMazeShowSchema: z.ZodType<TVMazeShow> = z.object({
  id: z.number().finite().optional(),
  name: z.string().optional(),
  image: tvMazeImageSchema.nullable().optional().transform((value) => value ?? undefined),
  summary: nullableString,
  rating: z.object({ average: nullableNumber }).optional(),
  genres: z.array(z.string()).optional(),
  premiered: nullableString,
  language: nullableString,
  type: z.string().optional(),
  status: nullableString,
  externals: z.object({
    imdb: nullableString,
    thetvdb: z.union([z.string(), z.number().finite()]).nullable().optional().transform((value) => value ?? undefined),
  }).optional(),
  network: tvMazePlatformSchema.nullable().optional(),
  webChannel: tvMazePlatformSchema.nullable().optional(),
  _embedded: z.object({
    seasons: z.array(z.object({ number: z.number().finite().optional(), name: z.string().optional(), episodeOrder: nullableNumber })).optional(),
    cast: z.array(z.object({
      person: z.object({ name: z.string().optional(), image: tvMazeImageSchema.nullable().optional().transform((value) => value ?? undefined) }).optional(),
      character: z.object({ name: z.string().optional() }).optional(),
    })).optional(),
  }).optional(),
});
const tvMazeSearchSchema: z.ZodType<TVMazeSearchEntry[]> = z.array(z.object({ show: tvMazeShowSchema.optional() }));

export function tvMazeShowIsEnded(status?: string | null): boolean {
  return status?.trim().toLowerCase() === 'ended';
}

function originPlatformFromShow(show: TVMazeShow): OriginPlatform | undefined {
  const platform = show.webChannel ?? show.network;
  if (!platform) return undefined;

  const name = platform.name?.trim();
  if (!name) return undefined;

  return {
    id: platform.id,
    name,
    kind: show.webChannel ? 'web-channel' : 'network',
    countryCode: platform.country?.code || undefined,
    countryName: platform.country?.name || undefined,
    officialSite: platform.officialSite || undefined,
    logoUrl: preferredProviderLogoUrl({ name }),
    source: 'tvmaze',
  };
}

function tvmazeEpisodeToMeta(episode: TVMazeEpisode): EpisodeMeta {
  return {
    season: episode.season ?? 0,
    number: episode.number ?? 0,
    title: episode.name || '',
    summary: episode.summary ? episode.summary.replace(/<[^>]*>/g, '') : '',
    still: episode.image?.medium || episode.image?.original || '',
    rating: episode.rating?.average || 0,
    airDate: episode.airdate || '',
  };
}

async function fetchTVEpisodesById(showId: number): Promise<EpisodeMeta[]> {
  const episodesRes = await safeFetch(`https://api.tvmaze.com/shows/${showId}/episodes`, {}, {
    allowedHosts: ['api.tvmaze.com'],
    retries: 2,
  });
  if (!episodesRes.ok) return [];
  const episodes = z.array(tvMazeEpisodeSchema).parse(await episodesRes.json());
  return episodes.map(tvmazeEpisodeToMeta).filter((episode) => episode.season > 0 && episode.number > 0);
}

function uniqueUrls(urls: Array<string | null | undefined>): string[] {
  return [...new Set(urls.filter((url): url is string => Boolean(url?.trim())))];
}

async function fetchTVArtworkById(showId: number): Promise<TVMazeArtwork> {
  try {
    const response = await safeFetch(`https://api.tvmaze.com/shows/${showId}/images`, {}, {
      allowedHosts: ['api.tvmaze.com'],
      retries: 2,
    });
    if (!response.ok) return { posterCandidates: [], backdropCandidates: [], logoCandidates: [] };

    const images = z.array(tvMazeGalleryImageSchema).parse(await response.json());
    const urlsForType = (type: 'poster' | 'background' | 'typography') => uniqueUrls(
      images
        .filter((image) => image.type?.toLowerCase() === type)
        .sort((left, right) => Number(right.main) - Number(left.main))
        .map((image) => image.resolutions?.original?.url || image.resolutions?.medium?.url),
    );
    return {
      posterCandidates: urlsForType('poster'),
      backdropCandidates: urlsForType('background'),
      logoCandidates: urlsForType('typography'),
    };
  } catch (error) {
    console.error('TVmaze artwork fetch error:', error);
    return { posterCandidates: [], backdropCandidates: [], logoCandidates: [] };
  }
}

async function fetchTVMetadataById(showId: number, fallbackTitle: string, localYear?: number): Promise<TVMetadata | null> {
  const detailRes = await safeFetch(
    `https://api.tvmaze.com/shows/${showId}?embed[]=seasons&embed[]=cast`,
    {},
    { allowedHosts: ['api.tvmaze.com'], retries: 2 },
  );
  if (!detailRes.ok) return null;
  const [details, episodes, artwork] = await Promise.all([
    detailRes.json().then((value) => tvMazeShowSchema.parse(value)),
    fetchTVEpisodesById(showId),
    fetchTVArtworkById(showId),
  ]);

  const seasons = (details._embedded?.seasons || [])
    .filter((s) => (s.number ?? 0) > 0)
    .map((s) => ({
      number: s.number ?? 0,
      title: s.name || `Season ${s.number}`,
      episodeCount: s.episodeOrder || 0,
    }));

  const cast = (details._embedded?.cast || []).slice(0, 6).map((c) => ({
    name: c.person?.name || '',
    character: c.character?.name || '',
    image: c.person?.image?.medium || '',
  }));

  // TVmaze's medium portrait already exceeds LoomTV's 200px poster card and
  // detail-panel display size. Prefer it so Chromium does not decode the much
  // larger original for the same visible result.
  const posterCandidates = uniqueUrls([
    details.image?.original,
    details.image?.medium,
    ...artwork.posterCandidates,
  ]);
  const posterUrl = posterCandidates[0] || '';

  return {
    title: details.name || fallbackTitle,
    providerIds: {
      tvmazeId: String(showId),
      imdbId: details.externals?.imdb || undefined,
      tvdbId: details.externals?.thetvdb ? String(details.externals.thetvdb) : undefined,
    },
    poster: posterUrl,
    posterCandidates,
    backdrop: artwork.backdropCandidates[0] || '',
    backdropCandidates: artwork.backdropCandidates,
    logo: artwork.logoCandidates[0] || '',
    logoCandidates: artwork.logoCandidates,
    summary: details.summary ? details.summary.replace(/<[^>]*>/g, '') : '',
    rating: details.rating?.average || 0,
    genres: details.genres || [],
    cast,
    year: details.premiered ? new Date(details.premiered).getFullYear() : (localYear || 0),
    language: details.language || '',
    country: details.network?.country?.name || details.webChannel?.country?.name || '',
    showType: details.type || '',
    showStatus: details.status || '',
    originPlatform: originPlatformFromShow(details),
    seasons: seasons.length > 0 ? seasons : undefined,
    episodes,
  };
}

export async function fetchTVMetadata(title: string, localYear?: number): Promise<TVMetadata | null> {
  try {
    const searchRes = await safeFetch(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`,
      {},
      { allowedHosts: ['api.tvmaze.com'], retries: 2 },
    );
    const searchData = tvMazeSearchSchema.parse(await searchRes.json());
    if (!searchData || searchData.length === 0) return null;

    let show = searchData[0]?.show;
    if (localYear) {
      const yearMatch = searchData.find((r) => {
        const premiered = r.show?.premiered;
        return premiered && new Date(premiered).getFullYear() === localYear;
      });
      if (yearMatch?.show) show = yearMatch.show;
    }

    if (!show?.id) return null;
    return fetchTVMetadataById(show.id, show.name || title, localYear);
  } catch (error) {
    console.error('TVmaze fetch error:', error);
    return null;
  }
}

export async function fetchTVMetadataCandidates(title: string, localYear?: number): Promise<TVMetadata[]> {
  try {
    const searchRes = await safeFetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`, {}, {
      allowedHosts: ['api.tvmaze.com'],
      retries: 2,
    });
    const searchData = tvMazeSearchSchema.parse(await searchRes.json());
    if (searchData.length === 0) return [];

    return await Promise.all(searchData.map(async (result) => {
      const show: TVMazeShow = result.show ?? {};
      if (show.id) {
        const details = await fetchTVMetadataById(show.id, show.name || title, localYear);
        if (details) return details;
      }
      return {
        title: show.name || title,
        poster: show.image?.medium || show.image?.original || '',
        backdrop: '',
        summary: show.summary ? String(show.summary).replace(/<[^>]*>/g, '') : '',
        rating: show.rating?.average || 0,
        genres: show.genres || [],
        cast: [],
        year: show.premiered ? yearFromDateString(show.premiered) : (localYear || 0),
        language: show.language || '',
        country: show.network?.country?.name || show.webChannel?.country?.name || '',
        showType: show.type || '',
        showStatus: show.status || '',
        originPlatform: originPlatformFromShow(show),
      };
    }));
  } catch (error) {
    console.error('TVmaze candidates fetch error:', error);
    return [];
  }
}
