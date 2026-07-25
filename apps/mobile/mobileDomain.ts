import type {
  LanApiResult,
  LanHlsSession,
  LanLibraryPayload,
  LanActiveProfile,
  LanClientConfig,
  LanPairResponse,
  LanProfileListEntry,
  LanProfilePreferences,
  LanProfileSummary,
  LanStoredProgress,
  LanStreamOptions,
} from '@loom-media-server/lan-protocol';

export type LibraryKind = 'home' | 'anime' | 'tv' | 'movies' | 'others' | 'settings';
export type SettingsSection = 'library' | 'network' | 'appearance' | 'about';
export type MobileLibraryFilter = 'all' | 'in-progress' | 'unwatched' | 'watched';
export type MobileSearchScope = 'all' | 'genre:drama' | 'genre:animation' | 'genre:action-adventure' | 'genre:comedy';

export type LocalMediaTrack = {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'data' | 'unknown';
  codec?: string;
  language?: string;
  title?: string;
  channels?: number;
  width?: number;
  height?: number;
  profile?: string;
  pixelFormat?: string;
  default?: boolean;
  forced?: boolean;
};

export type LocalMediaDetails = {
  durationSeconds?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioTracks?: number;
  subtitleTracks?: number;
  tracks?: LocalMediaTrack[];
  container?: string;
  width?: number;
  height?: number;
};

export type SubtitleRecord = { lang: string; label: string; url: string };
export type EpisodeMeta = { season: number; number: number; title?: string; summary?: string; rating?: number };
export type EpisodeFile = {
  season: number;
  episode: number;
  filePath: string;
  title?: string;
  thumbnail?: string;
  still?: string;
  subtitles?: SubtitleRecord[];
  localMetadata?: LocalMediaDetails;
};
export type CastMember = { name: string; character?: string; image?: string };

export type MediaItem = {
  id: string;
  type: 'movie' | 'tv' | 'anime';
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  posterCandidates?: string[];
  backdropCandidates?: string[];
  summary?: string;
  rating?: number;
  genres?: string[];
  cast?: CastMember[];
  episodes?: EpisodeMeta[];
  filePath: string;
  lastPlayed?: number;
  subtitles?: SubtitleRecord[];
  localMetadata?: LocalMediaDetails;
  episodeFiles?: EpisodeFile[];
};

export type LibraryPayload = LanLibraryPayload<MediaItem>;
export type PairResponse = LanPairResponse<LibraryPayload>;

export type Connection = {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  hostDeviceId: string;
  hostDeviceName: string;
  clientDeviceName: string;
  library: LibraryPayload;
  libraryEtag: string;
  selectionRevision?: number;
};

export type SavedConnection = Pick<Connection,
  'baseUrl' | 'deviceId' | 'deviceToken' | 'accessTokenExpiresAt' | 'refreshToken' |
  'refreshTokenExpiresAt' | 'hostDeviceId' | 'hostDeviceName' | 'clientDeviceName'>;

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
