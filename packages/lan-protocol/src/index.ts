export type LanLibraryPayload<TMediaItem> = {
  movies?: TMediaItem[];
  tvShows?: TMediaItem[];
  animeShows?: TMediaItem[];
};

export type LanPairResponse<TLibrary> = {
  deviceId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
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
};

export type LanApiResult<T> = {
  ok: boolean;
  data?: T;
  code?: string;
  error?: string;
  retryable?: boolean;
};

export type LanHlsSession = { playlistUrl: string };
