import { yearFromDateString } from './helpers';
import type { EpisodeMeta, MediaItem } from './types';

export interface JikanAnimeResult extends Partial<MediaItem> {
  episodes?: EpisodeMeta[];
  malId?: number;
  aliases?: string[];
}

/** Respect Jikan's public rate limit (3 req/sec). */
const _jikan = { lastCallAt: 0 };
async function jikanDelay(): Promise<void> {
  const MIN_GAP = 350;
  const wait = MIN_GAP - (Date.now() - _jikan.lastCallAt);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  _jikan.lastCallAt = Date.now();
}

async function jikanFetch(path: string): Promise<any> {
  await jikanDelay();
  const res = await fetch(`https://api.jikan.moe/v4${path}`);
  if (!res.ok) throw new Error(`Jikan ${path} → ${res.status}`);
  return res.json();
}

function isGenericEpisodeTitle(value: unknown, episodeNumber: number): boolean {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === `episode ${episodeNumber}`
    || normalized === `ep ${episodeNumber}`
    || normalized === `episode ${String(episodeNumber).padStart(2, '0')}`
    || normalized === `ep ${String(episodeNumber).padStart(2, '0')}`;
}

function resolveJikanEpisodeTitle(episode: any): string {
  const episodeNumber = Number(episode?.mal_id) || 0;
  const candidates = [
    episode?.title,
    episode?.title_romanji,
    episode?.title_japanese,
  ];
  const specificTitle = candidates.find((candidate) => !isGenericEpisodeTitle(candidate, episodeNumber));
  return typeof specificTitle === 'string' ? specificTitle.trim() : `Episode ${episodeNumber}`;
}

export async function fetchJikanEpisodes(malId: number, maxPages = 3): Promise<EpisodeMeta[]> {
  const episodes: EpisodeMeta[] = [];
  let page = 1;
  let hasNextPage = true;
  while (hasNextPage && page <= maxPages) {
    const epData: any = await jikanFetch(`/anime/${malId}/episodes?page=${page}`);
    const epList: any[] = epData.data ?? [];
    episodes.push(
      ...epList.map((e: any) => ({
        season: 1,
        number: e.mal_id as number,
        title: resolveJikanEpisodeTitle(e),
        summary: '',
        still: '',
        rating: (e.score as number) || 0,
        airDate: e.aired ? String(e.aired).split('T')[0] : '',
      })),
    );
    hasNextPage = epData.pagination?.has_next_page === true;
    page++;
  }
  return episodes;
}

export async function fetchJikanMetadata(title: string): Promise<JikanAnimeResult | null> {
  try {
    const searchData: any = await jikanFetch(
      `/anime?q=${encodeURIComponent(title)}&limit=5&sfw`,
    );
    const hit: any = searchData.data?.[0];
    if (!hit) return null;

    const malId: number = hit.mal_id;
    const poster: string =
      hit.images?.jpg?.large_image_url || hit.images?.jpg?.image_url || '';

    let cast: MediaItem['cast'] = [];
    try {
      const charData: any = await jikanFetch(`/anime/${malId}/characters`);
      cast = ((charData.data ?? []) as any[])
        .filter((c: any) => c.role === 'Main')
        .slice(0, 8)
        .map((c: any) => ({
          name: c.character?.name ?? '',
          character: c.character?.name ?? '',
          image: c.character?.images?.jpg?.image_url ?? '',
        }));
    } catch { /* cast is optional */ }

    let episodes: EpisodeMeta[] = [];
    try {
      episodes = await fetchJikanEpisodes(malId, 3);
    } catch { /* episodes are optional */ }

    return {
      malId,
      title: (hit.title_english as string) || (hit.title as string) || title,
      aliases: [
        hit.title,
        hit.title_english,
        hit.title_japanese,
        ...(Array.isArray(hit.title_synonyms) ? hit.title_synonyms : []),
      ].filter(Boolean),
      poster,
      backdrop: '',
      summary: (hit.synopsis as string) || '',
      rating: (hit.score as number) ?? 0,
      genres: ((hit.genres ?? []) as any[]).map((g: any) => g.name as string),
      year: (hit.year as number) ?? (hit.aired?.from ? new Date(hit.aired.from).getFullYear() : 0),
      cast,
      episodes,
    };
  } catch (err) {
    console.error('[Jikan]', err);
    return null;
  }
}

export async function fetchJikanMetadataCandidates(title: string): Promise<JikanAnimeResult[]> {
  try {
    const searchData: any = await jikanFetch(`/anime?q=${encodeURIComponent(title)}&limit=8&sfw`);
    const hits: any[] = Array.isArray(searchData.data) ? searchData.data : [];
    const results: JikanAnimeResult[] = [];
    for (const hit of hits) {
      const malId = hit.mal_id as number;
      let episodes: EpisodeMeta[] = [];
      try {
        episodes = await fetchJikanEpisodes(malId, 1);
      } catch { /* candidate episode names are optional */ }
      results.push({
        malId,
        title: (hit.title_english as string) || (hit.title as string) || title,
        aliases: [
          hit.title,
          hit.title_english,
          hit.title_japanese,
          ...(Array.isArray(hit.title_synonyms) ? hit.title_synonyms : []),
        ].filter(Boolean),
        poster: hit.images?.jpg?.large_image_url || hit.images?.jpg?.image_url || '',
        backdrop: '',
        summary: (hit.synopsis as string) || '',
        rating: (hit.score as number) ?? 0,
        genres: ((hit.genres ?? []) as any[]).map((genre: any) => genre.name as string),
        year: (hit.year as number) ?? (hit.aired?.from ? yearFromDateString(hit.aired.from) : 0),
        cast: [],
        episodes,
      });
    }
    return results;
  } catch (err) {
    console.error('[Jikan candidates]', err);
    return [];
  }
}
