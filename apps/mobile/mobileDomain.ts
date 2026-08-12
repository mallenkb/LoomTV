import type {
  LanApiResult,
  LanHlsSession,
  LanCastMember,
  LanEpisodeFile,
  LanEpisodeMeta,
  LanLibraryCard,
  LanLibraryIndexPayload,
  LanLibraryItemDetailsPayload,
  LanLibraryPayload,
  LanLocalMediaDetails,
  LanLocalMediaTrack,
  LanMediaItem,
  LanActiveProfile,
  LanClientConfig,
  LanPairResponse,
  LanProfileListEntry,
  LanProfilePreferences,
  LanProfileSummary,
  LanProviderRatings,
  LanStoredProgress,
  LanStreamOptions,
  LanSubtitleRecord,
} from '@loom-media-server/lan-protocol';

export type LibraryKind = 'home' | 'anime' | 'tv' | 'movies' | 'others' | 'settings';
export type SettingsSection = 'library' | 'network' | 'appearance' | 'about';
export type MobileLibraryFilter = 'all' | 'in-progress' | 'unwatched' | 'watched';
export type MobileSearchScope = 'all' | 'genre:drama' | 'genre:animation' | 'genre:action-adventure' | 'genre:comedy';

export type LocalMediaTrack = LanLocalMediaTrack;
export type LocalMediaDetails = LanLocalMediaDetails;
export type SubtitleRecord = LanSubtitleRecord;
export type EpisodeMeta = LanEpisodeMeta;
export type EpisodeFile = LanEpisodeFile;
export type CastMember = LanCastMember;

type MobileMediaIdentity = Pick<LanMediaItem, 'id' | 'type' | 'title' | 'filePath'>;
type MobileMediaMetadata = Partial<Omit<LanMediaItem, keyof MobileMediaIdentity>>;

export type MediaItem = MobileMediaIdentity & MobileMediaMetadata & {
  /** Present only on compact browse cards; full details are fetched on demand. */
  catalogRevision?: number;
};

const MOBILE_RECONNECT_BASE_DELAY_MS = 1_000;
const MOBILE_RECONNECT_MAX_DELAY_MS = 30_000;
export const MOBILE_DETAIL_ITEM_CACHE_LIMIT = 24;

export type MobileLibraryIndexPayload = LanLibraryIndexPayload<LanLibraryCard>;
export type MobileLibraryItemDetailsPayload = LanLibraryItemDetailsPayload<MediaItem>;

export function mobileDetailCacheKey(profileId: string, revision: number, mediaId: string): string {
  return `${profileId || 'profile:none'}:${revision}:${mediaId}`;
}

export function mobileCatalogIdentity(profileId: string | undefined, revision: number | undefined): string {
  return `${profileId || 'profile:none'}:${revision ?? -1}`;
}

export function mobileLibraryFromIndex(index: MobileLibraryIndexPayload): LibraryPayload {
  const fromCard = (card: LanLibraryCard): MediaItem => {
    const playbackReferences = card.playbackReferences || [];
    const firstReference = playbackReferences[0];
    const episodeFiles = playbackReferences.flatMap((reference): EpisodeFile[] => {
      const { episode, season } = reference;
      if (episode === undefined || season === undefined) return [];
      return [{
        season,
        episode,
        filePath: reference.progressKey,
        title: `Episode ${episode}`,
        ...(reference.durationSeconds ? { localMetadata: { durationSeconds: reference.durationSeconds } } : {}),
      }];
    });
    return {
      id: card.id,
      type: card.type,
      title: card.title,
      year: card.year,
      poster: card.poster,
      backdrop: card.backdrop,
      posterCandidates: card.posterCandidates,
      backdropCandidates: card.backdropCandidates,
      summary: card.summary,
      rating: card.rating,
      providerRatings: card.providerRatings,
      genres: card.genres,
      filePath: firstReference?.progressKey || '',
      lastPlayed: card.lastPlayed,
      episodeFiles,
      ...(episodeFiles.length === 0 && firstReference?.durationSeconds
        ? { localMetadata: { durationSeconds: firstReference.durationSeconds } }
        : {}),
      catalogRevision: index.revision,
    };
  };
  return {
    movies: index.movies.map(fromCard),
    tvShows: index.tvShows.map(fromCard),
    animeShows: index.animeShows.map(fromCard),
    others: (index.others || []).map(fromCard),
  };
}

export function mobileReconnectDelayMs(failedAttempts: number): number {
  const exponent = Math.max(0, Math.min(10, Math.floor(failedAttempts)));
  return Math.min(MOBILE_RECONNECT_MAX_DELAY_MS, MOBILE_RECONNECT_BASE_DELAY_MS * (2 ** exponent));
}

export function rememberMobileDetailItem(cache: Map<string, MediaItem>, item: MediaItem, cacheKey = item.id): void {
  cache.delete(cacheKey);
  cache.set(cacheKey, item);
  while (cache.size > MOBILE_DETAIL_ITEM_CACHE_LIMIT) {
    const oldestId = cache.keys().next().value;
    if (typeof oldestId !== 'string') break;
    cache.delete(oldestId);
  }
}

export type LibraryPayload = LanLibraryPayload<MediaItem>;
export type PairResponse = LanPairResponse<LibraryPayload>;

export function normalizeCertFingerprint(value: unknown): string {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/:/g, '')
    : '';
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : '';
}

export type Connection = {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  /** Pinned SHA-256 leaf-certificate fingerprint for the paired desktop. */
  certFingerprint: string;
  hostDeviceId: string;
  hostDeviceName: string;
  clientDeviceName: string;
  library: LibraryPayload;
  libraryEtag: string;
  selectionRevision?: number;
  catalogRevision?: number;
  catalogTransport?: 'compact' | 'legacy';
};

export type SavedConnection = Pick<Connection,
  'baseUrl' | 'deviceId' | 'deviceToken' | 'accessTokenExpiresAt' | 'refreshToken' |
  'refreshTokenExpiresAt' | 'certFingerprint' | 'hostDeviceId' | 'hostDeviceName' | 'clientDeviceName'>;

export type DiscoveredHost = {
  deviceId: string;
  deviceName: string;
  serviceName: string;
  baseUrl: string;
  certFingerprint: string;
};

export type MobileThemeSettings = { appThemeMode?: string; appThemeColor?: string; appDarkTheme?: string };
export type ApiResult<T> = LanApiResult<T>;
export type HlsSession = LanHlsSession;

export type OfficialArtworkResponse = {
  thumbnail?: string;
  cover?: string;
  summary?: string;
  rating?: number;
  providerRatings?: LanProviderRatings;
  genres?: string[];
  episodes?: unknown[];
  episodeSource?: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logo?: string;
  logoCandidates?: string[];
  error?: string;
};

export type OfficialMetadataCandidate = OfficialArtworkResponse & {
  id?: string;
  source?: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
  title?: string;
  year?: number;
  episodeCount?: number;
  episodePreview?: string[];
};

export type PosterCandidateSheetState = { item: MediaItem; candidates: OfficialMetadataCandidate[] };
export type StreamOptions = LanStreamOptions;
export type TrackPreference = {
  enabled: boolean;
  index?: number;
  language?: string;
  title?: string;
  codec?: string;
  forced?: boolean;
};
export type PlaybackTrackPreferences = { audio?: TrackPreference; subtitle?: TrackPreference };

export type PlayTarget = {
  title: string;
  subtitle?: string;
  streamPath: string;
  transcode: boolean;
  localMetadata?: LocalMediaDetails;
  subtitles?: SubtitleRecord[];
  startPosition?: number;
  mediaId?: string;
  mediaType?: MediaItem['type'];
  season?: number;
  episode?: number;
  thumbnail?: string;
  thumbnailCandidates?: string[];
};

export type MediaSegmentType = 'intro' | 'recap' | 'outro' | 'credits' | 'preview';
export type MediaSegment = {
  id: string;
  type: MediaSegmentType;
  startMs: number;
  endMs: number | null;
  confidence: number;
  source: 'manual' | 'chapter' | 'theintrodb' | 'aniskip' | 'chromaprint';
  mediaDurationMs: number;
  updatedAt: string;
};

export function activeKnownMediaSegmentAt(
  segments: ReadonlyArray<MediaSegment | (Omit<MediaSegment, 'type'> & { type: string })>,
  positionSeconds: number,
): MediaSegment | null {
  const active = segments.filter((segment): segment is MediaSegment => {
    if (segment.type !== 'intro' && segment.type !== 'recap' && segment.type !== 'outro' && segment.type !== 'credits' && segment.type !== 'preview') return false;
    const endSeconds = (segment.endMs ?? segment.mediaDurationMs) / 1000;
    return positionSeconds >= segment.startMs / 1000 && positionSeconds < endSeconds - 0.25;
  });
  const priority: Record<MediaSegmentType, number> = { recap: 0, intro: 1, outro: 2, preview: 3, credits: 4 };
  return active.sort((left, right) => priority[left.type] - priority[right.type] || left.startMs - right.startMs)[0] || null;
}

export function mobileMediaSegmentLabel(type: string, _movie: boolean): string {
  return ({ intro: 'Intro', recap: 'Recap', outro: 'Outro', credits: 'Credits', preview: 'Preview' } as Record<string, string>)[type] || 'Skip';
}

export type StoredProgress = LanStoredProgress;
export type MobileProfile = LanProfileSummary;
export type MobileActiveProfile = LanActiveProfile;
export type MobileProfilePreferences = LanProfilePreferences;
export type MobileProfileListEntry = LanProfileListEntry;
export type MobileClientConfig = LanClientConfig;
