import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Compass, RefreshCw, WifiOff } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { useTheme } from '@/components/ThemeProvider';
import { useProfiles } from '@/contexts/ProfileContext';
import LibrarySearch from '@/components/LibrarySearch';
import StremioPosterCard from '@/components/StremioPosterCard';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import TrailerDialog from '@/components/TrailerDialog';
import { PosterGridShimmer } from '@/components/ContentShimmer';
import { desktopApi, type StremioPluginCatalogItem } from '@/lib/desktopApi';
import { cacheDiscoverReturnRoute, cacheExploreItem } from '@/lib/discoverNavigation';
import type { StreamingProvider } from '@/shared/desktopProtocol';
import { preferredProviderLogoUrl } from '@/shared/providerLogos';
import { normalizeAnimeCast } from '@/shared/animeCast';
import {
  aniListDiscoverResponseSchema,
  aniListGenreResponseSchema,
  type AniListMediaResult,
} from '@/lib/anilistSchemas';
import { parseStoredValue } from '@/lib/desktopDecoders';
import {
  tmdbContentRatingsResponseSchema,
  tmdbDetailResponseSchema,
  tmdbGenreResponseSchema,
  tmdbListResponseSchema,
  tmdbProviderListResponseSchema,
  tmdbReleaseDatesResponseSchema,
  tmdbVideosResponseSchema,
  tmdbWatchProviderDetailSchema,
  type TmdbCreditsPerson,
  type TmdbCreditsResponse,
  type TmdbDetailResponse,
  type TmdbListResult,
  type TmdbProvider,
  type TmdbVideo,
} from '@/lib/tmdbSchemas';
import { z } from 'zod';
import {
  ALL_AVAILABILITY_REGION,
  AVAILABILITY_REGIONS,
  DEFAULT_AVAILABILITY_REGION,
  DISCOVER_CACHE_STORAGE_KEY,
  DISCOVER_ROUTE,
  DISCOVER_VIEW_STATE_STORAGE_KEY,
  buildDiscoverSearch,
  discoverViewStateSchema,
  getValidCachedItems,
  hasCachedImageCandidate,
  loadDiscoverCacheFromStorage,
  makeCacheId,
  nextMidnightAt,
  normalizeAvailabilityRegion,
  parseDiscoverFilterState,
  releaseYearOptions,
  toLocalDateKey,
  type AvailabilityRegion,
  type CachedCacheId,
  type DiscoverCacheState,
  type DiscoverSection,
  type DiscoverType,
} from './PluginDiscover/discoverState';

const PROVIDER_SEARCH_DEBOUNCE_MS = 450;
const DISCOVER_RESULT_LIMIT = 30;
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
type GenreSourceType = Exclude<DiscoverType, 'anime'>;

const omdbDiscoverResponseSchema = z.object({
  Response: z.string().optional(),
  imdbRating: z.string().optional(),
  imdbVotes: z.string().optional(),
  Metascore: z.string().optional(),
  Ratings: z.array(z.object({
    Source: z.string(),
    Value: z.string(),
  })).optional(),
}).passthrough();

type OmdbDiscoverResponse = z.output<typeof omdbDiscoverResponseSchema>;

type GenreOption = {
  label: string;
  value: string;
};

type ProviderOption = GenreOption & {
  logoUrl: string;
  providerIds: number[];
};

type GridEntry = { id: string; item: StremioPluginCatalogItem; rank: number };


const DISCOVER_SECTIONS: Record<DiscoverType, readonly DiscoverSection[]> = {
  movie: ['trending', 'popular', 'top_rated', 'new'],
  tv: ['trending', 'popular', 'top_rated', 'new'],
  anime: ['trending', 'popular', 'top_rated', 'new'],
};

const DISCOVER_SECTION_LABELS: Record<DiscoverSection, string> = {
  trending: 'Trending',
  popular: 'Popular',
  top_rated: 'Top Rated',
  new: 'Latest',
};

const DISCOVER_TYPE_LABELS: Record<DiscoverType, string> = {
  movie: 'Movies',
  tv: 'TV Shows',
  anime: 'Anime',
};

const TMDB_SECTION_ENDPOINTS: Record<Exclude<DiscoverType, 'anime'>, Record<DiscoverSection, string>> = {
  movie: {
    trending: 'trending/movie/day',
    popular: 'movie/popular',
    top_rated: 'movie/top_rated',
    new: 'movie/upcoming',
  },
  tv: {
    trending: 'trending/tv/day',
    popular: 'tv/popular',
    top_rated: 'tv/top_rated',
    new: 'tv/on_the_air',
  },
};

const ANILIST_SECTION_SORT: Record<DiscoverSection, readonly string[]> = {
  trending: ['TRENDING_DESC'],
  popular: ['POPULARITY_DESC'],
  top_rated: ['SCORE_DESC'],
  new: ['START_DATE_DESC'],
};

const ANILIST_DISCOVER_QUERY = `
query DiscoverAnime($page: Int, $perPage: Int, $sort: [MediaSort], $search: String, $genre: String, $seasonYear: Int) {
  Page(page: $page, perPage: $perPage) {
    media(
      type: ANIME
      isAdult: false
      sort: $sort
      search: $search
      genre: $genre
      seasonYear: $seasonYear
    ) {
      id
      title {
        userPreferred
        english
        native
      }
      description(asHtml: false)
      genres
      averageScore
      format
      duration
      episodes
      startDate {
        year
        month
        day
      }
      coverImage {
        extraLarge
        large
        medium
      }
      bannerImage
      characters(page: 1, perPage: 20, sort: [ROLE, FAVOURITES_DESC]) {
        edges {
          node {
            name {
              full
            }
            image {
              medium
              large
            }
          }
          role
          voiceActors {
            name {
              full
            }
            image {
              medium
              large
            }
            languageV2
          }
        }
      }
      trailer {
        id
        site
      }
    }
  }
}
`;

const ANILIST_GENRE_QUERY = `
query {
  GenreCollection
}
`;

function anilistImageUrl(value?: string | null): string {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/^http:\/\//i, 'https://');
}

function pickImageUrl(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const next = anilistImageUrl(value);
    if (next) return next;
  }
  return '';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'The provider request failed.';
}

function isNetworkFailure(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
  return /^(ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETDOWN|ENETUNREACH|ENOTFOUND|ETIMEDOUT)$/.test(code)
    || /(failed to fetch|fetch failed|network error|no internet|offline|getaddrinfo)/i.test(errorMessage(error));
}

function normalizeTmdbCredential(raw: string): string {
  return raw.trim().replace(/^Bearer\s+/i, '');
}

function boundedRating(value: string | undefined, maximum: 10 | 100): number | undefined {
  if (!value || value === 'N/A') return undefined;
  const score = Number.parseFloat(value);
  return Number.isFinite(score) && score >= 0 && score <= maximum ? score : undefined;
}

function omdbRatingBySource(response: OmdbDiscoverResponse, source: string): string | undefined {
  return response.Ratings?.find((rating) => rating.Source === source)?.Value;
}

function providerRatingsFromOmdb(
  response: OmdbDiscoverResponse,
): NonNullable<StremioPluginCatalogItem['providerRatings']> {
  const imdb = boundedRating(
    response.imdbRating || omdbRatingBySource(response, 'Internet Movie Database'),
    10,
  );
  const rottenTomatoes = boundedRating(omdbRatingBySource(response, 'Rotten Tomatoes'), 100);
  const popcornmeter = boundedRating(
    omdbRatingBySource(response, 'Popcornmeter')
      || omdbRatingBySource(response, 'Rotten Tomatoes Audience Score'),
    100,
  );
  const metacritic = boundedRating(
    response.Metascore || omdbRatingBySource(response, 'Metacritic'),
    100,
  );
  const votesValue = response.imdbVotes?.replaceAll(',', '').trim();
  const votes = votesValue ? Number(votesValue) : Number.NaN;

  return {
    ...(imdb === undefined ? {} : {
      imdb: {
        value: imdb,
        scale: 10,
        ...(Number.isSafeInteger(votes) && votes >= 0 ? { votes } : {}),
      },
    }),
    ...(rottenTomatoes === undefined ? {} : {
      rottenTomatoes: { value: rottenTomatoes, scale: 100 },
    }),
    ...(popcornmeter === undefined ? {} : {
      popcornmeter: { value: popcornmeter, scale: 100 },
    }),
    ...(metacritic === undefined ? {} : {
      metacritic: { value: metacritic, scale: 100 },
    }),
  };
}

async function enrichCatalogItemWithOmdbRatings(
  item: StremioPluginCatalogItem,
  credential: string,
): Promise<StremioPluginCatalogItem> {
  const apiKey = credential.trim();
  if (!apiKey) return item;

  const query: Record<string, string> = {};
  if (item.imdbId?.startsWith('tt')) {
    query.i = item.imdbId;
  } else {
    query.t = item.title;
    query.type = item.type === 'movie' ? 'movie' : 'series';
    const year = parseYearFromItem(item);
    if (year > 0) query.y = String(year);
  }
  const metadata = omdbDiscoverResponseSchema.parse(await desktopApi.requestMetadataProvider({ provider: 'omdb', query }));
  if (metadata.Response === 'False') return item;

  const providerRatings = providerRatingsFromOmdb(metadata);
  return Object.keys(providerRatings).length > 0 ? { ...item, providerRatings } : item;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tmdbImage(path: string | null | undefined, size: 'w45' | 'w92' | 'w185' | 'w300' | 'w500' | 'w1280'): string {
  if (!path) return '';
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

function tmdbLogoCandidates(details: TmdbDetailResponse): string[] {
  return [...(details.images?.logos || [])]
    .sort((left, right) => {
      const languageRank = (language: string | null | undefined) => language === 'en' ? 0 : language ? 2 : 1;
      return languageRank(left.iso_639_1) - languageRank(right.iso_639_1)
        || (right.vote_average || 0) - (left.vote_average || 0)
        || (right.width || 0) - (left.width || 0);
    })
    .map((logo) => tmdbImage(logo.file_path, 'w500'))
    .filter((url, index, urls) => Boolean(url) && urls.indexOf(url) === index);
}

function providerDisplayName(value: string): string {
  const normalized = value.trim();
  if (/netflix/i.test(normalized)) return 'Netflix';
  if (/hulu/i.test(normalized)) return 'Hulu';
  if (/disney/i.test(normalized)) return 'Disney+';
  if (/amazon\s+prime|prime\s+video/i.test(normalized)) return 'Prime Video';
  if (/\b(max|hbo max)\b/i.test(normalized)) return 'Max';
  if (/paramount/i.test(normalized)) return 'Paramount+';
  if (/apple\s+tv/i.test(normalized)) return 'Apple TV+';
  if (/peacock/i.test(normalized)) return 'Peacock';
  if (/mgm\+|mgm\s+plus/i.test(normalized)) return 'MGM+';
  if (/crunchyroll/i.test(normalized)) return 'Crunchyroll';
  if (/discovery\+/i.test(normalized)) return 'Discovery+';
  if (/amc\+/i.test(normalized)) return 'AMC+';
  if (/britbox/i.test(normalized)) return 'BritBox';
  return normalized;
}

function normalizeProviderFilterValue(value: string, options: readonly ProviderOption[]): string {
  const normalized = value.trim();
  if (!normalized) return '';

  const exactMatch = options.find((option) => option.value === normalized);
  if (exactMatch) return exactMatch.value;

  const providerId = Number(normalized);
  if (!Number.isFinite(providerId)) return '';
  return options.find((option) => option.providerIds.includes(providerId))?.value || '';
}

function providerPriority(provider: TmdbProvider): number {
  const label = providerDisplayName(provider.provider_name);
  const recognized = [
    'Netflix',
    'Hulu',
    'Disney+',
    'Prime Video',
    'Max',
    'Paramount+',
    'Apple TV+',
    'Peacock',
    'MGM+',
    'Crunchyroll',
    'Discovery+',
    'AMC+',
    'BritBox',
  ];
  const index = recognized.indexOf(label);
  return index === -1 ? recognized.length : index;
}

function yearFromDateValue(value: string | undefined): number {
  const match = value?.match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : 0;
}

function parseYearFromItem(item: StremioPluginCatalogItem): number {
  const candidates = [item.releaseInfo, item.released].filter(Boolean).map((value) => String(value));
  for (const value of candidates) {
    const match = value.match(/(19\d{2}|20\d{2})/);
    if (match) return Number(match[0]);
  }
  return 0;
}

function stremioMetaLine(item: StremioPluginCatalogItem): string {
  const year = parseYearFromItem(item);
  return [year > 0 ? String(year) : item.releaseInfo || item.released || '', item.runtime]
    .filter(Boolean)
    .join(' · ');
}

function hasYearMatch(item: StremioPluginCatalogItem, yearFilter: string): boolean {
  const normalizedYear = Number(yearFilter);
  if (!Number.isFinite(normalizedYear) || normalizedYear <= 0) return true;
  return parseYearFromItem(item) === normalizedYear;
}

function voiceActorLanguagePriority(language?: string | null): number {
  return language?.trim().toLowerCase() === 'japanese' ? 0 : 1;
}

function youtubeTrailerUrl(trailer?: { id?: string | null; site?: string | null } | null): string {
  return trailer?.id && trailer.site?.toLowerCase() === 'youtube'
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(trailer.id)}`
    : '';
}

function tmdbContentRating(
  response: Pick<TmdbDetailResponse, 'release_dates' | 'content_ratings'>,
  type: 'movie' | 'tv',
): string {
  const preferredCountries = ['US', 'GB', 'CA', 'AU'];
  const candidates = type === 'movie'
    ? (response.release_dates?.results || []).flatMap((entry) => (entry.release_dates || []).map((release) => ({
        country: entry.iso_3166_1,
        code: release.certification,
      })))
    : (response.content_ratings?.results || []).map((entry) => ({
        country: entry.iso_3166_1,
        code: entry.rating,
      }));
  for (const country of preferredCountries) {
    const match = candidates.find((candidate) => candidate.country?.toUpperCase() === country && candidate.code?.trim());
    if (match?.code) return match.code.trim();
  }
  return candidates.find((candidate) => candidate.code?.trim())?.code?.trim() || '';
}

function tmdbStreamingProviders(
  response: TmdbDetailResponse,
  region = DEFAULT_AVAILABILITY_REGION,
): StreamingProvider[] {
  const regionProviders = response['watch/providers']?.results?.[region];
  const seenProviderIds = new Set<number>();
  return [
    ...(regionProviders?.flatrate || []),
    ...(regionProviders?.ads || []),
    ...(regionProviders?.free || []),
  ]
    .filter((provider) => Number.isFinite(provider.provider_id) && Boolean(provider.provider_name?.trim()))
    .sort((left, right) => (
      (left.display_priority ?? Number.MAX_SAFE_INTEGER) - (right.display_priority ?? Number.MAX_SAFE_INTEGER)
      || left.provider_name.localeCompare(right.provider_name)
    ))
    .filter((provider) => {
      if (seenProviderIds.has(provider.provider_id)) return false;
      seenProviderIds.add(provider.provider_id);
      return true;
    })
    .map((provider) => ({
      id: provider.provider_id,
      name: providerDisplayName(provider.provider_name),
      logoUrl: tmdbImage(provider.logo_path, 'w92'),
    }));
}

function tmdbTrailerUrlFromVideos(videos: readonly TmdbVideo[]): string {
  const trailer = [...videos]
    .filter((video) => video.key && video.site?.toLowerCase() === 'youtube')
    .sort((left, right) => {
      const score = (video: TmdbVideo) => (video.type?.toLowerCase() === 'trailer' ? 2 : 0) + (video.official ? 1 : 0);
      return score(right) - score(left);
    })[0];
  return trailer?.key ? `https://www.youtube.com/watch?v=${encodeURIComponent(trailer.key)}` : '';
}

function tmdbTrailerUrl(response: TmdbDetailResponse): string {
  return tmdbTrailerUrlFromVideos(response.videos?.results || []);
}

async function fetchTmdbTrailerFallback(
  type: 'movie' | 'tv',
  id: number,
  credential: string,
): Promise<string> {
  const languages = ['en-US', 'pt-BR', 'es-ES', 'fr-FR', 'ja-JP', 'ko-KR'];
  const responses = await Promise.allSettled(languages.map((language) => requestTmdbJson(
    `${type}/${id}/videos`,
    credential,
    tmdbVideosResponseSchema,
    {
      language,
      include_video_language: 'en,null,pt,es,fr,ja,ko,zh',
    },
  )));
  const videos = responses.flatMap((response) => (
    response.status === 'fulfilled' ? response.value.results || [] : []
  ));
  return tmdbTrailerUrlFromVideos(videos);
}

function mapAnilistToCatalog(media: AniListMediaResult): StremioPluginCatalogItem {
  const title = media.title?.userPreferred || media.title?.english || media.title?.native || 'Unknown title';
  const score = typeof media.averageScore === 'number' ? Number((media.averageScore / 10).toFixed(1)) : undefined;
  const isMovie = media.format === 'MOVIE';
  const episodeCount = !isMovie && typeof media.episodes === 'number' ? media.episodes : undefined;
  const releaseYear = media.startDate?.year;
  const releaseInfo = releaseYear ? String(releaseYear) : '';
  const posterUrl = pickImageUrl(
    media.coverImage?.extraLarge,
    media.coverImage?.large,
    media.coverImage?.medium,
  );
  const backgroundUrl = pickImageUrl(
    media.bannerImage,
    media.coverImage?.extraLarge,
    media.coverImage?.large,
    media.coverImage?.medium,
  );
  const cast = (media.characters?.edges || [])
    .filter((entry) => (
      (entry.role === 'MAIN' || entry.role === 'SUPPORTING')
      && Boolean(entry?.node?.name?.full)
    ))
    .slice(0, 20)
    .flatMap((entry) => {
      const characterName = entry.node?.name?.full || 'Unknown character';
      const characterRole = entry.role || '';
      const characterImage = pickImageUrl(entry.node?.image?.large, entry.node?.image?.medium);
      const voiceActors = [...(entry.voiceActors || [])]
        .filter((voiceActor) => Boolean(voiceActor?.name?.full))
        .sort((left, right) => (
          voiceActorLanguagePriority(left.languageV2) - voiceActorLanguagePriority(right.languageV2)
        ));

      if (voiceActors.length === 0) {
        return [{
          name: characterName,
          character: characterRole,
          image: '',
          characterName,
          characterRole,
          characterImage,
        }];
      }

      const voiceActor = voiceActors[0];
      return [{
        name: voiceActor.name?.full || 'Unknown voice actor',
        character: characterRole,
        image: pickImageUrl(voiceActor.image?.large, voiceActor.image?.medium),
        characterName,
        characterRole,
        characterImage,
        voiceActorName: voiceActor.name?.full || '',
        voiceActorImage: pickImageUrl(voiceActor.image?.large, voiceActor.image?.medium),
        voiceActorLanguage: voiceActor.languageV2 || '',
      }];
    });
  return {
    id: String(media.id),
    type: 'anime',
    source: 'anilist',
    format: media.format || 'TV',
    title,
    genres: media.genres || [],
    description: stripHtml(media.description || ''),
    releaseInfo,
    released: releaseInfo,
    rating: score,
    trailerUrl: youtubeTrailerUrl(media.trailer),
    runtime: isMovie && typeof media.duration === 'number' && media.duration > 0
      ? `${media.duration}m`
      : episodeCount !== undefined ? `${episodeCount} eps` : undefined,
    seasonCount: episodeCount !== undefined ? 1 : undefined,
    episodeCount,
    cast: normalizeAnimeCast(cast),
    posterUrl,
    backgroundUrl,
    logoUrl: '',
  };
}

function mapTmdbToCatalog(media: TmdbListResult, type: 'movie' | 'tv'): StremioPluginCatalogItem {
  const title = media.title || media.name || 'Unknown title';
  const releaseDate = type === 'movie' ? media.release_date : media.first_air_date;
  const releaseYear = yearFromDateValue(releaseDate || '');
  const releaseInfo = releaseYear ? String(releaseYear) : releaseDate || '';
  return {
    id: String(media.id),
    tmdbId: String(media.id),
    type,
    source: 'tmdb',
    format: type === 'movie' ? 'Movie' : 'TV',
    title,
    genres: (media.genre_ids || []).map((genreId) => String(genreId)),
    description: media.overview || '',
    releaseInfo,
    released: releaseInfo,
    rating: typeof media.vote_average === 'number' ? media.vote_average : undefined,
    posterUrl: tmdbImage(media.poster_path, 'w500'),
    backgroundUrl: tmdbImage(media.backdrop_path, 'w1280') || tmdbImage(media.poster_path, 'w1280'),
    logoUrl: '',
  };
}

function mapTmdbCredits(media: TmdbCreditsResponse | undefined, existing: StremioPluginCatalogItem): StremioPluginCatalogItem {
  if (!media?.cast?.length) return existing;
  const cast = media.cast
    .filter((person): person is Required<TmdbCreditsPerson> => Boolean(person?.name))
    .slice(0, 10)
    .map((person) => ({
      name: person.name || '',
      character: person.character || '',
      image: tmdbImage(person.profile_path, 'w185'),
    }));

  return {
    ...existing,
    cast,
  };
}

function normalizeGenreFilter(value: string): string {
  return value.trim().toLowerCase();
}

function hasGenreMatch(item: StremioPluginCatalogItem, genreValue: string, type: DiscoverType): boolean {
  const selectedGenres = normalizeGenreFilter(genreValue)
    .split(',')
    .map((genre) => genre.trim())
    .filter(Boolean);
  if (selectedGenres.length === 0) return true;
  if (type === 'anime') {
    return item.genres.some((genre) => selectedGenres.includes(normalizeGenreFilter(genre)));
  }
  return selectedGenres.some((genre) => item.genres.includes(genre));
}

async function requestTmdbJson<TSchema extends z.ZodType>(
  path: string,
  credential: string,
  schema: TSchema,
  query: Record<string, string | number | boolean> = {},
): Promise<z.output<TSchema>> {
  const normalized = normalizeTmdbCredential(credential);
  if (!normalized) {
    throw new Error('TMDB API key is missing. Add it in Settings → Metadata API keys.');
  }

  return schema.parse(await desktopApi.requestMetadataProvider({ provider: 'tmdb', path, query }));
}

async function discoverTmdbGenres(type: GenreSourceType, credential: string): Promise<GenreOption[]> {
  const response = await requestTmdbJson(`genre/${type}/list`, credential, tmdbGenreResponseSchema);
  return (response.genres || [])
    .map((genre): GenreOption => ({ label: genre.name, value: String(genre.id) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverTmdbProviders(
  type: GenreSourceType,
  region: AvailabilityRegion,
  credential: string,
): Promise<ProviderOption[]> {
  const regions = region === ALL_AVAILABILITY_REGION ? AVAILABILITY_REGIONS : [region];
  const responses = await Promise.all(regions.map((watchRegion) => requestTmdbJson(
    `watch/providers/${type}`,
    credential,
    tmdbProviderListResponseSchema,
    { watch_region: watchRegion },
  )));
  const groupedProviders = new Map<string, ProviderOption>();
  responses.flatMap((response) => response.results || [])
    .filter((provider) => Number.isFinite(provider.provider_id) && Boolean(provider.provider_name?.trim()))
    .sort((left, right) => (
      (left.display_priority ?? Number.MAX_SAFE_INTEGER) - (right.display_priority ?? Number.MAX_SAFE_INTEGER)
      || providerPriority(left) - providerPriority(right)
      || left.provider_name.localeCompare(right.provider_name)
    ))
    .forEach((provider) => {
      const label = providerDisplayName(provider.provider_name);
      const existing = groupedProviders.get(label);
      if (existing) {
        existing.providerIds.push(provider.provider_id);
        return;
      }
      groupedProviders.set(label, {
        value: String(provider.provider_id),
        label,
        logoUrl: preferredProviderLogoUrl({
          id: provider.provider_id,
          name: provider.provider_name,
          logoPath: provider.logo_path,
        }),
        providerIds: [provider.provider_id],
      });
    });

  return Array.from(groupedProviders.values()).map((provider) => ({
    ...provider,
    value: provider.providerIds.join(','),
  }));
}

async function discoverAniListGenres(): Promise<GenreOption[]> {
  const payload = aniListGenreResponseSchema.parse(await desktopApi.requestMetadataProvider({
    provider: 'anilist',
    query: ANILIST_GENRE_QUERY,
  }));
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message || 'AniList request returned an error.');
  }

  const genres = payload.data?.GenreCollection || [];
  return genres
    .filter((genre): genre is string => typeof genre === 'string' && genre.trim().length > 0)
    .map((genre) => ({
      label: genre.trim(),
      value: genre.trim(),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

type TmdbCatalogFilters = {
  genre: string;
  year: string;
  provider: string;
  region: AvailabilityRegion;
};

function tmdbDiscoverySort(type: 'movie' | 'tv', section: DiscoverSection): string {
  if (section === 'top_rated') return 'vote_average.desc';
  if (section === 'new') return type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc';
  return 'popularity.desc';
}

function tmdbUsesDiscoveryFilters(filters: TmdbCatalogFilters): boolean {
  return Boolean(filters.genre || filters.year || filters.provider);
}

async function hasTmdbFlatrateProvider(
  type: 'movie' | 'tv',
  itemId: string,
  providerIds: string,
  region: AvailabilityRegion,
  credential: string,
): Promise<boolean> {
  try {
    const response = await requestTmdbJson(
      `${type}/${itemId}/watch/providers`,
      credential,
      tmdbWatchProviderDetailSchema,
    );
    const requestedProviderIds = providerIds.split(',').map((id) => id.trim()).filter(Boolean);
    const regionResults = region === ALL_AVAILABILITY_REGION
      ? Object.values(response.results || {})
      : [response.results?.[region]];
    return regionResults.some((regionResult) => regionResult?.flatrate?.some((provider) => requestedProviderIds.includes(String(provider.provider_id))));
  } catch {
    return false;
  }
}

async function discoverMoviesOrTv(
  type: 'movie' | 'tv',
  section: DiscoverSection,
  query: string,
  credential: string,
  filters: TmdbCatalogFilters,
): Promise<readonly StremioPluginCatalogItem[]> {
  const normalizedQuery = query.trim();
  const isSearch = normalizedQuery.length > 0;
  const useDiscoveryEndpoint = !isSearch && tmdbUsesDiscoveryFilters(filters);
  const path = isSearch
    ? `search/${type}`
    : useDiscoveryEndpoint
      ? `discover/${type}`
      : TMDB_SECTION_ENDPOINTS[type][section];
  const discoveryQuery = useDiscoveryEndpoint
    ? {
      include_adult: false,
      sort_by: tmdbDiscoverySort(type, section),
      ...(filters.genre ? { with_genres: filters.genre } : {}),
      ...(filters.year
        ? type === 'movie'
          ? {
            'primary_release_date.gte': `${filters.year}-01-01`,
            'primary_release_date.lte': `${filters.year}-12-31`,
          }
          : {
            'first_air_date.gte': `${filters.year}-01-01`,
            'first_air_date.lte': `${filters.year}-12-31`,
          }
        : {}),
      ...(filters.provider
        ? {
          with_watch_providers: filters.provider,
          with_watch_monetization_types: 'flatrate',
        }
        : {}),
    }
    : {};

  const discoveryRegions = useDiscoveryEndpoint && filters.provider && filters.region === ALL_AVAILABILITY_REGION
    ? AVAILABILITY_REGIONS
    : [filters.region];
  const responses = await Promise.all(discoveryRegions.map((discoveryRegion) => requestTmdbJson(path, credential, tmdbListResponseSchema, {
    ...(isSearch ? { query: normalizedQuery, include_adult: false } : {}),
    ...discoveryQuery,
    ...(useDiscoveryEndpoint && filters.provider ? { watch_region: discoveryRegion } : {}),
    page: 1,
  })));
  const seenItemIds = new Set<string>();
  let items = responses.flatMap((response) => response.results || [])
    .filter((item) => {
      const itemId = String(item.id);
      if (seenItemIds.has(itemId)) return false;
      seenItemIds.add(itemId);
      return true;
    })
    .slice(0, DISCOVER_RESULT_LIMIT)
    .map((item) => mapTmdbToCatalog(item, type));

  if (isSearch) {
    items = items
      .filter((item) => hasGenreMatch(item, filters.genre, type))
      .filter((item) => hasYearMatch(item, filters.year));
    if (filters.provider) {
      const providerMatches = await Promise.all(items.map((item) => hasTmdbFlatrateProvider(
        type,
        item.id,
        filters.provider,
        filters.region,
        credential,
      )));
      items = items.filter((_, index) => providerMatches[index]);
    }
  }

  return items;
}

async function tmdbCatalogContentRating(
  item: StremioPluginCatalogItem,
  type: 'movie' | 'tv',
  credential: string,
): Promise<StremioPluginCatalogItem> {
  const contentRating = type === 'movie'
    ? tmdbContentRating({
        release_dates: await requestTmdbJson(
          `${type}/${item.id}/release_dates`,
          credential,
          tmdbReleaseDatesResponseSchema,
        ),
      }, type)
    : tmdbContentRating({
        content_ratings: await requestTmdbJson(
          `${type}/${item.id}/content_ratings`,
          credential,
          tmdbContentRatingsResponseSchema,
        ),
      }, type);

  return contentRating ? { ...item, contentRating } : item;
}

async function enrichTmdbCatalogRatings(
  items: readonly StremioPluginCatalogItem[],
  type: 'movie' | 'tv',
  credential: string,
): Promise<StremioPluginCatalogItem[]> {
  const enrichedItems = [...items];
  let nextIndex = 0;
  const workerCount = Math.min(4, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (!item || item.contentRating) continue;
      try {
        enrichedItems[index] = await tmdbCatalogContentRating(item, type, credential);
      } catch {
        // A missing rating should not make the rest of the Discover catalog fail.
      }
    }
  }));

  return enrichedItems;
}

async function enrichCatalogItemWithTmdbCredits(
  item: StremioPluginCatalogItem,
  type: 'movie' | 'tv',
  credential: string,
): Promise<StremioPluginCatalogItem> {
  const response = await requestTmdbJson(`${type}/${item.id}`, credential, tmdbDetailResponseSchema, {
    append_to_response: 'credits,images,videos,release_dates,content_ratings,watch/providers,external_ids',
  });
  const logoCandidates = tmdbLogoCandidates(response);
  const trailerUrl = item.trailerUrl
    || tmdbTrailerUrl(response)
    || await fetchTmdbTrailerFallback(type, response.id, credential);
  return mapTmdbCredits(response.credits, {
    ...item,
    imdbId: response.imdb_id || response.external_ids?.imdb_id || item.imdbId,
    description: response.overview || item.description,
    posterUrl: response.poster_path ? tmdbImage(response.poster_path, 'w500') : item.posterUrl,
    backgroundUrl: response.backdrop_path
      ? tmdbImage(response.backdrop_path, 'w1280')
      : item.backgroundUrl || (response.poster_path ? tmdbImage(response.poster_path, 'w1280') : item.posterUrl),
    logoUrl: logoCandidates[0] || item.logoUrl,
    rating: typeof response.vote_average === 'number'
      ? response.vote_average
      : item.rating,
    genres: response.genres?.map((genre) => genre.name).filter(Boolean) || item.genres,
    contentRating: tmdbContentRating(response, type) || item.contentRating,
    streamingProviders: tmdbStreamingProviders(response),
    trailerUrl,
    runtime: type === 'movie' && response.runtime && response.runtime > 0
      ? `${response.runtime}m`
      : item.runtime,
    seasonCount: type === 'tv' ? response.number_of_seasons || item.seasonCount : item.seasonCount,
    episodeCount: type === 'tv' ? response.number_of_episodes || item.episodeCount : item.episodeCount,
  });
}

async function enrichAnimeCatalogItemWithTmdbProviders(
  item: StremioPluginCatalogItem,
  credential: string,
): Promise<StremioPluginCatalogItem> {
  const isMovie = Boolean(item.runtime && !/\beps?\b/i.test(item.runtime));
  const tmdbType = isMovie ? 'movie' : 'tv';
  const search = await requestTmdbJson(`search/${tmdbType}`, credential, tmdbListResponseSchema, {
    query: item.title,
    include_adult: false,
    page: 1,
  });
  const results = search.results || [];
  if (results.length === 0) return { ...item, streamingProviders: item.streamingProviders || [] };

  const targetTitle = item.title.trim().toLowerCase();
  const targetYear = parseYearFromItem(item);
  const match = results.find((result) => (
    (result.title || result.name)?.trim().toLowerCase() === targetTitle
    && (!targetYear || yearFromDateValue(result.release_date || result.first_air_date) === targetYear)
  ))
    || results.find((result) => !targetYear || yearFromDateValue(result.release_date || result.first_air_date) === targetYear)
    || results[0];
  if (!match?.id) return { ...item, streamingProviders: item.streamingProviders || [] };

  const details = await requestTmdbJson(`${tmdbType}/${match.id}`, credential, tmdbDetailResponseSchema, {
    append_to_response: 'images,videos,watch/providers,release_dates,content_ratings,external_ids',
  });
  const logoCandidates = tmdbLogoCandidates(details);
  const streamingProviders = tmdbStreamingProviders(details);
  const contentRating = tmdbContentRating(details, tmdbType);
  const trailerUrl = item.trailerUrl
    || tmdbTrailerUrl(details)
    || await fetchTmdbTrailerFallback(tmdbType, match.id, credential);
  return {
    ...item,
    tmdbId: String(match.id),
    imdbId: details.imdb_id || details.external_ids?.imdb_id || item.imdbId,
    logoUrl: logoCandidates[0] || item.logoUrl,
    streamingProviders,
    ...(trailerUrl ? { trailerUrl } : {}),
    ...(contentRating ? { contentRating } : {}),
    ...(tmdbType === 'movie' && details.runtime && details.runtime > 0
      ? { runtime: `${details.runtime}m` }
      : {}),
    ...(tmdbType === 'tv'
      ? {
          seasonCount: details.number_of_seasons || item.seasonCount,
          episodeCount: details.number_of_episodes || item.episodeCount,
        }
      : {}),
  };
}

async function enrichAnimeCatalogMetadata(
  items: readonly StremioPluginCatalogItem[],
  credential: string,
): Promise<StremioPluginCatalogItem[]> {
  const enrichedItems = [...items];
  let nextIndex = 0;
  const workerCount = Math.min(4, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (!item || item.streamingProviders !== undefined) continue;
      try {
        enrichedItems[index] = await enrichAnimeCatalogItemWithTmdbProviders(item, credential);
      } catch {
        // A missing TMDB match should not make the rest of the anime catalog fail.
      }
    }
  }));

  return enrichedItems;
}

async function discoverAnime(
  query: string,
  section: DiscoverSection,
  genre = '',
  year = '',
): Promise<readonly StremioPluginCatalogItem[]> {
  const selectedGenres = genre.split(',').map((entry) => entry.trim()).filter(Boolean);
  const genresToRequest = selectedGenres.length > 0 ? selectedGenres : [''];
  const responses = await Promise.all(genresToRequest.map(async (selectedGenre) => {
    const payload = aniListDiscoverResponseSchema.parse(await desktopApi.requestMetadataProvider({
      provider: 'anilist',
      query: ANILIST_DISCOVER_QUERY,
      variables: {
        page: 1,
        perPage: DISCOVER_RESULT_LIMIT,
        sort: ANILIST_SECTION_SORT[section],
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(selectedGenre ? { genre: selectedGenre } : {}),
        ...(year.trim() ? { seasonYear: Number(year) } : {}),
      },
    }));
    if (payload.errors?.length) {
      throw new Error(payload.errors[0]?.message || 'AniList request returned an error.');
    }
    return payload.data?.Page?.media || [];
  }));

  const seenMediaIds = new Set<number>();
  return responses.flatMap((media) => media)
    .filter((media) => {
      if (seenMediaIds.has(media.id)) return false;
      seenMediaIds.add(media.id);
      return true;
    })
    .slice(0, DISCOVER_RESULT_LIMIT)
    .map(mapAnilistToCatalog);
}

function DiscoverOfflineState({ onRetry, onBrowseLibrary }: { onRetry: () => void; onBrowseLibrary: () => void }) {
  return (
    <div role="status" className="mx-auto mt-16 flex max-w-lg flex-col items-center px-6 pb-12 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] text-[var(--loom-muted)]">
        <WifiOff className="h-6 w-6" aria-hidden="true" />
      </span>
      <h2 className="mt-5 text-lg font-semibold text-[var(--loom-text)]">No internet connection</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-[var(--loom-muted)]">
        Discover uses online catalogs for new titles. Your local library is still available offline.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--loom-accent)] px-4 text-sm font-semibold text-[var(--loom-accent-foreground)] transition-colors hover:bg-[var(--loom-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-focus-glow)]"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </button>
        <button
          type="button"
          onClick={onBrowseLibrary}
          className="inline-flex h-10 items-center rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] px-4 text-sm font-medium text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-focus-glow)]"
        >
          Browse your library
        </button>
      </div>
    </div>
  );
}

type ThemeDropdownOption = {
  value: string;
  label: string;
  logoUrl?: string;
};

function ProviderLogo({ src, label }: { src?: string; label: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => {
    setFailedSrc(null);
  }, [src]);

  if (!src || failedSrc === src) {
    return (
      <span
        aria-hidden="true"
        className="grid h-6 w-6 shrink-0 place-items-center rounded bg-[var(--loom-surface-3)] text-[10px] font-semibold text-[var(--loom-muted)]"
      >
        {label.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className="h-6 w-6 shrink-0 rounded object-contain"
      onError={() => setFailedSrc(src)}
    />
  );
}

function ThemeDropdown({
  id,
  label,
  value,
  options,
  onChange,
  buttonClassName,
  searchable = false,
  searchPlaceholder = 'Search',
  emptySearchMessage = 'No matching options',
  multiSelect = false,
}: {
  id: string;
  label: string;
  value: string;
  options: ThemeDropdownOption[];
  onChange: (value: string) => void;
  buttonClassName?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptySearchMessage?: string;
  multiSelect?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{ left: number; top: number; width: number } | null>(null);
  const selectedValues = useMemo(
    () => value.split(',').map((entry) => entry.trim()).filter(Boolean),
    [value],
  );
  const selectedValueSet = useMemo(() => new Set(selectedValues), [selectedValues]);
  const selectedOption = multiSelect && selectedValues.length !== 1
    ? undefined
    : options.find((option) => option.value === (multiSelect ? selectedValues[0] : value));
  const selectedLabel = useMemo(
    () => {
      if (!multiSelect) return options.find((option) => option.value === value)?.label || options[0]?.label || 'Select';
      if (selectedValues.length === 0) return options[0]?.label || 'Select';
      if (selectedValues.length === 1) return options.find((option) => option.value === selectedValues[0])?.label || '1 selected';
      return `${selectedValues.length} genres`;
    },
    [multiSelect, options, selectedValues, value],
  );
  const filteredOptions = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) => option.label.toLowerCase().includes(normalizedQuery));
  }, [options, searchQuery]);

  const computeMenuStyle = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const buttonRect = button.getBoundingClientRect();
    const estimatedMenuHeight = searchable ? 280 : 272;
    const openAbove = window.innerHeight - buttonRect.bottom < estimatedMenuHeight && buttonRect.top > estimatedMenuHeight;
    setMenuStyle({
      left: buttonRect.left,
      top: openAbove ? buttonRect.top - estimatedMenuHeight - 6 : buttonRect.bottom + 6,
      width: buttonRect.width,
    });
  }, [searchable]);

  useEffect(() => {
    if (!isOpen) return;
    computeMenuStyle();
    const handleReposition = () => computeMenuStyle();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [computeMenuStyle, isOpen]);

  useEffect(() => {
    if (!isOpen) setSearchQuery('');
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative text-sm">
      <button
        type="button"
        id={id}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        ref={buttonRef}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (['Escape', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
            if (event.key === 'Escape') {
              setIsOpen(false);
              return;
            }
            event.preventDefault();
            setIsOpen(true);
          }
        }}
        className={`relative z-10 inline-flex h-8 min-w-[9rem] items-center gap-2 rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 pr-10 text-[var(--loom-text)] text-sm font-normal outline-none transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] ${buttonClassName || ''}`}
      >
        {selectedOption?.logoUrl !== undefined && <ProviderLogo src={selectedOption.logoUrl} label={selectedOption.label} />}
        <span className="truncate whitespace-nowrap">{selectedLabel}</span>
        <ChevronDown className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && menuStyle ? createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          className="fixed z-[9999] w-max max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-1 text-[var(--loom-text)] shadow-[0_18px_40px_rgba(0,0,0,0.30)]"
          style={{ left: menuStyle.left, top: menuStyle.top, minWidth: menuStyle.width }}
        >
          {searchable && (
            <div className="relative z-20 mb-1 bg-[var(--loom-surface-2)] p-1 pb-2">
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setIsOpen(false);
                  }
                }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                autoFocus
                className="loom-dropdown-search-input h-9 w-full rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-surface-3)] px-2.5 text-sm text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)]"
              />
            </div>
          )}
          <div className={searchable ? 'max-h-52 overflow-y-auto' : 'max-h-64 overflow-y-auto'}>
            {filteredOptions.length === 0 ? (
              <p className="px-3 py-2 text-sm text-[var(--loom-muted)]">{emptySearchMessage}</p>
            ) : filteredOptions.map((option) => {
              const selected = multiSelect
                ? option.value ? selectedValueSet.has(option.value) : selectedValues.length === 0
                : option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    if (!multiSelect) {
                      onChange(option.value);
                      setIsOpen(false);
                      return;
                    }
                    const nextValues = new Set(selectedValues);
                    if (!option.value) nextValues.clear();
                    else if (nextValues.has(option.value)) nextValues.delete(option.value);
                    else nextValues.add(option.value);
                    onChange(Array.from(nextValues).join(','));
                  }}
                  className={`relative z-10 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${selected
                    ? 'bg-[var(--loom-surface-3)] text-[var(--loom-text)]'
                    : 'text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]'
                  }`}
                >
                  {multiSelect && (
                    <span
                      aria-hidden="true"
                      className={`grid h-4 w-4 shrink-0 place-items-center rounded border text-[11px] leading-none ${selected
                        ? 'border-[var(--loom-text)] bg-[var(--loom-text)] text-[var(--loom-bg)]'
                        : 'border-[var(--loom-muted)]'
                      }`}
                    >
                      {selected ? '✓' : null}
                    </span>
                  )}
                  {option.logoUrl !== undefined && <ProviderLogo src={option.logoUrl} label={option.label} />}
                  <span className="truncate whitespace-nowrap">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default function PluginDiscover() {
  return <DiscoverCatalog mode="discover" />;
}

export function DiscoverCatalog({ mode = 'discover' }: { mode?: 'discover' | 'home' }) {
  const { theme } = useTheme();
  const { activeProfile } = useProfiles();
  const location = useLocation();
  const initialFilterState = useMemo(() => parseDiscoverFilterState(location.search), [location.search]);
  const isHome = mode === 'home';
  const routePath = isHome ? '/' : DISCOVER_ROUTE;
  const pageRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollTopRef = useRef(0);
  const discoverCache = useRef<DiscoverCacheState>(loadDiscoverCacheFromStorage());
  const initialRegion = normalizeAvailabilityRegion(initialFilterState.region);
  const initialYearFilter = initialFilterState.yearFilter.trim();
  const initialResolvedYearFilter = /^(19|20)\d{2}$/.test(initialYearFilter) ? initialYearFilter : '';
  const initialCacheId = makeCacheId(
    initialFilterState.contentType,
    initialFilterState.section,
    initialFilterState.query,
    normalizeGenreFilter(initialFilterState.genreFilter),
    initialResolvedYearFilter,
    initialFilterState.platformFilter,
    initialRegion,
  );
  const initialCachedItems = getValidCachedItems(discoverCache.current, initialCacheId);
  const [tmdbCredential, setTmdbCredential] = useState('');
  const [omdbCredential, setOmdbCredential] = useState('');
  const [query, setQuery] = useState(initialFilterState.query);
  const [contentType, setContentType] = useState<DiscoverType>(initialFilterState.contentType);
  const [section, setSection] = useState<DiscoverSection>(initialFilterState.section);
  const [genreFilter, setGenreFilter] = useState(initialFilterState.genreFilter);
  const [genreOptions, setGenreOptions] = useState<GenreOption[]>([]);
  const [yearFilter, setYearFilter] = useState(initialResolvedYearFilter);
  const [platformFilter, setPlatformFilter] = useState(initialFilterState.platformFilter);
  const [availabilityRegion, setAvailabilityRegion] = useState<AvailabilityRegion>(initialRegion);
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([]);
  const [providerOptionsLoading, setProviderOptionsLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [items, setItems] = useState<readonly StremioPluginCatalogItem[]>(() => initialCachedItems
    ? initialCachedItems.filter((item) => hasYearMatch(item, initialResolvedYearFilter))
    : []);
  const [loading, setLoading] = useState(() => !initialCachedItems);
  const [isHeaderScrolled, setIsHeaderScrolled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'offline' | 'provider' | 'generic' | null>(null);
  const [trailerItem, setTrailerItem] = useState<StremioPluginCatalogItem | null>(null);
  const catalogRequestRevision = useRef(0);
  const searchTimer = useRef<number | null>(null);
  const queryRef = useRef('');
  const genreRef = useRef('');
  const yearRef = useRef('');
  const platformRef = useRef('');
  const regionRef = useRef<AvailabilityRegion>(initialRegion);
  const detailsCache = useRef(new Map<string, Promise<StremioPluginCatalogItem>>());
  const providerOptionsCache = useRef<Record<string, ProviderOption[]>>({});
  const providerLoadTracker = useRef<Record<string, Promise<ProviderOption[]> | null>>({});
  const regionWasExplicitRef = useRef(Boolean(initialFilterState.region.trim()));
  const genreOptionsCache = useRef<Record<DiscoverType, GenreOption[]>>({
    movie: [],
    tv: [],
    anime: [],
  });
  const activeContentTypeRef = useRef<DiscoverType>(contentType);
  const previousContentTypeRef = useRef<DiscoverType>(contentType);
  const genreLoadTracker = useRef<Record<DiscoverType, Promise<GenreOption[]> | null>>({
    movie: null,
    tv: null,
    anime: null,
  });
  const navigate = useNavigate();

  const availableSections = useMemo(() => DISCOVER_SECTIONS[contentType], [contentType]);
  const yearOptions = useMemo(() => releaseYearOptions(), []);
  const isModern = theme.homeStyle === 'modern';
  const frameClass = isModern ? 'loom-modern-content-frame' : 'loom-frame';
  /* The library routes float a search bar above their frame and use pt-24 to
     clear it. Discover carries its search inline in a sticky header instead,
     so it only has to clear the draggable title strip — see
     .loom-discover-page-frame, which is platform-aware because that strip only
     exists on macOS. */
  const topPaddingClass = isModern ? 'pt-6' : 'loom-discover-page-frame';
  const currentSearch = location.search.startsWith('?') ? location.search.slice(1) : location.search;
  const viewStateStorageKey = isHome ? 'loomtv:home-discover-view-state-v1' : DISCOVER_VIEW_STATE_STORAGE_KEY;

  useEffect(() => {
    const nextSearch = buildDiscoverSearch({
      contentType,
      section,
      genreFilter,
      yearFilter,
      platformFilter,
      region: availabilityRegion,
      query,
    });
    if (nextSearch === currentSearch) return;
    void navigate(
      {
        pathname: routePath,
        search: nextSearch ? `?${nextSearch}` : '',
      },
      { replace: true },
    );
  }, [availabilityRegion, contentType, genreFilter, platformFilter, query, currentSearch, navigate, routePath, section, yearFilter]);

  useEffect(() => {
    let isActive = true;
    void (async () => {
      try {
        const settings = await desktopApi.getSettings();
        if (!isActive) return;
        setTmdbCredential(normalizeTmdbCredential(settings.metadataApiKeys?.tmdb || settings.tmdbApiKey || ''));
        setOmdbCredential((settings.metadataApiKeys?.omdb || settings.omdbApiKey || '').trim());
        if (!regionWasExplicitRef.current && activeProfile?.id) {
          try {
            const restrictions = await desktopApi.getProfileRestrictions(activeProfile.id);
            if (isActive) setAvailabilityRegion(normalizeAvailabilityRegion(restrictions.country));
          } catch {
            // US remains the conservative availability fallback.
          }
        }
      } catch (settingsError) {
        if (!isActive) return;
        setError(errorMessage(settingsError));
        setErrorKind('generic');
      }
    })();
    return () => {
      isActive = false;
    };
  }, [activeProfile?.id]);

  useEffect(() => {
    if (!pageRef.current) return;
    try {
      const raw = sessionStorage.getItem(viewStateStorageKey);
      if (!raw) return;
      const saved = parseStoredValue(raw, discoverViewStateSchema, {});
      if (saved.search !== location.search || typeof saved.scrollTop !== 'number' || !Number.isFinite(saved.scrollTop) || saved.scrollTop <= 0) {
        return;
      }
      pendingScrollTopRef.current = Math.max(0, saved.scrollTop);
    } catch {
      // Ignore invalid or unavailable storage state.
    }
  }, [location.search, viewStateStorageKey]);

  useEffect(() => {
    if (loading || items.length === 0 || pendingScrollTopRef.current <= 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const page = pageRef.current;
      if (!page) return;
      page.scrollTop = pendingScrollTopRef.current;
      pendingScrollTopRef.current = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [items.length, loading, location.search]);

  useEffect(() => {
    const page = pageRef.current;
    return () => {
      if (!page) return;
      try {
        sessionStorage.setItem(
          viewStateStorageKey,
          JSON.stringify({
            search: location.search,
            scrollTop: page.scrollTop,
          }),
        );
      } catch {
        // Ignore storage persistence failures.
      }
    };
  }, [location.search, viewStateStorageKey]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    activeContentTypeRef.current = contentType;
  }, [contentType]);

  useEffect(() => {
    genreRef.current = genreFilter;
  }, [genreFilter]);

  useEffect(() => {
    yearRef.current = yearFilter;
  }, [yearFilter]);

  useEffect(() => {
    platformRef.current = platformFilter;
  }, [platformFilter]);

  useEffect(() => {
    regionRef.current = availabilityRegion;
  }, [availabilityRegion]);

  const getCachedItems = useCallback((cacheId: CachedCacheId): readonly StremioPluginCatalogItem[] | null => {
    const now = Date.now();
    const today = toLocalDateKey();
    const cache = discoverCache.current;
    if (cache.date !== today) {
      discoverCache.current = { date: today, entries: {} };
      try {
        localStorage.removeItem(DISCOVER_CACHE_STORAGE_KEY);
      } catch {
        // Ignore cache storage failures, fallback to memory cache only.
      }
      return null;
    }

    const cached = getValidCachedItems(cache, cacheId, now);
    if (!cached) {
      const entry = cache.entries[cacheId];
      const shouldCleanEntry = Boolean(entry && entry.expiresAt >= now && !hasCachedImageCandidate(entry.items));
      if (shouldCleanEntry) {
        delete cache.entries[cacheId];
        try {
          localStorage.setItem(DISCOVER_CACHE_STORAGE_KEY, JSON.stringify(cache));
        } catch {
          // Ignore cache cleanup persistence failures.
        }
      }
      return null;
    }
    return cached;
  }, []);

  const setCachedItems = useCallback((cacheId: CachedCacheId, nextItems: readonly StremioPluginCatalogItem[]) => {
    const today = toLocalDateKey();
    if (discoverCache.current.date !== today) {
      discoverCache.current = { date: today, entries: {} };
    }

    discoverCache.current.entries[cacheId] = {
      expiresAt: nextMidnightAt(),
      items: [...nextItems],
    };

    try {
      localStorage.setItem(DISCOVER_CACHE_STORAGE_KEY, JSON.stringify(discoverCache.current));
    } catch {
      // Ignore persistence failures.
    }
  }, []);

  const ensureGenreOptions = useCallback(async (type: DiscoverType) => {
    const cached = genreOptionsCache.current[type];
    if (cached.length > 0) {
      setGenreOptions(cached);
      return;
    }

    if (genreLoadTracker.current[type]) {
      const inFlight = genreLoadTracker.current[type];
      if (!inFlight) return;
      try {
        const options = await inFlight;
        if (type === activeContentTypeRef.current) {
          setGenreOptions(options);
        }
      } catch {
        if (type === activeContentTypeRef.current) {
          setGenreOptions([]);
        }
      }
      return;
    }

    const loader = type === 'anime'
      ? discoverAniListGenres()
      : (async () => {
        if (!tmdbCredential) return [] as GenreOption[];
        return discoverTmdbGenres(type, tmdbCredential);
      })();

    genreLoadTracker.current[type] = loader;
    try {
      const options = await loader;
      genreLoadTracker.current[type] = null;
      genreOptionsCache.current = {
        ...genreOptionsCache.current,
        [type]: [...options],
      };
      if (type === activeContentTypeRef.current) {
        setGenreOptions(options);
      }
    } catch {
      genreLoadTracker.current[type] = null;
      if (type === activeContentTypeRef.current) {
        setGenreOptions([]);
      }
    }
  }, [tmdbCredential]);

  const ensureProviderOptions = useCallback(async (type: GenreSourceType, region: AvailabilityRegion) => {
    const cacheKey = `${type}:${region}`;
    const cached = providerOptionsCache.current[cacheKey];
    if (cached) {
      if (type === activeContentTypeRef.current && region === regionRef.current) {
        setProviderOptions(cached);
        setPlatformFilter((current) => normalizeProviderFilterValue(current, cached));
      }
      return;
    }

    const inFlight = providerLoadTracker.current[cacheKey];
    if (inFlight) {
      try {
        const options = await inFlight;
        if (type === activeContentTypeRef.current && region === regionRef.current) {
          setProviderOptions(options);
          setPlatformFilter((current) => normalizeProviderFilterValue(current, options));
        }
      } catch {
        // The original request owns the visible provider error state.
      }
      return;
    }

    if (!tmdbCredential) {
      if (type === activeContentTypeRef.current && region === regionRef.current) setProviderOptions([]);
      return;
    }

    const loader = discoverTmdbProviders(type, region, tmdbCredential);
    providerLoadTracker.current[cacheKey] = loader;
    if (type === activeContentTypeRef.current && region === regionRef.current) {
      setProviderOptionsLoading(true);
      setProviderError(null);
    }
    try {
      const options = await loader;
      providerOptionsCache.current[cacheKey] = [...options];
      if (type === activeContentTypeRef.current && region === regionRef.current) {
        setProviderOptions(options);
        setProviderOptionsLoading(false);
        setPlatformFilter((current) => normalizeProviderFilterValue(current, options));
      }
    } catch (loadError) {
      if (type === activeContentTypeRef.current && region === regionRef.current) {
        setProviderOptions([]);
        setProviderOptionsLoading(false);
        setProviderError(errorMessage(loadError));
      }
    } finally {
      providerLoadTracker.current[cacheKey] = null;
    }
  }, [tmdbCredential]);

  useEffect(() => {
    const contentTypeChanged = previousContentTypeRef.current !== contentType;
    previousContentTypeRef.current = contentType;
    if (contentTypeChanged) {
      setSection('trending');
      setGenreFilter('');
      setYearFilter('');
      setPlatformFilter('');
      detailsCache.current.clear();
      setError(null);
      setErrorKind(null);
    }
    const cachedGenres = genreOptionsCache.current[contentType];
    setGenreOptions(cachedGenres);
    if (cachedGenres.length === 0) {
      void ensureGenreOptions(contentType);
    }
  }, [contentType, ensureGenreOptions]);

  useEffect(() => {
    setProviderError(null);
    if (contentType === 'anime') {
      setProviderOptions([]);
      return;
    }
    void ensureProviderOptions(contentType, availabilityRegion);
  }, [availabilityRegion, contentType, ensureProviderOptions]);

  useEffect(() => {
    if (contentType === 'anime') return;
    if (!tmdbCredential) return;
    if (genreOptionsCache.current[contentType].length > 0) return;
    void ensureGenreOptions(contentType);
  }, [contentType, tmdbCredential, ensureGenreOptions]);

  const loadCatalog = useCallback(async (
    searchValue = '',
    genre = genreFilter,
    year = yearFilter,
    provider = platformFilter,
    region = availabilityRegion,
  ) => {
    const requestRevision = ++catalogRequestRevision.current;
    const trimmedQuery = searchValue.trim();
    const normalizedGenre = normalizeGenreFilter(genre);
    const providerGenre = contentType === 'anime'
      ? normalizedGenre
        .split(',')
        .map((selectedGenre) => genreOptions.find((option) => normalizeGenreFilter(option.value) === selectedGenre)?.value || selectedGenre.trim())
        .filter(Boolean)
        .join(',')
      : normalizedGenre;
    const normalizedYear = year.trim();
    const normalizedProvider = provider.trim();
    const normalizedRegion = normalizeAvailabilityRegion(region);
    const cacheId = makeCacheId(
      contentType,
      section,
      trimmedQuery,
      normalizedGenre,
      normalizedYear,
      normalizedProvider,
      normalizedRegion,
    );
    const hydrateRatings = (catalogItems: readonly StremioPluginCatalogItem[]) => {
      if (!tmdbCredential) {
        return;
      }
      const isAnime = contentType === 'anime';
      const isTmdbCatalog = contentType === 'movie' || contentType === 'tv';
      const alreadyHydrated = catalogItems.every((item) => (
        isAnime
          ? item.streamingProviders !== undefined
          : Boolean(item.contentRating)
      ));
      if ((!isAnime && !isTmdbCatalog) || alreadyHydrated) return;

      const metadataRequest = isAnime
        ? enrichAnimeCatalogMetadata(catalogItems, tmdbCredential)
        : enrichTmdbCatalogRatings(catalogItems, contentType, tmdbCredential);
      void metadataRequest.then((ratedItems) => {
        if (requestRevision !== catalogRequestRevision.current) return;
        setItems(ratedItems);
        setCachedItems(cacheId, ratedItems);
      });
    };
    const cached = getCachedItems(cacheId);
    if (cached) {
      if (requestRevision !== catalogRequestRevision.current) return;
      setItems(cached);
      setError(null);
      setErrorKind(null);
      setLoading(false);
      hydrateRatings(cached);
      return;
    }

    setLoading(true);
    setError(null);
    setErrorKind(null);

    try {
      let nextItems: readonly StremioPluginCatalogItem[];
      if (contentType === 'anime') {
        nextItems = await discoverAnime(trimmedQuery, section, providerGenre, normalizedYear);
      } else {
        if (!tmdbCredential) {
          throw new Error('TMDB API key is missing. Add it in Settings → Metadata API keys before browsing Movies or TV.');
        }
        nextItems = await discoverMoviesOrTv(contentType, section, trimmedQuery, tmdbCredential, {
          genre: normalizedGenre,
          year: normalizedYear,
          provider: normalizedProvider,
          region: normalizedRegion,
        });
      }

      const filteredItems = nextItems
        .filter((item) => hasGenreMatch(item, normalizedGenre, contentType))
        .filter((item) => hasYearMatch(item, normalizedYear));
      if (requestRevision !== catalogRequestRevision.current) return;
      setItems(filteredItems);
      setCachedItems(cacheId, filteredItems);
      hydrateRatings(filteredItems);
    } catch (loadError) {
      if (requestRevision !== catalogRequestRevision.current) return;
      setItems([]);
      setError(errorMessage(loadError));
      setErrorKind(isNetworkFailure(loadError) ? 'offline' : 'provider');
    } finally {
      if (requestRevision === catalogRequestRevision.current) setLoading(false);
    }
  }, [availabilityRegion, contentType, genreFilter, genreOptions, getCachedItems, platformFilter, section, setCachedItems, tmdbCredential, yearFilter]);

  useEffect(() => {
    if (searchTimer.current !== null) {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    catalogRequestRevision.current += 1;
    const cacheId = makeCacheId(
      contentType,
      section,
      query,
      normalizeGenreFilter(genreFilter),
      yearFilter,
      platformFilter,
      availabilityRegion,
    );
    if (getCachedItems(cacheId)) {
      void loadCatalog(query, genreFilter, yearFilter, platformFilter, availabilityRegion);
      return () => {
        catalogRequestRevision.current += 1;
      };
    }

    setLoading(true);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      void loadCatalog(query, genreFilter, yearFilter, platformFilter, availabilityRegion);
    }, PROVIDER_SEARCH_DEBOUNCE_MS);

    return () => {
      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
        searchTimer.current = null;
      }
      catalogRequestRevision.current += 1;
    };
  }, [availabilityRegion, contentType, genreFilter, getCachedItems, loadCatalog, platformFilter, query, section, tmdbCredential, yearFilter]);

  useEffect(() => {
    const now = Date.now();
    const delayMs = Math.max(1_000, nextMidnightAt(new Date(now)) - now);
    const timer = window.setTimeout(() => {
      discoverCache.current = { date: toLocalDateKey(), entries: {} };
      try {
        localStorage.removeItem(DISCOVER_CACHE_STORAGE_KEY);
      } catch {
        // Ignore cache storage failures.
      }
      void loadCatalog(queryRef.current, genreRef.current, yearRef.current, platformRef.current, regionRef.current);
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [loadCatalog]);

  const enrichWithCast = useCallback(async (item: StremioPluginCatalogItem): Promise<StremioPluginCatalogItem> => {
    if (!tmdbCredential && !omdbCredential) return item;
    const cacheKey = [
      'detail',
      item.type,
      item.id,
      tmdbCredential ? 'tmdb' : 'no-tmdb',
      omdbCredential ? 'omdb' : 'no-omdb',
    ].join(':');
    const existing = detailsCache.current.get(cacheKey);
    if (existing) return existing;

    let metadataPending = Promise.resolve(item);
    if (tmdbCredential && item.type === 'anime' && (item.streamingProviders === undefined || !item.trailerUrl)) {
      metadataPending = enrichAnimeCatalogItemWithTmdbProviders(item, tmdbCredential).catch(() => item);
    } else if (tmdbCredential && (item.type === 'movie' || item.type === 'tv')) {
      metadataPending = enrichCatalogItemWithTmdbCredits(item, item.type, tmdbCredential).catch(() => item);
    }
    const pending = metadataPending.then((metadataItem) => (
      omdbCredential
        ? enrichCatalogItemWithOmdbRatings(metadataItem, omdbCredential).catch(() => metadataItem)
        : metadataItem
    ));
    detailsCache.current.set(cacheKey, pending);
    const resolved = await pending;
    detailsCache.current.set(cacheKey, Promise.resolve(resolved));
    return resolved;
  }, [omdbCredential, tmdbCredential]);

  const openItemTrailer = useCallback(async (item: StremioPluginCatalogItem) => {
    const enrichedItem = item.trailerUrl ? item : await enrichWithCast(item);
    cacheExploreItem(enrichedItem);
    if (enrichedItem.trailerUrl) {
      setTrailerItem(enrichedItem);
      return;
    }
    const year = parseYearFromItem(enrichedItem);
    const query = `${enrichedItem.title}${year ? ` ${year}` : ''} official trailer`;
    await desktopApi.openExternal(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
  }, [enrichWithCast]);

  const openItemDetails = useCallback((item: StremioPluginCatalogItem) => {
    const discoverSourceRoute = location.search
      ? `${routePath}${location.search}`
      : routePath;
    cacheDiscoverReturnRoute(discoverSourceRoute);
    cacheExploreItem(item);
    const detailPath = item.type === 'movie'
      ? `/movie/${item.id}`
      : item.type === 'anime'
        ? `/anime/${item.id}`
        : `/tv/${item.id}`;

    // Navigate with the catalog payload immediately. Provider enrichment is
    // an enhancement and must never block opening the detail screen.
    navigate(detailPath, {
      state: {
        from: discoverSourceRoute,
        fromDiscover: true,
        stremioCatalogItem: item,
      },
    });

    void enrichWithCast(item)
      .then((nextItem) => cacheExploreItem(nextItem))
      .catch(() => undefined);
  }, [enrichWithCast, location.search, navigate, routePath]);

  const chipClass = (isActive: boolean) => `h-8 shrink-0 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${
    isActive
      ? 'border border-[var(--loom-accent)] bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]'
      : 'border border-[var(--loom-border)] bg-[var(--loom-surface-2)] text-[var(--loom-text)] hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)]'
  }`;

  const gridEntries = useMemo<GridEntry[]>(() => items.map((item, index) => ({
    id: `${item.type}:${item.id}`,
    item,
    rank: index + 1,
  })), [items]);
  const providerDropdownOptions = useMemo<ThemeDropdownOption[]>(() => [
    { value: '', label: providerOptionsLoading ? 'Loading platforms…' : 'All platforms' },
    ...providerOptions.map((provider) => ({
      value: provider.value,
      label: provider.label,
      logoUrl: provider.logoUrl,
    })),
  ], [providerOptions, providerOptionsLoading]);
  const regionDropdownOptions = useMemo<ThemeDropdownOption[]>(() => [
    { value: ALL_AVAILABILITY_REGION, label: 'All' },
    ...AVAILABILITY_REGIONS.map((region) => ({
      value: region,
      label: region === DEFAULT_AVAILABILITY_REGION ? `${region} · Default` : region,
    })),
  ], []);
  const activeProviderLabel = providerOptions.find((provider) => provider.value === platformFilter
    || provider.providerIds.some((providerId) => String(providerId) === platformFilter))?.label || 'the selected platform';
  const availabilityRegionLabel = availabilityRegion === ALL_AVAILABILITY_REGION ? 'all regions' : availabilityRegion;
  const providerStatusMessage = providerError && isNetworkFailure(providerError)
    ? 'Streaming filters are unavailable offline; browse filters remain available.'
    : providerError
      ? `Streaming platforms could not be loaded for ${availabilityRegionLabel}; browse filters remain available.`
      : null;
  const emptyStateMessage = yearFilter
    ? `No ${DISCOVER_TYPE_LABELS[contentType].toLowerCase()} match release year ${yearFilter}${genreFilter ? ' and the selected genre' : ''}${platformFilter ? ` while streaming on ${activeProviderLabel}` : ''}. Try another release year or clear the filters.`
    : genreFilter
      ? `No ${DISCOVER_TYPE_LABELS[contentType].toLowerCase()} match the selected genre in this provider catalog.`
      : platformFilter
        ? `No ${DISCOVER_TYPE_LABELS[contentType].toLowerCase()} are listed as streaming on ${activeProviderLabel} in ${availabilityRegionLabel}.`
        : 'No titles returned for this selection.';
  const historicalTrendingNote = yearFilter && section === 'trending'
    ? contentType === 'anime'
      ? 'Release year is applied by AniList; Trending remains the provider’s current ranking, not a historical trend snapshot.'
      : 'Release year is applied by TMDB; historical Trending is not available, so filtered results use popularity ordering.'
    : '';
  const retryCatalog = useCallback(() => {
    void loadCatalog(query, genreFilter, yearFilter, platformFilter, availabilityRegion);
  }, [availabilityRegion, genreFilter, loadCatalog, platformFilter, query, yearFilter]);

  return (
    <div
      ref={pageRef}
      className={isHome ? 'mt-10' : 'loom-page loom-library-page h-full overflow-y-auto'}
      onScroll={isHome ? undefined : (event) => setIsHeaderScrolled(event.currentTarget.scrollTop > 4)}
    >
      <div className={`${frameClass} ${isHome ? 'rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-5 sm:p-6' : 'loom-library-page-frame page-bottom-safe page-list-bottom-safe'} ${isHome ? 'pt-0' : topPaddingClass}`}>
        <header className={`loom-library-page-heading sticky top-0 z-40 isolate mb-6 flex min-h-8 shrink-0 flex-wrap items-start justify-between gap-4 border-b bg-[var(--loom-bg)] py-3 backdrop-blur-xl transition-[border-color,box-shadow] duration-150 ${isHeaderScrolled ? 'border-[var(--loom-border)] shadow-[0_12px_24px_-22px_rgb(0_0_0_/_0.9)]' : 'border-transparent'}`}>
          <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold text-[var(--loom-text)]">{isHome ? 'Browse more titles' : 'Discover'}</h1>
              <p className="mt-1 text-sm text-[var(--loom-muted)]">
                {isHome ? 'Browse provider catalogs without leaving Home.' : 'Discover new anime, TV shows, and movies to watch.'}
              </p>
            </div>
            {!isHome && (
              <LibrarySearch
                value={query}
                onChange={setQuery}
                placeholder="Search titles"
                placement="inline"
              />
            )}
          </div>
          <div className="w-full">
            <div className="flex items-center gap-2 overflow-x-auto overflow-y-visible pb-1">
              {(Object.keys(DISCOVER_SECTIONS) as DiscoverType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setContentType(type)}
                  aria-pressed={contentType === type}
                  className={chipClass(contentType === type)}
                >
                  {DISCOVER_TYPE_LABELS[type]}
                </button>
              ))}
              <span
                aria-hidden="true"
                className="mx-1 inline-block h-6 w-px self-center bg-[var(--loom-border)] my-auto opacity-90"
              />
              <ThemeDropdown
                id="discover-section-select"
                label="Discover filter"
                value={section}
                options={availableSections.map((discoverSection) => ({
                  value: discoverSection,
                  label: DISCOVER_SECTION_LABELS[discoverSection],
                }))}
                buttonClassName="!min-w-0"
                onChange={(value) => setSection(value as DiscoverSection)}
              />

              <ThemeDropdown
                id="discover-genre-select"
                label="Filter genre"
                value={genreFilter}
                options={[{ value: '', label: 'All Genres' }, ...genreOptions]}
                searchable
                searchPlaceholder="Search genres"
                emptySearchMessage="No matching genres"
                multiSelect
                onChange={(value) => setGenreFilter(value)}
              />
              <ThemeDropdown
                id="discover-year-select"
                label="Filter year"
                value={yearFilter}
                options={[{ value: '', label: 'All years' }, ...yearOptions.map((year) => ({ value: year, label: year }))]
                }
                buttonClassName="!min-w-0"
                searchable
                searchPlaceholder="Search years"
                emptySearchMessage="No matching years"
                onChange={setYearFilter}
              />
              {contentType !== 'anime' ? (
                <>
                  <ThemeDropdown
                    id="discover-platform-select"
                    label={`Streaming on in ${availabilityRegionLabel}`}
                    value={platformFilter}
                    options={providerDropdownOptions}
                    searchable
                    searchPlaceholder="Search platforms"
                    emptySearchMessage="No matching platforms"
                    onChange={setPlatformFilter}
                  />
                  <ThemeDropdown
                    id="discover-region-select"
                    label="Streaming availability region"
                    value={availabilityRegion}
                    options={regionDropdownOptions}
                    onChange={(value) => {
                      regionWasExplicitRef.current = true;
                      setAvailabilityRegion(normalizeAvailabilityRegion(value));
                    }}
                  />
                </>
              ) : null}
            </div>
            {providerStatusMessage && contentType !== 'anime' && (
              <p role="status" className="mt-2 text-xs text-[var(--loom-muted)]">{providerStatusMessage}</p>
            )}
            {historicalTrendingNote && <p className="mt-2 text-xs text-[var(--loom-muted)]">{historicalTrendingNote}</p>}
          </div>
        </header>

        {error && errorKind !== 'offline' && (
          <div role="alert" className="mt-4 rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <p className="flex items-start gap-2">
              <Compass className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          </div>
        )}

        {loading ? (
          <PosterGridShimmer className="mt-4" />
        ) : gridEntries.length === 0 ? (
          errorKind === 'offline' ? (
            <DiscoverOfflineState onRetry={retryCatalog} onBrowseLibrary={() => navigate('/')} />
          ) : (
            <p className="mt-10 text-center text-sm text-[var(--loom-muted)]">{emptyStateMessage}</p>
          )
        ) : (
          <VirtualPosterGrid
            items={gridEntries}
            renderItem={(entry) => (
              <StremioPosterCard
                item={entry.item}
                rank={entry.rank}
                metaLine={stremioMetaLine(entry.item)}
                showContentRating={false}
                onPlayTrailer={() => { void openItemTrailer(entry.item); }}
                onSelect={(selected) => {
                  void openItemDetails(selected);
                }}
              />
            )}
          />
        )}
      </div>
      <TrailerDialog
        open={Boolean(trailerItem)}
        title={trailerItem?.title || 'Trailer'}
        trailerUrl={trailerItem?.trailerUrl}
        onClose={() => setTrailerItem(null)}
      />
    </div>
  );
}
