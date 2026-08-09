import type { MediaItem } from './types.ts';
import { safeFetch } from '../safeFetch.ts';
import { normalizeAnimeCast } from '../../shared/animeCast.ts';

const ANILIST_API_URL = 'https://graphql.anilist.co';

const ANILIST_CHARACTER_QUERY = `
  query ($malId: Int, $search: String) {
    Media(idMal: $malId, search: $search, type: ANIME) {
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

interface AniListImage {
  medium?: string | null;
  large?: string | null;
}

interface AniListCharacterEdge {
  node?: {
    name?: { full?: string | null } | null;
    image?: AniListImage | null;
  } | null;
  role?: string | null;
  voiceActors?: Array<{
    name?: { full?: string | null } | null;
    image?: AniListImage | null;
    languageV2?: string | null;
  }> | null;
}

interface AniListResponse {
  data?: {
    Media?: {
      characters?: { edges?: AniListCharacterEdge[] | null } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

function imageUrl(image?: AniListImage | null): string {
  return image?.large || image?.medium || '';
}

function voiceActorLanguagePriority(language?: string | null): number {
  return language?.trim().toLowerCase() === 'japanese' ? 0 : 1;
}

async function fetchAniListCharacterEdges(variables: { malId?: number; search?: string }): Promise<AniListCharacterEdge[]> {
  const response = await safeFetch(
    ANILIST_API_URL,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: ANILIST_CHARACTER_QUERY, variables }),
    },
    { allowedHosts: ['graphql.anilist.co'], timeoutMs: 12_000, maxBytes: 1_500_000, retries: 1 },
  );
  if (!response.ok) throw new Error(`AniList request failed: ${response.status}`);

  const payload = await response.json() as AniListResponse;
  if (payload.errors?.length) throw new Error(payload.errors[0]?.message || 'AniList request returned an error.');
  return payload.data?.Media?.characters?.edges || [];
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

      return {
        name: characterName,
        character: edge.role || '',
        image: characterImage,
        characterName,
        characterRole: edge.role || '',
        characterImage,
        voiceActorName,
        voiceActorImage: imageUrl(voiceActor?.image),
        // Kept internally to choose the primary voice actor; the UI does not
        // display language because the cast card does not need it.
        voiceActorLanguage: voiceActor?.languageV2 || '',
      };
    }));
}

export async function fetchAniListAnimeCast(malId: number, title: string): Promise<MediaItem['cast']> {
  const lookups = [
    malId > 0 ? { malId } : null,
    title.trim() ? { search: title.trim() } : null,
  ].filter((lookup): lookup is { malId: number } | { search: string } => Boolean(lookup));
  let lastError: unknown;

  for (const variables of lookups) {
    try {
      const cast = mapAniListCharacterEdges(await fetchAniListCharacterEdges(variables));
      if (cast.length > 0) return cast;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return [];
}
