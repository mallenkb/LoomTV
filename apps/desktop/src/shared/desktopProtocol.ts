import type {
  LanActiveProfile,
  LanContentRating,
  LanLibraryCard,
  LanLibraryIndexPayload,
  LanLibraryItemDetailsPayload,
  LanLibraryPayload,
  LanLibraryPlaybackReference,
  LanOriginPlatform,
  LanProviderRatings,
  LanStreamingProvider,
  LanPlaybackCapabilities,
  LanPlaybackPlan,
  LanPlaybackPlanResponse,
  LanProfileListEntry,
  LanProfileListKind,
  LanProfilePreferences,
  LanProfileRestrictions,
  LanProfileSummary,
  LanProfileType,
  LanStoredProgress,
  LanStreamOptions,
} from '@loom-media-server/lan-protocol';
import type { TranscodeCapabilities } from '@loom-media-server/transcode-capabilities';

export type PlaybackCapabilities = LanPlaybackCapabilities;
export type PlaybackPlan = LanPlaybackPlan;
export type PlaybackPlanResponse = LanPlaybackPlanResponse;

export type LibraryFolderKind = 'movies' | 'tvShows' | 'anime' | 'others';
export type LibraryScanMode = 'quick' | 'metadata' | 'full';
export type MetadataApiKeys = Record<string, string>;
export type MetadataProviderRequest =
  | { provider: 'omdb'; query: Record<string, string | number | boolean> }
  | { provider: 'tmdb'; path: string; query?: Record<string, string | number | boolean> }
  | { provider: 'anilist'; query: string; variables?: Record<string, unknown> };

export interface LibraryFolderGroups { movies: string[]; tvShows: string[]; anime: string[]; others: string[] }
export interface LibraryFolderStatus {
  path: string;
  kind: LibraryFolderKind;
  state: 'available' | 'degraded' | 'unavailable';
  isNetworkLike: boolean;
  checkedAt: number;
  message: string;
}

export interface WireLocalMediaTrack {
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
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  default?: boolean;
  forced?: boolean;
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
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  audioCodec?: string;
  audioTracks?: number;
  subtitleTracks?: number;
  tracks?: WireLocalMediaTrack[];
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
  contentRatings?: Record<string, LanContentRating>;
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
  subtitles?: WireSubtitleRecord[];
  localMetadata?: WireLocalMediaDetails;
}

export type WireSubtitleRecord = {
  lang: string;
  label: string;
  url: string;
  source?: 'sidecar' | 'opensubtitles';
  format?: string;
};

export type MpvPlaybackTrack = {
  id: number;
  type: 'video' | 'audio' | 'subtitle';
  codec?: string;
  language?: string;
  title?: string;
  channels?: number;
  default?: boolean;
  forced?: boolean;
  selected?: boolean;
  external?: boolean;
  source: 'embedded' | 'sidecar' | 'opensubtitles';
};

export type MpvPlaybackState = {
  sessionId: string;
  status: 'starting' | 'loading' | 'ready' | 'ended' | 'error' | 'closed';
  position?: number;
  duration?: number;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
  speed?: number;
  tracks?: MpvPlaybackTrack[];
  videoWidth?: number;
  videoHeight?: number;
  diagnostics?: MpvPlaybackDiagnostics;
  error?: string;
};

export type MpvPlaybackDiagnostics = {
  hardwareDecoder?: string;
  hardwareDecode?: boolean;
  frameDrops?: number;
  decoderFrameDrops?: number;
  bufferSeconds?: number;
  buffering?: boolean;
  videoCodec?: string;
  estimatedFps?: number;
};

export type MpvAvailability = {
  available: boolean;
  executablePath?: string;
  runtimeSource?: 'environment' | 'user-selected' | 'bundled' | 'system';
  version?: string;
  warning?: string;
  reason?: string;
};

export type MpvStartOptions = {
  startSeconds?: number;
  volume?: number;
  muted?: boolean;
  speed?: number;
  audioTrackId?: number;
  audioLanguage?: string;
  audioDelay?: number;
  subtitleDelay?: number;
  subtitleStyle?: {
    fontSize: number;
    color: string;
    borderColor: string;
    borderWidth: number;
    backgroundColor: string;
    position: number;
  };
  subtitleFiles?: Array<{ path: string; source: 'sidecar' | 'opensubtitles' }>;
};

export type MpvCommand =
  | { type: 'set-paused'; paused: boolean }
  | { type: 'seek'; position: number }
  | { type: 'set-volume'; volume: number }
  | { type: 'set-muted'; muted: boolean }
  | { type: 'set-speed'; speed: number }
  | { type: 'set-video-track'; trackId: number | null }
  | { type: 'set-audio-track'; trackId: number | null }
  | { type: 'set-subtitle-track'; trackId: number | null }
  | { type: 'set-secondary-subtitle-track'; trackId: number | null }
  | { type: 'set-subtitle-delay'; seconds: number }
  | { type: 'set-audio-delay'; seconds: number }
  | { type: 'set-subtitle-style'; fontSize: number; color: string; borderColor: string; borderWidth: number; backgroundColor: string; position: number }
  | { type: 'set-video-aspect'; aspect: string | null }
  | { type: 'set-video-crop'; crop: string | null }
  | { type: 'set-video-rotation'; degrees: number };

export interface WireMediaItem {
  id: string;
  type: 'movie' | 'tv' | 'anime';
  format?: string;
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
  providerRatings?: LanProviderRatings;
  contentRatings?: Record<string, LanContentRating>;
  contentRating?: string;
  streamingProviders?: LanStreamingProvider[];
  originPlatform?: LanOriginPlatform;
  trailerUrl?: string;
  runtime?: string;
  seasonCount?: number;
  episodeCount?: number;
  genres: string[];
  cast: {
    name: string;
    character: string;
    image: string;
    characterName?: string;
    characterRole?: string;
    characterImage?: string;
    voiceActorName?: string;
    voiceActorImage?: string;
    voiceActorLanguage?: string;
  }[];
  filePath: string;
  fileSize?: number;
  lastPlayed?: number;
  seasons?: { number: number; title: string; episodeCount: number }[];
  episodes?: WireEpisodeMeta[];
  episodeFiles?: WireEpisodeFile[];
  subtitles?: WireSubtitleRecord[];
  localMetadata?: WireLocalMediaDetails;
  providerIds?: {
    tmdbId?: string;
    imdbId?: string;
    tvdbId?: string;
    tvmazeId?: string;
    malId?: string;
    malIdBySeason?: Record<string, string>;
  };
}

export type LibraryCard = LanLibraryCard;
export type StreamingProvider = LanStreamingProvider;
export type OriginPlatform = LanOriginPlatform;
export type LibraryPlaybackReference = LanLibraryPlaybackReference;
export interface LibraryIndexPayload extends LanLibraryIndexPayload<LibraryCard> {
  // Renderer-only configuration data. LAN projections deliberately omit host
  // paths while the local renderer keeps Settings and scan scheduling intact.
  libraryFolders?: string[];
  libraryFolderGroups?: LibraryFolderGroups;
  libraryFolderStatuses?: LibraryFolderStatus[];
}
export type LibraryItemDetailsPayload = LanLibraryItemDetailsPayload<WireMediaItem>;

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
  metadataOfflineMode?: boolean;
  openSubtitlesUsername?: string;
  openSubtitlesPassword?: string;
  openSubtitlesLanguages?: string;
  openSubtitlesAutoDownload?: boolean;
  autoSyncIntervalHours?: number;
  playbackSkipBackSeconds?: number;
  playbackSkipForwardSeconds?: number;
  /** Minutes to keep the display awake during active native playback. Zero means until playback ends. */
  playbackDisplaySleepTimeoutMinutes?: number;
  localSkipAnalysisEnabled?: boolean;
  skipAnalysis?: SkipAnalysisSettings;
  sidebarNavOrder?: string[];
  customFolderNames?: Record<string, string>;
  otherFolderGroups?: Record<string, OtherFolderGroup>;
  otherFolderIcon?: string;
  appThemeMode?: 'dark' | 'light';
  appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue' | 'twitch';
  appDarkTheme?: 'black';
  appLoaderStyle?: 'play-mark' | 'logo-mark' | 'horizontal-logo';
  localNetworkSharingEnabled?: boolean;
  localNetworkRequireApproval?: boolean;
  localNetworkShareToken?: string;
}

export interface OtherFolderGroup {
  name: string;
  icon: string;
  folders: string[];
}

export type SkipAnalysisSegmentType = 'intro' | 'recap' | 'outro' | 'credits' | 'preview';
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
  // 'quick' analyzes only content without up-to-date markers; 'full' (default)
  // re-analyzes everything in scope.
  mode?: 'quick' | 'full';
};

export interface MetadataKeyTestResult { provider: string; ok: boolean; message: string }
export interface PlaybackLogoResult { logo?: string; logoCandidates?: string[] }
export interface FFmpegStatus {
  available: boolean;
  path: string | null;
  capabilities?: TranscodeCapabilities;
}
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
  preset?: 'auto' | 'software' | 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'rkmpp';
  targetVideoCodec?: 'h264' | 'hevc' | 'av1';
  softwareVideoEncoder?: 'libx264' | 'libx265' | 'libsvtav1' | 'libaom-av1';
  maxWidth?: number;
  maxHeight?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  toneMap?: boolean;
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
  preset?: 'software' | 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'rkmpp';
  codec?: 'h264' | 'hevc' | 'av1';
}

export type StreamUrlOptions = LanStreamOptions & Pick<TranscodeOptions,
  | 'videoTrackIndex' | 'secondarySubtitleTrackIndex' | 'secondarySubtitleStreamOrdinal'
  | 'secondarySubtitleCodec' | 'secondarySubtitleFilePath' | 'targetVideoCodec'
  | 'maxWidth' | 'maxHeight' | 'videoBitrateKbps' | 'audioBitrateKbps' | 'toneMap'
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

/**
 * Loopback bootstrap for the renderer: the media-server port plus the local
 * access token that authorizes token-bearing loopback routes.
 *
 * This payload only ever crosses sender-validated Electron IPC. No HTTP route
 * returns it, because HTTP could authenticate the caller only by a header the
 * caller writes.
 */
export interface RendererSession {
  port: number;
  localAccessToken: string;
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
  certFingerprint: string;
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

export interface RemoteLibraryRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
}

export interface RemoteLibraryResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type RemoteLibrarySessionState =
  | { status: 'connected'; connection: RemoteLibraryConnection }
  | { status: 'none' }
  | { status: 'pairing-required'; reason: string };

export type ProfileType = LanProfileType;
export type ProfileSummary = LanProfileSummary;
export type ActiveProfileState = LanActiveProfile;
export type ProfilePreferences = LanProfilePreferences;
export type ProfileRestrictions = LanProfileRestrictions;
export type ProfileListKind = LanProfileListKind;
export type ProfileListEntry = LanProfileListEntry;

export interface ProfilesChangedEvent {
  profiles: ProfileSummary[];
  selectionRevision: number;
}

export interface ProfileCreateInput {
  name: string;
  avatarKey?: string;
  colorKey?: string;
  type?: 'standard' | 'kid';
}

export type ProfileUpdateInput = Partial<ProfileCreateInput>;

export interface UnifiedDesktopServerState {
  enabled: boolean;
  ready: boolean;
  ownerConfigured: boolean;
  adminUrl?: string;
  appUrl?: string;
  error?: string;
}

export interface ProfileExportV1 {
  format: 'loomtv.profile.v1';
  exportedAt: number;
  profile: Pick<ProfileSummary, 'name' | 'avatarKey' | 'colorKey' | 'type'>;
  progress: Record<string, StoredProgress>;
  trackPreferences: Record<string, PlaybackTrackPreferences>;
  preferences: ProfilePreferences;
  restrictions: ProfileRestrictions;
  lists: ProfileListEntry[];
}

export interface ProfileTransferResult {
  ok: boolean;
  path?: string;
  profile?: ProfileSummary;
  importedProgress?: number;
  skippedProgress?: number;
  importedLists?: number;
  skippedLists?: number;
  error?: string;
}

export type StoredProgress = LanStoredProgress;
export interface TrackPreference { enabled: boolean; index?: number; language?: string; title?: string; codec?: string; forced?: boolean }
export interface PlaybackTrackPreferences { audio?: TrackPreference; subtitle?: TrackPreference }
export type MediaSegmentType = 'intro' | 'recap' | 'outro' | 'credits' | 'preview';
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
  runningCount?: number;
  waitingCount?: number;
  manualPendingCount?: number;
  manualRunningCount?: number;
  currentJob?: { jobKey: string; kind: string; mediaId: string; season: number; episode: number; detail: string };
  phaseProgress?: {
    phase: 'fingerprinting' | 'matching';
    completed: number;
    total: number;
    detail: string;
  };
  lastError?: string;
  fingerprintCount?: number;
  fingerprintCacheBytes?: number;
  progress?: { complete: number; total: number };
  library?: { analyzed: number; waiting?: number; total: number };
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
  format?: string;
  thumbnail?: string;
  cover?: string;
  summary?: string;
  rating?: number;
  providerRatings?: LanProviderRatings;
  contentRatings?: Record<string, LanContentRating>;
  episodes?: WireEpisodeMeta[];
  episodeSource?: 'TMDB' | 'OMDb' | 'TVmaze' | 'TVDB' | 'Jikan' | 'AniList' | 'Fanart.tv';
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logoCandidates?: string[];
  logo?: string;
  cast?: Array<{
    name: string;
    character: string;
    image: string;
    characterName?: string;
    characterRole?: string;
    characterImage?: string;
    voiceActorName?: string;
    voiceActorImage?: string;
    voiceActorLanguage?: string;
  }>;
}

export type OfficialArtworkRefreshTarget = 'all' | 'poster' | 'cover' | 'logo';
export type OfficialMetadataApplyTarget = OfficialArtworkRefreshTarget | 'summary' | 'episodes';

export type OfficialMetadataCandidate = OfficialArtworkResult & {
  id: string;
  source: 'TMDB' | 'OMDb' | 'TVmaze' | 'TVDB' | 'Jikan' | 'AniList' | 'Fanart.tv';
  title: string;
  year?: number;
  genres?: string[];
  episodeCount?: number;
  episodePreview?: string[];
};

export type StremioPluginState = 'pending-review' | 'enabled' | 'disabled' | 'broken';

export interface StremioPluginConfigurationField {
  key: string;
  type: 'text' | 'number' | 'password' | 'checkbox' | 'boolean' | 'select' | 'string';
  required: boolean;
  title?: string;
  options?: readonly string[];
}

export interface StremioPluginConfigurationState {
  fields: readonly StremioPluginConfigurationField[];
  configured: boolean;
  configuredFields: readonly string[];
  revision: number;
}

export interface StremioPluginAuditEntry {
  id: number;
  addonId: string;
  eventType: string;
  actor: string;
  priorRevision?: number;
  newRevision?: number;
  outcome: 'success' | 'failure';
  detail: Readonly<Record<string, unknown>>;
  createdAt: number;
}

export interface StremioPluginCatalogExtra {
  name: string;
  isRequired: boolean;
  options?: readonly string[];
  optionsLimit?: number;
}

export interface StremioPluginCatalogDefinition {
  type: string;
  id: string;
  name: string;
  extra: readonly StremioPluginCatalogExtra[];
}

export interface StremioPluginSummary {
  addonId: string;
  name: string;
  version: string;
  description: string;
  manifestOrigin: string;
  manifestUrlRedacted: string;
  state: StremioPluginState;
  trusted: boolean;
  configurationRequired: boolean;
  configuration: readonly StremioPluginConfigurationField[];
  configured: boolean;
  configurationRevision: number;
  resources: readonly string[];
  types: readonly string[];
  catalogs: readonly StremioPluginCatalogDefinition[];
  warnings: readonly string[];
  reviewedAt: number;
  approvedAt?: number;
  failureCount: number;
  lastFailureAt?: number;
  nextRetryAt?: number;
}

export interface StremioPluginReview extends StremioPluginSummary {
  reviewToken: string;
  approvalRequired: true;
}

export interface OfficialStremioAddon {
  id: 'cinemeta' | 'opensubtitles-v3';
  addonId: 'com.linvo.cinemeta' | 'org.stremio.opensubtitlesv3';
  name: string;
  description: string;
  capability: 'catalog' | 'subtitles';
}

export interface StremioPluginCatalogRequest {
  type: string;
  catalogId: string;
  /** Host-side Discover filters; these are never forwarded as provider extras verbatim. */
  filters?: {
    query?: string;
    genre?: string;
    year?: string;
  };
  extra?: Readonly<Record<string, string | number | boolean>>;
}

export interface StremioPluginMetaRequest {
  type: string;
  /** A stable, host-issued item key. Provider IDs never cross this boundary. */
  id: string;
  extra?: Readonly<Record<string, string | number | boolean>>;
}

export interface StremioPluginArtworkReferences {
  /** Host-controlled artwork delivery URLs backed by opaque resource IDs. */
  poster?: string;
  background?: string;
  logo?: string;
}

export interface StremioPluginCastMember {
  name: string;
  character?: string;
  /** Host-controlled artwork delivery URL; upstream cast URLs never cross IPC. */
  image?: string;
  /** Optional paired anime credit fields used by the renderer-owned AniList source. */
  characterName?: string;
  characterRole?: string;
  characterImage?: string;
  voiceActorName?: string;
  voiceActorImage?: string;
  voiceActorLanguage?: string;
}

export interface StremioPluginCatalogItem {
  /** Stable addon/type/provider-namespaced item key. */
  id: string;
  type: string;
  /** Source namespace used for profile-scoped Discover state. */
  source?: string;
  /** TMDB identifier used by providers that require an exact movie or show match. */
  tmdbId?: string;
  format?: string;
  title: string;
  genres: readonly string[];
  artwork?: StremioPluginArtworkReferences;
  /** Renderer-owned provider artwork used by the standalone Explore sources. */
  posterUrl?: string;
  backgroundUrl?: string;
  logoUrl?: string;
  cast?: readonly StremioPluginCastMember[];
  description?: string;
  releaseInfo?: string;
  released?: string;
  rating?: number;
  providerRatings?: LanProviderRatings;
  /** IMDb title ID resolved from TMDB, used for an exact OMDb ratings lookup. */
  imdbId?: string;
  contentRating?: string;
  streamingProviders?: LanStreamingProvider[];
  trailerUrl?: string;
  runtime?: string;
  seasonCount?: number;
  episodeCount?: number;
}

export interface StremioPluginCatalogResult {
  addonId: string;
  type: string;
  catalogId: string;
  items: readonly StremioPluginCatalogItem[];
}

export interface StremioPluginMetaResult {
  addonId: string;
  item: StremioPluginCatalogItem | null;
}

export interface StremioStreamRequest {
  type: string;
  id: string;
  extra?: Readonly<Record<string, string | number | boolean>>;
}

export interface StremioStreamItem {
  url: string;
  title?: string;
  behaviorHints?: Readonly<Record<string, unknown>>;
}

export interface StremioStreamResult {
  addonId: string;
  streams: readonly StremioStreamItem[];
  playableCount: number;
  unsupportedPeerToPeerCount: number;
  rejectedCount: number;
}

export interface StremioPluginIpcIssue {
  path: string;
  code: string;
  message: string;
}

export interface StremioPluginIpcError {
  code: string;
  message: string;
  retryable: boolean;
  issues?: readonly StremioPluginIpcIssue[];
}

export type StremioPluginIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: StremioPluginIpcError };

// ─── Live TV (IPTV) ──────────────────────────────────────────────────────────

export type IptvSourceIconId =
  | 'general'
  | 'entertainment'
  | 'news'
  | 'sports'
  | 'movies'
  | 'series'
  | 'music'
  | 'kids'
  | 'documentary'
  | 'education'
  | 'lifestyle'
  | 'travel'
  | 'cooking'
  | 'science'
  | 'religious'
  | 'weather';

/** One added provider: an M3U playlist plus the XMLTV guide that annotates it. */
export interface IptvSourceSummary {
  id: string;
  name: string;
  iconId: IptvSourceIconId;
  playlistUrl: string;
  epgUrl: string;
  channelCount: number;
  programmeCount: number;
  /** Channels dropped because they stream over plain HTTP. */
  skippedInsecure: number;
  /** Channels dropped as malformed or duplicated. */
  skippedMalformed: number;
  refreshedAt: number;
  refreshError: string;
}

export interface IptvSourceInput {
  playlistUrl: string;
  epgUrl?: string;
  name: string;
  iconId?: IptvSourceIconId;
}

export interface IptvSourcePatch {
  name?: string;
  playlistUrl?: string;
  epgUrl?: string;
  iconId?: IptvSourceIconId;
}

export interface IptvChannelSummary {
  channelId: string;
  name: string;
  logoUrl: string;
  groupTitle: string;
  streamUrl: string;
  /** Empty when the source has no guide coverage for this channel. */
  nowTitle: string;
  nowStartMs: number;
  nowEndMs: number;
  nextTitle: string;
  nextStartMs: number;
}

export type IptvChannelSort = 'name-asc' | 'name-desc' | 'category';
export type IptvGeoFilter = 'all' | 'exclude' | 'only';

export interface IptvChannelRequest {
  sourceId: string;
  query?: string;
  group?: string;
  subcategory?: string;
  geoFilter?: IptvGeoFilter;
  sort?: IptvChannelSort;
  limit?: number;
  offset?: number;
}

export interface IptvChannelPage {
  sourceId: string;
  sourceName: string;
  channels: readonly IptvChannelSummary[];
  /** Matches for the current query, which can exceed the returned page. */
  total: number;
  offset: number;
  groups: readonly { name: string; channelCount: number }[];
  /** Tags that co-occur with the selected group. Empty until a group is selected. */
  subcategories: readonly { name: string; channelCount: number }[];
  refreshedAt: number;
  refreshError: string;
}
