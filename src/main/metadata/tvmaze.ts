import { yearFromDateString } from './helpers';
import type { EpisodeMeta, TVMetadata } from './types';

function tvmazeEpisodeToMeta(episode: any): EpisodeMeta {
  return {
    season: episode.season,
    number: episode.number,
    title: episode.name || '',
    summary: episode.summary ? episode.summary.replace(/<[^>]*>/g, '') : '',
    still: episode.image?.medium || episode.image?.original || '',
    rating: episode.rating?.average || 0,
    airDate: episode.airdate || '',
  };
}

async function fetchTVEpisodesById(showId: number): Promise<EpisodeMeta[]> {
  const episodesRes = await fetch(`https://api.tvmaze.com/shows/${showId}/episodes`);
  if (!episodesRes.ok) return [];
  const episodes: any[] = await episodesRes.json();
  if (!Array.isArray(episodes)) return [];
  return episodes.map(tvmazeEpisodeToMeta).filter((episode) => episode.season > 0 && episode.number > 0);
}

async function fetchTVMetadataById(showId: number, fallbackTitle: string, localYear?: number): Promise<TVMetadata | null> {
  const detailRes = await fetch(
    `https://api.tvmaze.com/shows/${showId}?embed[]=seasons&embed[]=cast`,
  );
  if (!detailRes.ok) return null;
  const [details, episodes] = await Promise.all([
    detailRes.json(),
    fetchTVEpisodesById(showId),
  ]);

  const seasons = (details._embedded?.seasons || [])
    .filter((s: any) => s.number > 0)
    .map((s: any) => ({
      number: s.number,
      title: s.name || `Season ${s.number}`,
        episodeCount: s.episodeOrder || 0,
      }));

  const cast = (details._embedded?.cast || []).slice(0, 6).map((c: any) => ({
    name: c.person?.name || '',
    character: c.character?.name || '',
    image: c.person?.image?.medium || '',
  }));

  const posterUrl = details.image?.original || details.image?.medium || '';

  return {
    title: details.name || fallbackTitle,
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
    seasons: seasons.length > 0 ? seasons : undefined,
    episodes,
  };
}

export async function fetchTVMetadata(title: string, localYear?: number): Promise<TVMetadata | null> {
  try {
    const searchRes = await fetch(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`,
    );
    const searchData: any[] = await searchRes.json();
    if (!searchData || searchData.length === 0) return null;

    let show = searchData[0].show;
    if (localYear) {
      const yearMatch = searchData.find((r: any) => {
        const premiered = r.show?.premiered;
        return premiered && new Date(premiered).getFullYear() === localYear;
      });
      if (yearMatch) show = yearMatch.show;
    }

    return fetchTVMetadataById(show.id, show.name || title, localYear);
  } catch (error) {
    console.error('TVmaze fetch error:', error);
    return null;
  }
}

export async function fetchTVMetadataCandidates(title: string, localYear?: number): Promise<TVMetadata[]> {
  try {
    const searchRes = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`);
    const searchData: any[] = await searchRes.json();
    if (!Array.isArray(searchData) || searchData.length === 0) return [];

    return await Promise.all(searchData.slice(0, 6).map(async (result: any) => {
      const show = result.show || {};
      if (show.id) {
        const details = await fetchTVMetadataById(show.id, show.name || title, localYear);
        if (details) return details;
      }
      return {
        title: show.name || title,
        poster: show.image?.original || show.image?.medium || '',
        backdrop: '',
        summary: show.summary ? String(show.summary).replace(/<[^>]*>/g, '') : '',
        rating: show.rating?.average || 0,
        genres: show.genres || [],
        cast: [],
        year: show.premiered ? yearFromDateString(show.premiered) : (localYear || 0),
        language: show.language || '',
        country: show.network?.country?.name || show.webChannel?.country?.name || '',
        showType: show.type || '',
      };
    }));
  } catch (error) {
    console.error('TVmaze candidates fetch error:', error);
    return [];
  }
}
