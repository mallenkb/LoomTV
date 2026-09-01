import { remoteMatchesAnyLocalTitle, yearFromDateString } from './helpers.ts';
import type { EpisodeMeta, MediaItem } from './types.ts';
import { safeFetch } from '../safeFetch.ts';
import { jikanContentRating } from './contentRatings.ts';
import { fetchAniListAnimeCast } from './anilist.ts';
import { normalizeAnimeCast } from '../../shared/animeCast.ts';
import { z } from 'zod';

export interface JikanAnimeResult extends Partial<MediaItem> {
  episodes?: EpisodeMeta[];
  malId?: number;
  aliases?: string[];
  format?: string;
}

const jikanImageFormatSchema = z.object({
  image_url: z.string().optional(),
  small_image_url: z.string().optional(),
  large_image_url: z.string().optional(),
});

const jikanImageSetSchema = z.object({
  jpg: jikanImageFormatSchema.optional(),
  webp: jikanImageFormatSchema.optional(),
});

const jikanPersonEntrySchema = z.object({
  name: z.string().optional(),
  images: jikanImageSetSchema.optional(),
});

const jikanEpisodeEntrySchema = z.object({
  mal_id: z.number().finite().optional(),
  title: z.string().optional(),
  title_romanji: z.string().optional(),
  title_japanese: z.string().optional(),
  score: z.number().finite().nullable().optional(),
  aired: z.string().nullable().optional(),
});

const jikanCharacterEntrySchema = z.object({
  role: z.string().optional(),
  character: z.object({
    name: z.string().optional(),
    images: jikanImageSetSchema.optional(),
  }).optional(),
  voice_actors: z.array(z.object({
    person: jikanPersonEntrySchema.optional(),
    language: z.string().optional(),
  })).optional(),
});

const jikanAnimeHitSchema = z.object({
  mal_id: z.number().finite().optional(),
  type: z.string().optional(),
  title: z.string().optional(),
  title_english: z.string().nullable().optional(),
  title_japanese: z.string().nullable().optional(),
  title_synonyms: z.array(z.string()).optional(),
  images: jikanImageSetSchema.optional(),
  synopsis: z.string().nullable().optional(),
  score: z.number().finite().nullable().optional(),
  genres: z.array(z.object({ name: z.string().optional() })).optional(),
  year: z.number().finite().nullable().optional(),
  aired: z.object({ from: z.string().nullable().optional() }).optional(),
  rating: z.string().nullable().optional(),
});

type JikanEpisodeEntry = z.infer<typeof jikanEpisodeEntrySchema>;
type JikanAnimeHit = z.infer<typeof jikanAnimeHitSchema>;

function jikanListResponseSchema<TSchema extends z.ZodType>(itemSchema: TSchema) {
  return z.object({
    data: z.array(itemSchema).optional(),
    pagination: z.object({ has_next_page: z.boolean().optional() }).optional(),
  });
}

/** Respect Jikan's public rate limit (3 req/sec). */
const _jikan = { lastCallAt: 0 };
async function jikanDelay(): Promise<void> {
  const MIN_GAP = 350;
  const wait = MIN_GAP - (Date.now() - _jikan.lastCallAt);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  _jikan.lastCallAt = Date.now();
}

async function jikanFetch<TSchema extends z.ZodType>(path: string, schema: TSchema): Promise<z.output<TSchema>> {
  await jikanDelay();
  const res = await safeFetch(`https://api.jikan.moe/v4${path}`, {}, { allowedHosts: ['api.jikan.moe'], retries: 2 });
  if (!res.ok) throw new Error(`Jikan ${path} → ${res.status}`);
  return schema.parse(await res.json());
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
    const epData = await jikanFetch(
      `/anime/${malId}/episodes?page=${page}`,
      jikanListResponseSchema(jikanEpisodeEntrySchema),
    );
    const epList = epData.data ?? [];
    episodes.push(
      ...epList.map((e) => ({
        season: 1,
        number: e.mal_id ?? 0,
        title: resolveJikanEpisodeTitle(e),
        summary: '',
        still: '',
        rating: e.score || 0,
        airDate: e.aired ? String(e.aired).split('T')[0] : '',
      })),
    );
    hasNextPage = epData.pagination?.has_next_page === true;
    page++;
  }
  return episodes;
}

async function fetchJikanPosters(malId: number): Promise<string[]> {
  if (!malId) return [];
  try {
    const response = await jikanFetch(
      `/anime/${malId}/pictures`,
      jikanListResponseSchema(jikanImageSetSchema),
    );
    return [...new Set((response.data || []).flatMap((images) => {
      const poster = images.webp?.large_image_url
        || images.jpg?.large_image_url
        || images.webp?.image_url
        || images.jpg?.image_url;
      return poster ? [poster] : [];
    }))];
  } catch {
    return [];
  }
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
    const charData = await jikanFetch(
      `/anime/${malId}/characters`,
      jikanListResponseSchema(jikanCharacterEntrySchema),
    );
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
    const searchData = await jikanFetch(
      `/anime?q=${encodeURIComponent(title)}&limit=5&sfw`,
      jikanListResponseSchema(jikanAnimeHitSchema),
    );
    const hit = searchData.data?.[0];
    if (!hit) return null;

    const malId = hit.mal_id ?? 0;
    const primaryPoster =
      hit.images?.jpg?.large_image_url || hit.images?.jpg?.image_url || '';

    const cast = await fetchAnimeCast(malId, title);

    let episodes: EpisodeMeta[] = [];
    try {
      episodes = await fetchJikanEpisodes(malId, 3);
    } catch { /* episodes are optional */ }
    const posterCandidates = [...new Set([
      primaryPoster,
      ...(await fetchJikanPosters(malId)),
    ].filter(Boolean))];

    return {
      malId,
      format: hit.type,
      title: hit.title_english || hit.title || title,
      aliases: [
        hit.title,
        hit.title_english,
        hit.title_japanese,
        ...(Array.isArray(hit.title_synonyms) ? hit.title_synonyms : []),
      ].filter((alias): alias is string => Boolean(alias)),
      poster: posterCandidates[0] || '',
      posterCandidates,
      backdrop: '',
      summary: hit.synopsis || '',
      rating: hit.score ?? 0,
      contentRatings: jikanContentRating(hit.rating),
      genres: (hit.genres ?? []).flatMap((genre) => genre.name ? [genre.name] : []),
      year: hit.year ?? (hit.aired?.from ? new Date(hit.aired.from).getFullYear() : 0),
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
    const searchData = await jikanFetch(
      `/anime?q=${encodeURIComponent(title)}&sfw`,
      jikanListResponseSchema(jikanAnimeHitSchema),
    );
    const hits = Array.isArray(searchData.data)
      ? searchData.data.filter((hit) => jikanHitMatchesLocal(hit, localTitles))
      : [];
    const results: JikanAnimeResult[] = [];
    for (const hit of hits) {
      const malId = hit.mal_id ?? 0;
      let episodes: EpisodeMeta[] = [];
      try {
        episodes = await fetchJikanEpisodes(malId, 1);
      } catch { /* candidate episode names are optional */ }
      const primaryPoster = hit.images?.jpg?.large_image_url || hit.images?.jpg?.image_url || '';
      const posterCandidates = [...new Set([
        primaryPoster,
        ...(await fetchJikanPosters(malId)),
      ].filter(Boolean))];
      results.push({
        malId,
        format: hit.type,
        title: hit.title_english || hit.title || title,
        aliases: [
          hit.title,
          hit.title_english,
          hit.title_japanese,
          ...(Array.isArray(hit.title_synonyms) ? hit.title_synonyms : []),
        ].filter((alias): alias is string => Boolean(alias)),
        poster: posterCandidates[0] || '',
        posterCandidates,
        backdrop: '',
        summary: hit.synopsis || '',
        rating: hit.score ?? 0,
        contentRatings: jikanContentRating(hit.rating),
        genres: (hit.genres ?? []).flatMap((genre) => genre.name ? [genre.name] : []),
        year: hit.year ?? (hit.aired?.from ? yearFromDateString(hit.aired.from) : 0),
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
