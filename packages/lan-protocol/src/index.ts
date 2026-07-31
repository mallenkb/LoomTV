export type LanLibraryPayload<TMediaItem> = {
  movies?: TMediaItem[];
  tvShows?: TMediaItem[];
  animeShows?: TMediaItem[];
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
};

export type LanLibraryItemDetailsPayload<TMediaItem> = {
  catalogVersion: LanCatalogVersion;
  revision: number;
  item: TMediaItem;
};

export type LanPairResponse<TLibrary> = {
  deviceId: string;
  certFingerprint: string;
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

export type LanStoredProgress = {
  position: number;
  duration: number;
  updatedAt: number;
  watched: boolean;
};

export type LanStreamOptions = {
  forceTranscode?: boolean;
  startSeconds?: number;
  audioTrackIndex?: number;
  subtitleTrackIndex?: number;
  subtitleStreamOrdinal?: number;
  subtitleCodec?: string;
  subtitleFilePath?: string;
  subtitleStyle?: {
    fontSize?: number;
  };
};

export type LanApiResult<T> = {
  ok: boolean;
  data?: T;
  code?: string;
  error?: string;
  retryable?: boolean;
};

export type LanHlsSession = { playlistUrl: string };

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
};

export type LanClientConfig = LanProfilePreferences & {
  profileApiVersion: 1;
  capabilities: LanClientCapabilities;
};
