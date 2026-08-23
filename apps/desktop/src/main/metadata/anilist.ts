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
    backdrop: secureImageUrl(media.bannerImage) || poster,
    summary: stripMarkup(media.description),
    rating: typeof media.averageScore === 'number'
      ? Number((media.averageScore / 10).toFixed(1))
      : 0,
    genres: media.genres?.filter(Boolean) || [],
    cast: mapAniListCharacterEdges(media.characters?.edges || []),
  };
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
