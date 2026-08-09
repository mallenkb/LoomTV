import { remoteMatchesAnyLocalTitle, yearFromDateString } from './helpers.ts';
import type { EpisodeMeta, MediaItem } from './types.ts';
import { safeFetch } from '../safeFetch.ts';
import { jikanContentRating } from './contentRatings.ts';
import { fetchAniListAnimeCast } from './anilist.ts';
import { normalizeAnimeCast } from '../../shared/animeCast.ts';

export interface JikanAnimeResult extends Partial<MediaItem> {
  episodes?: EpisodeMeta[];
  malId?: number;
  aliases?: string[];
  format?: string;
}

interface JikanImageSet {
  jpg?: { image_url?: string; large_image_url?: string };
}

interface JikanPersonEntry {
  name?: string;
  images?: JikanImageSet;
}

interface JikanEpisodeEntry {
  mal_id?: number;
  title?: string;
  title_romanji?: string;
  title_japanese?: string;
  score?: number;
  aired?: string;
}

interface JikanCharacterEntry {
  role?: string;
  character?: { name?: string; images?: JikanImageSet };
  voice_actors?: { person?: JikanPersonEntry; language?: string }[];
}

interface JikanGenre {
  name?: string;
}

interface JikanAnimeHit {
  mal_id?: number;
  type?: string;
  title?: string;
  title_english?: string;
  title_japanese?: string;
  title_synonyms?: string[];
  images?: JikanImageSet;
  synopsis?: string;
  score?: number;
  genres?: JikanGenre[];
  year?: number;
  aired?: { from?: string };
  rating?: string;
}

interface JikanListResponse<T> {
  data?: T[];
  pagination?: { has_next_page?: boolean };
}

/** Respect Jikan's public rate limit (3 req/sec). */
const _jikan = { lastCallAt: 0 };
async function jikanDelay(): Promise<void> {
  const MIN_GAP = 350;
  const wait = MIN_GAP - (Date.now() - _jikan.lastCallAt);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  _jikan.lastCallAt = Date.now();
}

async function jikanFetch<T>(path: string): Promise<T> {
  await jikanDelay();
  const res = await safeFetch(`https://api.jikan.moe/v4${path}`, {}, { allowedHosts: ['api.jikan.moe'], retries: 2 });
  if (!res.ok) throw new Error(`Jikan ${path} → ${res.status}`);
  return (await res.json()) as T;
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

function resolveJikanEpisodeTitle(episode: JikanEpisodeEntry): string {
  const episodeNumber = Number(episode.mal_id) || 0;
  const candidates = [
    episode.title,
    episode.title_romanji,
    episode.title_japanese,
  ];
  const specificTitle = candidates.find((candidate) => !isGenericEpisodeTitle(candidate, episodeNumber));
  return typeof specificTitle === 'string' ? specificTitle.trim() : `Episode ${episodeNumber}`;
}

async function fetchJikanEpisodes(malId: number, maxPages = 3): Promise<EpisodeMeta[]> {
  const episodes: EpisodeMeta[] = [];
  let page = 1;
  let hasNextPage = true;
  while (hasNextPage && page <= maxPages) {
    const epData = await jikanFetch<JikanListResponse<JikanEpisodeEntry>>(`/anime/${malId}/episodes?page=${page}`);
    const epList = epData.data ?? [];
    episodes.push(
      ...epList.map((e) => ({
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

function jikanHitTitles(hit: JikanAnimeHit): string[] {
  return [
    hit.title,
    hit.title_english,
    hit.title_japanese,
    ...(Array.isArray(hit.title_synonyms) ? hit.title_synonyms : []),
  ].filter((title): title is string => typeof title === 'string' && title.trim().length > 0);
}

function jikanHitMatchesLocal(hit: JikanAnimeHit, localTitles: string[]): boolean {
  if (localTitles.length === 0) return true;
  return jikanHitTitles(hit).some((title) => remoteMatchesAnyLocalTitle(localTitles, title));
}

function jikanVoiceActorLanguagePriority(language?: string): number {
  return language?.trim().toLowerCase() === 'japanese' ? 0 : 1;
}

async function fetchJikanCharacterCast(malId: number): Promise<MediaItem['cast']> {
  if (!malId) return [];
  try {
    const charData = await jikanFetch<JikanListResponse<JikanCharacterEntry>>(`/anime/${malId}/characters`);
    return normalizeAnimeCast(
      (charData.data ?? [])
        .filter((entry) => entry.role === 'Main' || entry.role === 'Supporting')
        .slice(0, 20)
        .map((entry) => {
          const characterName = entry.character?.name ?? '';
          const characterImage = entry.character?.images?.jpg?.large_image_url
            || entry.character?.images?.jpg?.image_url
            || '';
          const voiceActor = [...(entry.voice_actors ?? [])]
            .filter((voice) => Boolean(voice.person?.name))
            .sort((left, right) => (
              jikanVoiceActorLanguagePriority(left.language) - jikanVoiceActorLanguagePriority(right.language)
            ))[0];

          return {
            name: characterName,
            character: entry.role ?? '',
            image: characterImage,
            characterName,
            characterRole: entry.role ?? '',
            characterImage,
            voiceActorName: voiceActor?.person?.name ?? '',
            voiceActorImage: voiceActor?.person?.images?.jpg?.large_image_url
              || voiceActor?.person?.images?.jpg?.image_url
              || '',
            voiceActorLanguage: voiceActor?.language ?? '',
          };
        }),
    );
  } catch {
    return [];
  }
}

function mergeAnimeVoiceActorFallback(
  primary: MediaItem['cast'],
  fallback: MediaItem['cast'],
): MediaItem['cast'] {
  if (primary.length === 0) return fallback;

  const creditKey = (credit: MediaItem['cast'][number]): string => (
    credit.characterName
      || credit.character
      || credit.name
      || ''
  ).trim().toLowerCase();
  const meaningfulRole = (role: string | undefined): boolean => (
    role?.trim().toLowerCase() === 'main'
      || role?.trim().toLowerCase() === 'supporting'
      || role?.trim().toLowerCase() === 'background'
  );
  const fallbackByCharacter = new Map(
    fallback.map((credit) => [creditKey(credit), credit]),
  );

  return primary.map((credit) => {
    const key = creditKey(credit);
    const fallbackCredit = fallbackByCharacter.get(key);
    if (!fallbackCredit) return credit;
    const characterName = credit.characterName || fallbackCredit.characterName || credit.name || fallbackCredit.name || '';
    const characterRole = (meaningfulRole(credit.characterRole)
      ? credit.characterRole
      : meaningfulRole(fallbackCredit.characterRole)
        ? fallbackCredit.characterRole
        : credit.characterRole || fallbackCredit.characterRole || credit.character || fallbackCredit.character) || '';
    const characterImage = credit.characterImage || fallbackCredit.characterImage || '';
    const voiceActorName = credit.voiceActorName || fallbackCredit.voiceActorName;
    const voiceActorImage = credit.voiceActorImage || fallbackCredit.voiceActorImage;
    const voiceActorLanguage = credit.voiceActorLanguage || fallbackCredit.voiceActorLanguage;
    return {
      ...credit,
      name: characterName,
      character: characterRole,
      image: characterImage || '',
      characterName,
      characterRole,
      characterImage,
      voiceActorName,
      voiceActorImage,
      voiceActorLanguage,
    };
  });
}

async function fetchAnimeCast(malId: number, title: string): Promise<MediaItem['cast']> {
  let primary: MediaItem['cast'] = [];
  try {
    primary = normalizeAnimeCast(await fetchAniListAnimeCast(malId, title));
  } catch { /* use Jikan's character endpoint below */ }

  // AniList is the primary source. Always consult Jikan when AniList returns
  // credits so missing portraits, roles, or actor fields can be filled one
  // field at a time without replacing AniList's preferred values.
  const fallback = await fetchJikanCharacterCast(malId);
  return mergeAnimeVoiceActorFallback(primary, fallback);
}

export async function fetchJikanMetadata(title: string): Promise<JikanAnimeResult | null> {
  try {
    const searchData = await jikanFetch<JikanListResponse<JikanAnimeHit>>(
      `/anime?q=${encodeURIComponent(title)}&limit=5&sfw`,
    );
    const hit = searchData.data?.[0];
    if (!hit) return null;

    const malId = hit.mal_id ?? 0;
    const poster =
      hit.images?.jpg?.large_image_url || hit.images?.jpg?.image_url || '';

    const cast = await fetchAnimeCast(malId, title);

    let episodes: EpisodeMeta[] = [];
    try {
      episodes = await fetchJikanEpisodes(malId, 3);
    } catch { /* episodes are optional */ }

    return {
      malId,
      format: hit.type,
      title: (hit.title_english as string) || (hit.title as string) || title,
      aliases: [
        hit.title,
        hit.title_english,
        hit.title_japanese,
        ...(Array.isArray(hit.title_synonyms) ? hit.title_synonyms : []),
      ].filter((alias): alias is string => Boolean(alias)),
      poster,
      backdrop: '',
      summary: (hit.synopsis as string) || '',
      rating: (hit.score as number) ?? 0,
      contentRatings: jikanContentRating(hit.rating),
      genres: (hit.genres ?? []).map((g) => g.name as string),
      year: (hit.year as number) ?? (hit.aired?.from ? new Date(hit.aired.from).getFullYear() : 0),
      cast,
      episodes,
    };
  } catch (err) {
    console.error('[Jikan]', err);
    return null;
  }
}

export async function fetchJikanMetadataCandidates(title: string, localTitles: string[] = []): Promise<JikanAnimeResult[]> {
  try {
    const searchData = await jikanFetch<JikanListResponse<JikanAnimeHit>>(`/anime?q=${encodeURIComponent(title)}&limit=8&sfw`);
    const hits = Array.isArray(searchData.data)
      ? searchData.data.filter((hit) => jikanHitMatchesLocal(hit, localTitles))
      : [];
    const results: JikanAnimeResult[] = [];
    for (const hit of hits) {
      const malId = hit.mal_id as number;
      let episodes: EpisodeMeta[] = [];
      try {
        episodes = await fetchJikanEpisodes(malId, 1);
      } catch { /* candidate episode names are optional */ }
      results.push({
        malId,
        format: hit.type,
        title: (hit.title_english as string) || (hit.title as string) || title,
        aliases: [
          hit.title,
          hit.title_english,
          hit.title_japanese,
          ...(Array.isArray(hit.title_synonyms) ? hit.title_synonyms : []),
        ].filter((alias): alias is string => Boolean(alias)),
        poster: hit.images?.jpg?.large_image_url || hit.images?.jpg?.image_url || '',
        backdrop: '',
        summary: (hit.synopsis as string) || '',
        rating: (hit.score as number) ?? 0,
        contentRatings: jikanContentRating(hit.rating),
        genres: (hit.genres ?? []).map((genre) => genre.name as string),
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
