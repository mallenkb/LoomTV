import type { MediaItem } from './types.ts';
import { safeFetch } from '../safeFetch.ts';
import { normalizeAnimeCast } from '../../shared/animeCast.ts';
import { z } from 'zod';

const ANILIST_API_URL = 'https://graphql.anilist.co';

const ANILIST_DETAIL_QUERY = `
  query ($malId: Int, $search: String) {
    Media(idMal: $malId, search: $search, type: ANIME) {
      id
      idMal
      title { userPreferred english native }
      description(asHtml: false)
      genres
      averageScore
      format
      startDate { year }
      coverImage { extraLarge large medium }
      bannerImage
      trailer { id site }
      characters(page: 1, perPage: 20, sort: [ROLE, FAVOURITES_DESC]) {
        edges {
          node {
            name { full }
            image { large medium }
          }
          role
          voiceActors {
            name { full }
            image { large medium }
            languageV2
          }
        }
      }
    }
  }
`;

const aniListImageSchema = z.object({
  extraLarge: z.string().nullable().optional(),
  medium: z.string().nullable().optional(),
  large: z.string().nullable().optional(),
});

const aniListCharacterEdgeSchema = z.object({
  node: z.object({
    name: z.object({ full: z.string().nullable().optional() }).nullable().optional(),
    image: aniListImageSchema.nullable().optional(),
  }).nullable().optional(),
  role: z.string().nullable().optional(),
  voiceActors: z.array(z.object({
    name: z.object({ full: z.string().nullable().optional() }).nullable().optional(),
    image: aniListImageSchema.nullable().optional(),
    languageV2: z.string().nullable().optional(),
  })).nullable().optional(),
});

const aniListMediaSchema = z.object({
  id: z.number().finite().optional(),
  idMal: z.number().finite().nullable().optional(),
  title: z.object({
    userPreferred: z.string().nullable().optional(),
    english: z.string().nullable().optional(),
    native: z.string().nullable().optional(),
  }).nullable().optional(),
  description: z.string().nullable().optional(),
  genres: z.array(z.string()).nullable().optional(),
  averageScore: z.number().finite().nullable().optional(),
  format: z.string().nullable().optional(),
  startDate: z.object({ year: z.number().finite().nullable().optional() }).nullable().optional(),
  coverImage: aniListImageSchema.nullable().optional(),
  bannerImage: z.string().nullable().optional(),
  trailer: z.object({ id: z.string().nullable().optional(), site: z.string().nullable().optional() }).nullable().optional(),
  characters: z.object({ edges: z.array(aniListCharacterEdgeSchema).nullable().optional() }).nullable().optional(),
});

const aniListResponseSchema = z.object({
  data: z.object({ Media: aniListMediaSchema.nullable().optional() }).optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

type AniListImage = z.infer<typeof aniListImageSchema>;
type AniListCharacterEdge = z.infer<typeof aniListCharacterEdgeSchema>;
type AniListMedia = z.infer<typeof aniListMediaSchema>;

export interface AniListAnimeResult extends Partial<MediaItem> {
  anilistId?: number;
  malId?: number;
  aliases?: string[];
}

function secureImageUrl(value?: string | null): string {
  return value?.trim().replace(/^http:\/\//i, 'https://') || '';
}

function imageUrl(image?: AniListImage | null): string {
  return secureImageUrl(image?.extraLarge || image?.large || image?.medium);
}

function voiceActorLanguagePriority(language?: string | null): number {
  return language?.trim().toLowerCase() === 'japanese' ? 0 : 1;
}

async function fetchAniListMedia(variables: { malId?: number; search?: string }): Promise<AniListMedia | null> {
  const response = await safeFetch(
    ANILIST_API_URL,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: ANILIST_DETAIL_QUERY, variables }),
    },
    { allowedHosts: ['graphql.anilist.co'], timeoutMs: 12_000, maxBytes: 1_500_000, retries: 1 },
  );
  // AniList can reject or temporarily block public lookups. Treat those
  // statuses as an unavailable provider so the other metadata sources can
  // still satisfy the request.
  if ([401, 403, 404].includes(response.status)) return null;
  if (!response.ok) throw new Error(`AniList request failed: ${response.status}`);

  const payload = aniListResponseSchema.parse(await response.json());
  if (payload.errors?.length) throw new Error(payload.errors[0]?.message || 'AniList request returned an error.');
  return payload.data?.Media || null;
}

function mapAniListCharacterEdges(edges: AniListCharacterEdge[]): MediaItem['cast'] {
  // Keep AniList's response order. It already places the page's main and
  // supporting characters in the same order users see on AniList.
  return normalizeAnimeCast(edges
    .filter((edge) => (
      (edge.role === 'MAIN' || edge.role === 'SUPPORTING')
      && Boolean(edge.node?.name?.full)
    ))
    .map((edge) => {
      const characterName = edge.node?.name?.full || 'Unknown character';
      const characterImage = imageUrl(edge.node?.image);
      const voiceActor = [...(edge.voiceActors || [])]
        .filter((actor) => Boolean(actor.name?.full))
        .sort((left, right) => (
          voiceActorLanguagePriority(left.languageV2) - voiceActorLanguagePriority(right.languageV2)
        ))[0];
      const voiceActorName = voiceActor?.name?.full || '';
      const voiceActorImage = imageUrl(voiceActor?.image);

      return {
        name: voiceActorName || characterName,
        character: edge.role || '',
        image: voiceActorImage,
        characterName,
        characterRole: edge.role || '',
        characterImage,
        voiceActorName,
        voiceActorImage,
        // Kept internally to choose the primary voice actor; the UI does not
        // display language because the cast card does not need it.
        voiceActorLanguage: voiceActor?.languageV2 || '',
      };
    }));
}

function stripMarkup(value?: string | null): string {
  return (value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapAniListMedia(media: AniListMedia): AniListAnimeResult {
  const titles = [media.title?.userPreferred, media.title?.english, media.title?.native]
    .filter((title): title is string => Boolean(title?.trim()));
  const poster = imageUrl(media.coverImage);
  return {
    anilistId: media.id,
    malId: media.idMal || undefined,
    aliases: [...new Set(titles)],
    providerIds: { malId: media.idMal ? String(media.idMal) : undefined },
    format: media.format || 'TV',
    title: titles[0] || '',
    year: media.startDate?.year || 0,
    poster,
    backdrop: secureImageUrl(media.bannerImage),
    backdropCandidates: media.bannerImage ? [secureImageUrl(media.bannerImage)] : [],
    summary: stripMarkup(media.description),
    rating: typeof media.averageScore === 'number'
      ? Number((media.averageScore / 10).toFixed(1))
      : 0,
    genres: media.genres?.filter(Boolean) || [],
    cast: mapAniListCharacterEdges(media.characters?.edges || []),
    trailerUrl: youtubeTrailerUrl(media.trailer),
  };
}

/** Loom plays YouTube trailers; AniList also lists Dailymotion ones, which are skipped. */
function youtubeTrailerUrl(trailer: AniListMedia['trailer']): string | undefined {
  const id = trailer?.id?.trim();
  return id && trailer?.site?.toLowerCase() === 'youtube' && /^[\w-]{6,20}$/.test(id)
    ? `https://www.youtube.com/watch?v=${id}`
    : undefined;
}

export async function fetchAniListAnimeMetadata(
  malId: number | undefined,
  title: string,
): Promise<AniListAnimeResult | null> {
  const lookups = [
    malId && malId > 0 ? { malId } : null,
    title.trim() ? { search: title.trim() } : null,
  ].filter((lookup): lookup is { malId: number } | { search: string } => Boolean(lookup));
  let lastError: unknown;

  for (const variables of lookups) {
    try {
      const media = await fetchAniListMedia(variables);
      if (media) return mapAniListMedia(media);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return null;
}

export async function fetchAniListAnimeCast(malId: number, title: string): Promise<MediaItem['cast']> {
  return (await fetchAniListAnimeMetadata(malId, title))?.cast || [];
}

const ANILIST_SCHEDULE_QUERY = `
  query ($ids: [Int]) {
    Page(perPage: 50) {
      media(idMal_in: $ids, type: ANIME) {
        idMal
        episodes
        status
        startDate { year month day }
        endDate { year month day }
        nextAiringEpisode { episode airingAt }
        airingSchedule(perPage: 50) { nodes { episode airingAt } }
      }
    }
  }
`;

const aniListFuzzyDateSchema = z.object({
  year: z.number().int().nullable().optional(),
  month: z.number().int().nullable().optional(),
  day: z.number().int().nullable().optional(),
}).nullable().optional();

const aniListScheduleSchema = z.object({
  data: z.object({
    Page: z.object({
      media: z.array(z.object({
        idMal: z.number().int().nullable().optional(),
        episodes: z.number().int().nonnegative().nullable().optional(),
        status: z.string().nullable().optional(),
        startDate: aniListFuzzyDateSchema,
        endDate: aniListFuzzyDateSchema,
        nextAiringEpisode: z.object({ episode: z.number().int().positive(), airingAt: z.number().int() }).nullable().optional(),
        airingSchedule: z.object({
          nodes: z.array(z.object({ episode: z.number().int().positive(), airingAt: z.number().int() }).nullable()).nullable().optional(),
        }).nullable().optional(),
      }).nullable()).nullable().optional(),
    }).nullable().optional(),
  }).nullable().optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

/** An episode number with its first airing day (YYYY-MM-DD, local time). */
export type AnimeAiring = { episode: number; airDate: string };

function localDay(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function fuzzyDay(value: z.infer<typeof aniListFuzzyDateSchema>): string | null {
  if (!value?.year) return null;
  return `${value.year}-${String(value.month || 1).padStart(2, '0')}-${String(value.day || 1).padStart(2, '0')}`;
}

/**
 * Each episode's airing day for the given MAL IDs, from one AniList request
 * per 50 titles. Episodes AniList has no exact time for are dated from the
 * season's start or end so aired ones still count as aired; episodes with no
 * known date and not yet aired are left out.
 */
export async function fetchAniListAiringSchedules(malIds: readonly number[]): Promise<Map<number, AnimeAiring[]>> {
  const result = new Map<number, AnimeAiring[]>();
  const unique = [...new Set(malIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  for (let start = 0; start < unique.length; start += 50) {
    const ids = unique.slice(start, start + 50);
    const response = await safeFetch(
      ANILIST_API_URL,
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ query: ANILIST_SCHEDULE_QUERY, variables: { ids } }),
      },
      { allowedHosts: ['graphql.anilist.co'], timeoutMs: 12_000, maxBytes: 1_500_000, retries: 1 },
    );
    if (!response.ok) throw new Error(`AniList request failed: ${response.status}`);
    const payload = aniListScheduleSchema.parse(await response.json());
    if (payload.errors?.length) throw new Error(payload.errors[0]?.message || 'AniList request returned an error.');
    for (const media of payload.data?.Page?.media || []) {
      if (!media?.idMal) continue;
      const exact = new Map<number, string>();
      for (const node of media.airingSchedule?.nodes || []) if (node) exact.set(node.episode, localDay(node.airingAt));
      const next = media.nextAiringEpisode;
      if (next) exact.set(next.episode, localDay(next.airingAt));
      const finished = media.status === 'FINISHED';
      // Before this episode everything has aired; FINISHED means all of it has.
      const airedBefore = next ? next.episode : finished ? Infinity : 0;
      const fallbackDay = fuzzyDay(media.endDate) || fuzzyDay(media.startDate);
      const last = Math.max(media.episodes || 0, next?.episode || 0, ...exact.keys());
      const airings: AnimeAiring[] = [];
      for (let episode = 1; episode <= last; episode += 1) {
        const airDate = exact.get(episode) ?? (episode < airedBefore && fallbackDay ? fallbackDay : null);
        if (airDate) airings.push({ episode, airDate });
      }
      result.set(media.idMal, airings);
    }
  }
  return result;
}
