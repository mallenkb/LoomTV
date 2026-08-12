export type LanLibraryPayload<TMediaItem> = {
  movies?: TMediaItem[];
  tvShows?: TMediaItem[];
  animeShows?: TMediaItem[];
  /** Items whose source belongs to a user-configured mixed/Others root. */
  others?: TMediaItem[];
};

export type LanCatalogVersion = 1;

export type LanLibraryPlaybackReference = {
  progressKey: string;
  season?: number;
  episode?: number;
  durationSeconds?: number;
};

export type LanLibraryCard = {
  id: string;
  type: 'movie' | 'tv' | 'anime';
  title: string;
  year?: number;
  poster: string;
  backdrop: string;
  logo?: string;
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logoCandidates?: string[];
  summary: string;
  rating: number;
  genres: string[];
  lastPlayed?: number;
  seasons?: Array<{ number: number; title: string; episodeCount: number }>;
  playbackReferences: LanLibraryPlaybackReference[];
};

export type LanLibraryIndexPayload<TCard extends LanLibraryCard = LanLibraryCard> = {
  catalogVersion: LanCatalogVersion;
  revision: number;
  movies: TCard[];
  tvShows: TCard[];
  animeShows: TCard[];
  /** May overlap the typed collections; clients should de-duplicate aggregate views by id. */
  others?: TCard[];
};

export type LanLibraryItemDetailsPayload<TMediaItem> = {
  catalogVersion: LanCatalogVersion;
  revision: number;
  item: TMediaItem;
};

export type LanPairResponse<TLibrary> = {
  deviceId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  /** SHA-256 of the desktop LAN leaf certificate, lowercase hex without separators. */
  certFingerprint: string;
  hostDeviceId?: string;
  hostDeviceName?: string;
  library: TLibrary;
  libraryEtag: string;
};

export type LanPairApprovalRequest = {
  requestId: string;
  requestSecret: string;
  expiresAt: number;
  status: 'pending';
};

export type LanPairApprovalStatus = {
  status: 'pending' | 'denied' | 'expired';
  expiresAt?: number;
};

export type LanStoredProgress = {
  position: number;
  duration: number;
  updatedAt: number;
  watched: boolean;
};

export type LanStreamOptions = {
  forceTranscode?: boolean;
  startSeconds?: number;
  targetVideoCodec?: 'h264' | 'hevc' | 'av1';
  maxWidth?: number;
  maxHeight?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  toneMap?: boolean;
  preset?: 'auto' | 'software' | 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'rkmpp';
  audioTrackIndex?: number;
  subtitleTrackIndex?: number;
  subtitleStreamOrdinal?: number;
  subtitleCodec?: string;
  subtitleFilePath?: string;
  subtitleStyle?: {
    fontSize?: number;
  };
};

export type LanPlaybackCapabilities = {
  containers?: string[];
  videoCodecs?: string[];
  audioCodecs?: string[];
  supportsHls?: boolean;
  supportsHdr?: boolean;
  supportsTextSubtitles?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxVideoBitrateKbps?: number;
};

export type LanPlaybackPlan = {
  mode: 'direct' | 'remux' | 'direct-stream' | 'transcode';
  reason: string;
  sourceAction: 'direct' | 'transcode';
  codec?: string;
  backend?: string;
  facts?: {
    container: string;
    videoCodec: string;
    audioCodec: string;
    width: number;
    height: number;
    bitrate: number;
    hdr: boolean;
  };
};

export type LanPlaybackPlanRequest = {
  mediaId: string;
  capabilities?: LanPlaybackCapabilities;
  selectionRevision?: number;
};

export type LanPlaybackPlanResponse = {
  mediaCoreContractVersion: number;
  capabilities: Required<LanPlaybackCapabilities>;
  plan: LanPlaybackPlan;
  recommendedOptions?: LanStreamOptions;
};

export type LanApiResult<T> = {
  ok: boolean;
  data?: T;
  code?: string;
  error?: string;
  retryable?: boolean;
};

export type LanHlsSession = { playlistUrl: string };

/**
 * Profile selection is mandatory for every network device.
 *
 * A paired device is authorized for exactly the profile it has explicitly
 * selected. The host never picks one on a device's behalf, so a device that has
 * not selected a profile — or whose selected profile was deleted or revoked —
 * gets `409 { error: 'profile_required' }` from every profile-sensitive route
 * (catalog, item, artwork, subtitle, playback, transcode, preferences, lists,
 * progress). The desktop's own local requests continue to use the active
 * desktop profile.
 *
 * `X-Loom-Profile-Api-Version: 1` is representation negotiation only. It never
 * selects an authorization branch, so omitting it cannot obtain a weaker check
 * or wider access than sending it. It stays accepted for clients that send it.
 *
 * Reachable without a selection, so a client can always bootstrap and show its
 * picker: `GET /api/v2/client-config` (no profile-specific preferences until a
 * profile is selected), `GET /api/v2/profiles`, `GET /api/v2/profiles/active`,
 * and `POST /api/v2/profiles/select`. Pairing responses carry an empty library
 * for every client, because a device that just paired has selected nothing yet.
 *
 * Client compatibility: builds that read {@link LanActiveProfile} treat
 * `profileId: null` / `selectionRequired: true` as "show the profile picker",
 * which is the supported path. A build old enough to omit the version header
 * and expect library content from pairing will see `409 profile_required` on
 * its first catalog request instead of Owner-scoped data, and must be updated.
 *
 * Every mutating profile-scoped request carries `selectionRevision`; the host
 * rejects a stale value with `409 { error: 'stale_profile_selection' }`
 * regardless of which headers the client sends.
 */
export type LanProfileType = 'owner' | 'standard' | 'kid' | 'guest';

export type LanProfileSummary = {
  id: string;
  name: string;
  avatarKey: string;
  colorKey: string;
  type: LanProfileType;
  hasPin: boolean;
  isGuest: boolean;
  sortOrder: number;
  lastUsedAt?: number;
};

export type LanActiveProfile = {
  profileId: string | null;
  selectionRequired: boolean;
  selectionRevision: number;
  automaticSignIn: boolean;
};

export type LanProfileSelectionRequest = {
  profileId: string;
  pin?: string;
};

export type LanProfilePreferences = {
  appThemeMode?: 'dark' | 'light';
  appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue' | 'twitch';
  appDarkTheme?: 'black';
  appLoaderStyle?: 'play-mark' | 'logo-mark' | 'horizontal-logo';
  appHomeStyle?: 'default' | 'modern';
  appModernHeroMode?: 'continue-watching' | 'featured';
  sidebarNavOrder?: string[];
  autoplayNextEnabled?: boolean;
  playbackSkipBackSeconds?: number;
  playbackSkipForwardSeconds?: number;
};

export type LanContentRating = {
  code: string;
  minimumAge: number;
  source: 'tmdb' | 'omdb' | 'jikan';
};

export type LanProfileRestrictions = {
  country: 'US' | 'GB' | 'CA' | 'AU';
  maximumAge: number | null;
  allowUnrated: boolean;
  allowedFolders: string[];
  revision: number;
};

export type LanProfileListKind = 'watchlist' | 'favorite';

export type LanProfileListEntry = {
  mediaId: string;
  kind: LanProfileListKind;
  createdAt: number;
};

export type LanClientCapabilities = {
  profiles: boolean;
  profilePins: boolean;
  kidsRestrictions: boolean;
  profilePreferences: boolean;
  profileLists: boolean;
  playbackPlan: boolean;
};

export type LanClientConfig = LanProfilePreferences & {
  profileApiVersion: 1;
  capabilities: LanClientCapabilities;
};
