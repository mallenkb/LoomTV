import { yearFromDateString } from './helpers';
import type { EpisodeMeta, OriginPlatform, TVMetadata } from './types';
import { safeFetch } from '../safeFetch';
import { preferredProviderLogoUrl } from '../../shared/providerLogos';

interface TVMazeImage {
  medium?: string;
  original?: string;
}

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
  externals?: { imdb?: string; thetvdb?: string | number };
  network?: TVMazePlatform | null;
  webChannel?: TVMazePlatform | null;
  _embedded?: { seasons?: TVMazeSeason[]; cast?: TVMazeCastEntry[] };
}

interface TVMazeSearchEntry {
  show?: TVMazeShow;
}

function originPlatformFromShow(show: TVMazeShow): OriginPlatform | undefined {
  const platform = show.webChannel || show.network;
  const name = platform?.name?.trim();
  if (!name) return undefined;
  return {
    id: platform?.id,
    name,
    kind: show.webChannel ? 'web-channel' : 'network',
    countryCode: platform?.country?.code || undefined,
    countryName: platform?.country?.name || undefined,
    officialSite: platform?.officialSite || undefined,
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
  const episodes = (await episodesRes.json()) as TVMazeEpisode[];
  if (!Array.isArray(episodes)) return [];
  return episodes.map(tvmazeEpisodeToMeta).filter((episode) => episode.season > 0 && episode.number > 0);
}

async function fetchTVMetadataById(showId: number, fallbackTitle: string, localYear?: number): Promise<TVMetadata | null> {
  const detailRes = await safeFetch(
    `https://api.tvmaze.com/shows/${showId}?embed[]=seasons&embed[]=cast`,
    {},
    { allowedHosts: ['api.tvmaze.com'], retries: 2 },
  );
  if (!detailRes.ok) return null;
  const [details, episodes] = await Promise.all([
    detailRes.json() as Promise<TVMazeShow>,
    fetchTVEpisodesById(showId),
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
  const posterUrl = details.image?.medium || details.image?.original || '';

  return {
    title: details.name || fallbackTitle,
    providerIds: {
      tvmazeId: String(showId),
      imdbId: details.externals?.imdb || undefined,
      tvdbId: details.externals?.thetvdb ? String(details.externals.thetvdb) : undefined,
    },
    poster: posterUrl,
    backdrop: '',
    summary: details.summary ? details.summary.replace(/<[^>]*>/g, '') : '',
    rating: details.rating?.average || 0,
    genres: details.genres || [],
    cast,
    year: details.premiered ? new Date(details.premiered).getFullYear() : (localYear || 0),
    language: details.language || '',
    country: details.network?.country?.name || details.webChannel?.country?.name || '',
    showType: details.type || '',
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
    const searchData = (await searchRes.json()) as TVMazeSearchEntry[];
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
    const searchData = (await searchRes.json()) as TVMazeSearchEntry[];
    if (!Array.isArray(searchData) || searchData.length === 0) return [];

    return await Promise.all(searchData.slice(0, 6).map(async (result) => {
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
        originPlatform: originPlatformFromShow(show),
      };
    }));
  } catch (error) {
    console.error('TVmaze candidates fetch error:', error);
    return [];
  }
}
