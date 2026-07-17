import type {
  LanLibraryPayload,
  LanStoredProgress,
  LanStreamOptions,
} from '../../../../packages/lan-protocol/src/index.ts';

export type LibraryFolderKind = 'movies' | 'tvShows' | 'anime' | 'others';
export type LibraryScanMode = 'quick' | 'metadata' | 'full';
export type MetadataApiKeys = Record<string, string>;

export interface LibraryFolderGroups { movies: string[]; tvShows: string[]; anime: string[]; others: string[] }
export interface LibraryFolderStatus {
  path: string;
  kind: LibraryFolderKind;
  state: 'available' | 'unavailable';
  isNetworkLike: boolean;
  checkedAt: number;
  message: string;
}

export interface WireLocalMediaDetails {
  fileSize?: number;
  modifiedAtMs?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  videoProfile?: string;
  pixelFormat?: string;
  audioCodec?: string;
  audioTracks?: number;
  subtitleTracks?: number;
  bitrateKbps?: number;
  container?: string;
  chapters?: { startMs: number; endMs: number; title: string }[];
}

export interface WireEpisodeMeta {
  season: number;
  number: number;
  title: string;
  summary: string;
  still: string;
  rating: number;
  airDate: string;
  localMetadata?: WireLocalMediaDetails;
}

export interface WireEpisodeFile {
  season: number;
  episode: number;
  filePath: string;
  title?: string;
  thumbnail?: string;
  still?: string;
  subtitles?: { lang: string; label: string; url: string }[];
  localMetadata?: WireLocalMediaDetails;
}

export interface WireMediaItem {
  id: string;
  type: 'movie' | 'tv' | 'anime';
  title: string;
  year: number;
  poster: string;
  backdrop: string;
  logo?: string;
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logoCandidates?: string[];
  summary: string;
  rating: number;
  genres: string[];
  cast: { name: string; character: string; image: string }[];
  filePath: string;
  fileSize?: number;
  lastPlayed?: number;
  seasons?: { number: number; title: string; episodeCount: number }[];
  episodes?: WireEpisodeMeta[];
  episodeFiles?: WireEpisodeFile[];
  subtitles?: { lang: string; label: string; url: string }[];
  localMetadata?: WireLocalMediaDetails;
  providerIds?: {
    tmdbId?: string;
    imdbId?: string;
    tvdbId?: string;
    malId?: string;
    malIdBySeason?: Record<string, string>;
  };
}

export interface LibraryPayload extends LanLibraryPayload<WireMediaItem> {
  movies: WireMediaItem[];
  tvShows: WireMediaItem[];
  animeShows?: WireMediaItem[];
  libraryFolders: string[];
  libraryFolderGroups?: LibraryFolderGroups;
  libraryFolderStatuses?: LibraryFolderStatus[];
}

export interface LibraryScanProgress {
  isComplete: boolean;
  scannedFolders: number;
  totalFolders: number;
}

export interface SettingsPayload {
  omdbApiKey?: string;
  tmdbApiKey?: string;
  metadataApiKeys?: MetadataApiKeys;
  openSubtitlesUsername?: string;
  openSubtitlesPassword?: string;
  openSubtitlesLanguages?: string;
  openSubtitlesAutoDownload?: boolean;
  autoSyncIntervalHours?: number;
  playbackSkipBackSeconds?: number;
  playbackSkipForwardSeconds?: number;
  localSkipAnalysisEnabled?: boolean;
  skipAnalysis?: SkipAnalysisSettings;
  sidebarNavOrder?: string[];
  customFolderNames?: Record<string, string>;
  appThemeMode?: 'dark' | 'light';
  appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue';
  appDarkTheme?: 'default' | 'justwatch' | 'black';
  appLoaderStyle?: 'play-mark' | 'logo-mark' | 'horizontal-logo';
  localNetworkSharingEnabled?: boolean;
  localNetworkShareToken?: string;
}

export type SkipAnalysisSegmentType = 'intro' | 'recap' | 'credits' | 'preview';
export type SkipAnalysisMode = 'full' | 'chapter-only' | 'providers-only';
export type SkipAnalysisDurationLimit = { minSeconds: number; maxSeconds: number };
export interface SkipAnalysisSettings {
  enabled: boolean;
  analyzeNewMedia: boolean;
  enabledTypes: Record<SkipAnalysisSegmentType, boolean>;
  promptTypes: Record<SkipAnalysisSegmentType, boolean>;
  durationLimits: Record<SkipAnalysisSegmentType, SkipAnalysisDurationLimit> & {
    movieCredits: SkipAnalysisDurationLimit;
  };
  suppressFirstEpisodeIntro: boolean;
  analyzeSpecials: boolean;
  exclusions: {
    seriesIds: string[];
    movieIds: string[];
    seasons: string[];
    paths: string[];
  };
  seasonOverrides: Record<string, SkipAnalysisMode>;
}

export type SkipAnalysisRunScope = {
  mediaId?: string;
  season?: number;
  episode?: number;
};

export interface MetadataKeyTestResult { provider: string; ok: boolean; message: string }
export interface PlaybackLogoResult { logo?: string; logoCandidates?: string[] }
export interface FFmpegStatus { available: boolean; path: string | null }
export type ApiResult<T> = { ok: boolean; data?: T; error?: string };

export interface UpdateState {
  status: 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'not-available' | 'error';
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  supported: boolean;
  downloadPercent?: number;
  latestVersion?: string;
  releaseUrl?: string;
  message?: string;
  checkedAt?: string;
}

export interface SubtitleStyleOptions {
  delaySeconds?: number;
  position?: number;
  scale?: number;
  fontSize?: number;
  fontColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderEnabled?: boolean;
  backgroundColor?: string;
  backgroundEnabled?: boolean;
}

export interface TranscodeOptions {
  preset?: 'auto' | 'software' | 'videotoolbox' | 'nvenc' | 'qsv';
  startSeconds?: number;
  videoTrackIndex?: number;
  audioTrackIndex?: number;
  subtitleTrackIndex?: number;
  subtitleStreamOrdinal?: number;
  subtitleCodec?: string;
  subtitleFilePath?: string;
  secondarySubtitleTrackIndex?: number;
  secondarySubtitleStreamOrdinal?: number;
  secondarySubtitleCodec?: string;
  secondarySubtitleFilePath?: string;
  subtitleStyle?: SubtitleStyleOptions;
  forceTranscode?: boolean;
}

export interface TranscodeSession {
  sessionId: string;
  filePath: string;
  playlistUrl: string;
  outputDir: string;
  seekable: boolean;
  startSeconds: number;
}

export type StreamUrlOptions = LanStreamOptions & Pick<TranscodeOptions,
  | 'videoTrackIndex' | 'secondarySubtitleTrackIndex' | 'secondarySubtitleStreamOrdinal'
  | 'secondarySubtitleCodec' | 'secondarySubtitleFilePath'
> & { subtitleStyle?: SubtitleStyleOptions };

export type PlaybackMode = 'direct' | 'remux' | 'direct-stream' | 'transcode';

export interface StreamUrlResult {
  url: string;
  contentType: string;
  fileName: string;
  isTranscoded?: boolean;
  isRemuxed?: boolean;
  playbackMode?: PlaybackMode;
  decisionReason?: string;
}

export interface LocalNetworkPairedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  lastAddress?: string;
}

export interface LocalNetworkStatus {
  sharingEnabled: boolean;
  token: string;
  deviceId?: string;
  deviceName?: string;
  networkName: string;
  port: number;
  addresses: string[];
  baseUrl: string | null;
  libraryUrl: string | null;
  pairedDevices?: LocalNetworkPairedDevice[];
}

export interface LocalNetworkPeer {
  deviceId: string;
  deviceName: string;
  host: string;
  port: number;
  addresses: string[];
  appVersion: string;
}

export interface RemoteLibraryConnection {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  hostDeviceId?: string;
  hostDeviceName?: string;
  library: LibraryPayload;
  libraryEtag: string;
}

export type StoredProgress = LanStoredProgress;
export interface TrackPreference { enabled: boolean; index?: number; language?: string; title?: string; codec?: string; forced?: boolean }
export interface PlaybackTrackPreferences { audio?: TrackPreference; subtitle?: TrackPreference }
export type MediaSegmentType = 'intro' | 'recap' | 'credits' | 'preview';
export type MediaSegmentSource = 'manual' | 'chapter' | 'theintrodb' | 'aniskip' | 'chromaprint';
export interface MediaSegment {
  id: string;
  type: MediaSegmentType;
  startMs: number;
  endMs: number | null;
  confidence: number;
  source: MediaSegmentSource;
  mediaDurationMs: number;
  updatedAt: string;
  analysisMetadata?: {
    detector?: 'chromaprint' | 'blackframe' | 'chapter';
    peerSupport?: number;
    originalStartMs?: number;
    originalEndMs?: number | null;
    startSnap?: 'chapter' | 'silence' | 'keyframe' | 'media-edge' | 'original';
    endSnap?: 'chapter' | 'silence' | 'keyframe' | 'media-edge' | 'original';
    confidenceComponents?: Record<string, number>;
    userDecision?: { status?: 'active' | 'rejected'; type?: MediaSegmentType };
  };
}
export interface MediaSegmentRequest { mediaId: string; season?: number; episode?: number }
export interface MediaSegmentResponse { segments: MediaSegment[]; revision: string }
export type ManualMediaSegmentInput = MediaSegmentRequest & { candidateId?: string; type: MediaSegmentType; startMs: number; endMs: number | null };
export interface ManagedMediaSegment extends MediaSegment {
  mediaId: string;
  season: number;
  episode: number;
  status: 'active' | 'review' | 'rejected';
}
export interface LocalSegmentAnalysisStatus {
  enabled: boolean;
  available: boolean;
  helperPath: string | null;
  state: 'disabled' | 'idle' | 'queued' | 'running' | 'paused' | 'unavailable' | 'error';
  message?: string;
  paused?: boolean;
  pendingCount?: number;
  currentJob?: { jobKey: string; kind: string; mediaId: string; season: number; episode: number; detail: string };
  lastError?: string;
  fingerprintCount?: number;
  fingerprintCacheBytes?: number;
  progress?: { complete: number; total: number };
  lastCompletedAt?: number;
  recentJobs?: Array<{
    jobKey: string;
    kind: string;
    mediaId: string;
    season: number;
    episode: number;
    state: string;
    detail: string;
    updatedAt: number;
  }>;
}

export interface OfficialArtworkResult {
  thumbnail?: string;
  cover?: string;
  summary?: string;
  rating?: number;
  episodes?: WireEpisodeMeta[];
  episodeSource?: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logoCandidates?: string[];
  logo?: string;
}

export type OfficialMetadataCandidate = OfficialArtworkResult & {
  id: string;
  source: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
  title: string;
  year?: number;
  genres?: string[];
  episodeCount?: number;
  episodePreview?: string[];
};
