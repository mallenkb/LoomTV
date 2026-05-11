type LibraryFolderKind = 'movies' | 'tvShows' | 'anime' | 'others';
type LibraryFolderGroups = { movies: string[]; tvShows: string[]; anime: string[]; others: string[] };
type LibraryPayload = {
  movies: any[];
  tvShows: any[];
  animeShows?: any[];
  libraryFolders: string[];
  libraryFolderGroups?: LibraryFolderGroups;
};
type LibraryScanProgress = {
  isComplete: boolean;
  scannedFolders: number;
  totalFolders: number;
};
export type LibraryScanMode = 'quick' | 'metadata' | 'full';
type MetadataApiKeys = Record<string, string>;
type SettingsPayload = {
  omdbApiKey?: string;
  tmdbApiKey?: string;
  metadataApiKeys?: MetadataApiKeys;
  autoSyncIntervalHours?: number;
  sidebarNavOrder?: string[];
  appThemeMode?: 'dark' | 'light';
  appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue';
  appDarkTheme?: 'default' | 'justwatch' | 'black';
  appLoaderStyle?: 'play-mark' | 'logo-mark' | 'horizontal-logo';
  localNetworkSharingEnabled?: boolean;
  localNetworkShareToken?: string;
};
export type UpdateState = {
  status: 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  supported: boolean;
  message?: string;
  checkedAt?: string;
};
type FFmpegStatus = { available: boolean; path: string | null };
type MPVPlayResult = { ok?: boolean; error?: string };
type MPVStatus = {
  position: number | null;
  duration: number | null;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
  speed?: number;
};
type MPVTrackType = 'video' | 'audio' | 'sub';
type MPVAspectMode = 'default' | 'contain' | 'fill' | '4 / 3' | '16 / 9' | '21 / 9';
type ApiResult<T> = { ok: boolean; data?: T; error?: string };
type SubtitleStyleOptions = {
  delaySeconds?: number;
  position?: number;
  scale?: number;
  fontSize?: number;
  fontColor?: string;
  borderColor?: string;
  borderWidth?: number;
  backgroundColor?: string;
};
type PlaybackState = {
  backend: 'mpv' | 'html5' | 'hls';
  filePath?: string;
  state: 'loading' | 'playing' | 'paused' | 'stopped' | 'error';
  positionSeconds?: number | null;
  durationSeconds?: number | null;
  volume?: number | null;
  error?: string;
};
type TranscodeOptions = {
  preset?: 'auto' | 'software' | 'videotoolbox' | 'nvenc' | 'qsv';
  startSeconds?: number;
  videoTrackIndex?: number;
  audioTrackIndex?: number;
  subtitleTrackIndex?: number;
  subtitleStreamOrdinal?: number;
  subtitleCodec?: string;
  secondarySubtitleTrackIndex?: number;
  secondarySubtitleStreamOrdinal?: number;
  secondarySubtitleCodec?: string;
  subtitleStyle?: SubtitleStyleOptions;
  forceTranscode?: boolean;
};
type TranscodeSession = { sessionId: string; filePath: string; playlistUrl: string; outputDir: string };
type StreamUrlOptions = Pick<TranscodeOptions,
  | 'startSeconds'
  | 'videoTrackIndex'
  | 'audioTrackIndex'
  | 'subtitleTrackIndex'
  | 'subtitleStreamOrdinal'
  | 'subtitleCodec'
  | 'secondarySubtitleTrackIndex'
  | 'secondarySubtitleStreamOrdinal'
  | 'secondarySubtitleCodec'
  | 'forceTranscode'
> & { subtitleStyle?: SubtitleStyleOptions };
type StreamUrlResult = { url: string; contentType: string; fileName: string; isTranscoded?: boolean };
export type LocalNetworkStatus = {
  sharingEnabled: boolean;
  token: string;
  networkName: string;
  port: number;
  addresses: string[];
  baseUrl: string | null;
  libraryUrl: string | null;
};
export type RemoteLibraryConnection = {
  baseUrl: string;
  code: string;
  library: LibraryPayload;
};
export type StoredProgress = { position: number; duration: number; updatedAt: number; watched: boolean };
export type OfficialArtworkResult = {
  thumbnail?: string;
  cover?: string;
  summary?: string;
  rating?: number;
  posterCandidates?: string[];
  backdropCandidates?: string[];
};
export type OfficialMetadataCandidate = OfficialArtworkResult & {
  id: string;
  source: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
  title: string;
  year?: number;
  genres?: string[];
};

declare global {
  interface Window {
    desktopApi?: {
      getLibrary: () => Promise<LibraryPayload>;
      scanLibrary: (options?: { force?: boolean; mode?: LibraryScanMode }) => Promise<LibraryPayload>;
      onLibraryScanProgress?: (callback: (library: LibraryPayload, progress: LibraryScanProgress) => void) => () => void;
      addLibraryFolder: (kind?: LibraryFolderKind) => Promise<LibraryPayload | null>;
      removeLibraryFolder: (folderPath: string) => Promise<LibraryPayload>;
      playMedia: (filePath: string) => Promise<boolean>;
      getStreamUrl: (filePath: string, options?: StreamUrlOptions) => Promise<StreamUrlResult>;
      getThumbnail: (filePath: string, time?: string) => Promise<{ url: string }>;
      getFileInfo: (filePath: string) => Promise<{ size: number; path: string; exists: boolean }>;
      getServerBase: () => Promise<string>;
      checkFFmpeg: () => Promise<FFmpegStatus>;
      getSettings: () => Promise<SettingsPayload>;
      saveSettings: (settings: SettingsPayload) => Promise<boolean>;
      getLocalNetworkStatus?: () => Promise<LocalNetworkStatus>;
      getProgress?: (filePath?: string) => Promise<Record<string, StoredProgress> | StoredProgress | null>;
      saveProgress?: (filePath: string, position: number, duration: number) => Promise<StoredProgress>;
      importProgress?: (progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>) => Promise<boolean>;
      getCustomArtwork?: (mediaId: string) => Promise<Record<string, string>>;
      saveCustomArtwork?: (mediaId: string, target: string, dataUrl: string) => Promise<Record<string, string>>;
      getOfficialMetadataCandidates?: (mediaId: string) => Promise<OfficialMetadataCandidate[]>;
      applyOfficialMetadata?: (mediaId: string, candidate: OfficialMetadataCandidate) => Promise<OfficialArtworkResult>;
      refreshOfficialArtwork?: (mediaId: string) => Promise<OfficialArtworkResult>;
      importCustomArtwork?: (entries: Record<string, Record<string, string>>) => Promise<boolean>;
      backupDatabase?: () => Promise<{ ok: boolean; path?: string; error?: string }>;
      clearAppData?: () => Promise<LibraryPayload>;
      openExternal?: (url: string) => Promise<void>;
      getUpdateState?: () => Promise<UpdateState>;
      checkForUpdates?: () => Promise<UpdateState>;
      installUpdate?: () => Promise<UpdateState>;
      onUpdateState?: (callback: (state: UpdateState) => void) => () => void;
      playWithMPV: (filePath: string, startSecs?: number) => Promise<MPVPlayResult>;
      queryMPV: () => Promise<MPVStatus | null>;
      closeMPV: () => Promise<void>;
      toggleMPVPause?: () => Promise<void>;
      seekMPV?: (seconds: number, mode?: 'relative' | 'absolute') => Promise<void>;
      setMPVVolume?: (value: number) => Promise<void>;
      toggleMPVMute?: () => Promise<void>;
      setMPVSpeed?: (value: number) => Promise<void>;
      setMPVFullscreen?: (fullscreen: boolean) => Promise<void>;
      setMPVAspectMode?: (mode: MPVAspectMode) => Promise<void>;
      selectMPVTrack?: (type: MPVTrackType, ffIndex: number) => Promise<void>;
      selectMPVSecondarySubtitleTrack?: (ffIndex: number) => Promise<void>;
      setMPVSubtitleStyle?: (style: SubtitleStyleOptions) => Promise<void>;
      onMPVEvent: (callback: (event: string) => void) => () => void;
      media?: {
        probe: (filePath: string) => Promise<ApiResult<unknown>>;
        canDirectPlay: (filePath: string, backend?: string) => Promise<ApiResult<boolean>>;
        playLocal: (filePath: string) => Promise<ApiResult<PlaybackState>>;
        pause: () => Promise<ApiResult<PlaybackState>>;
        resume: () => Promise<ApiResult<PlaybackState>>;
        stop: () => Promise<ApiResult<PlaybackState>>;
        seek: (seconds: number) => Promise<ApiResult<PlaybackState>>;
        setVolume: (value: number) => Promise<ApiResult<PlaybackState>>;
        getState: () => Promise<ApiResult<PlaybackState>>;
        startTranscode: (filePath: string, options?: TranscodeOptions) => Promise<ApiResult<TranscodeSession>>;
        stopTranscode: (sessionId: string) => Promise<ApiResult<boolean>>;
      };
    };
  }
}

const DEFAULT_MEDIA_PORT = 3847;
let resolvedServerBase: string | null = null;

async function discoverServerBase(): Promise<string> {
  if (resolvedServerBase) return resolvedServerBase;

  const candidatePorts = Array.from({ length: 8 }, (_, index) => DEFAULT_MEDIA_PORT + index);
  for (const port of candidatePorts) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`);
      if (response.ok) {
        resolvedServerBase = `http://127.0.0.1:${port}`;
        return resolvedServerBase;
      }
    } catch (error) {
      // Try the next port; the media server can shift if the default is occupied.
    }
  }

  resolvedServerBase = `http://127.0.0.1:${DEFAULT_MEDIA_PORT}`;
  return resolvedServerBase;
}

async function fetchJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const base = await discoverServerBase();
  const response = await fetch(`${base}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function normalizeLocalNetworkBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter the other device address.');
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withProtocol);
  return parsed.origin;
}

function subnetCandidates(addresses: string[]): string[] {
  const hosts = new Set<string>();
  addresses.forEach((address) => {
    const parts = address.split('.');
    if (parts.length !== 4) return;
    const prefix = parts.slice(0, 3).join('.');
    for (let host = 1; host <= 254; host += 1) {
      const candidate = `${prefix}.${host}`;
      if (candidate !== address) hosts.add(candidate);
    }
  });
  return [...hosts];
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function discoverLocalNetworkLibraryBaseUrl(code: string): Promise<string> {
  const status = await desktopApi.getLocalNetworkStatus();
  const ports = Array.from({ length: 8 }, (_, index) => status.port + index);
  const candidates = subnetCandidates(status.addresses);
  const urls = candidates.flatMap((address) => ports.map((port) => `http://${address}:${port}`));
  const batchSize = 32;

  for (let index = 0; index < urls.length; index += batchSize) {
    const batch = urls.slice(index, index + batchSize);
    const results = await Promise.all(batch.map(async (baseUrl) => {
      try {
        const response = await fetchWithTimeout(`${baseUrl}/api/lan/library?token=${encodeURIComponent(code)}`, 900);
        return response.ok ? baseUrl : null;
      } catch {
        return null;
      }
    }));
    const found = results.find(Boolean);

    if (found) return found;
  }

  throw new Error('No shared LoomTV library was found on this network for that code.');
}

export const desktopApi = {
  async getLibrary(): Promise<LibraryPayload> {
    if (window.desktopApi) return window.desktopApi.getLibrary();
    return fetchJson<LibraryPayload>('/api/library');
  },

  async getStreamUrl(filePath: string, options: StreamUrlOptions = {}): Promise<StreamUrlResult> {
    if (window.desktopApi) {
      return window.desktopApi.getStreamUrl(filePath, options);
    }
    const base = await discoverServerBase();
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const contentTypeMap: Record<string, string> = {
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/mp4', m4v: 'video/mp4',
      mkv: 'video/mp4', avi: 'video/mp4', wmv: 'video/mp4',
    };
    const params = new URLSearchParams({ path: filePath });
    if (options.startSeconds && options.startSeconds > 0) params.set('t', String(Math.floor(options.startSeconds)));
    if (typeof options.videoTrackIndex === 'number') params.set('video', String(options.videoTrackIndex));
    if (typeof options.audioTrackIndex === 'number') params.set('audio', String(options.audioTrackIndex));
    if (typeof options.subtitleTrackIndex === 'number') params.set('subtitle', String(options.subtitleTrackIndex));
    if (typeof options.subtitleStreamOrdinal === 'number') params.set('subtitleOrdinal', String(options.subtitleStreamOrdinal));
    if (options.subtitleCodec) params.set('subtitleCodec', options.subtitleCodec);
    if (typeof options.secondarySubtitleTrackIndex === 'number') params.set('secondarySubtitle', String(options.secondarySubtitleTrackIndex));
    if (typeof options.secondarySubtitleStreamOrdinal === 'number') params.set('secondarySubtitleOrdinal', String(options.secondarySubtitleStreamOrdinal));
    if (options.secondarySubtitleCodec) params.set('secondarySubtitleCodec', options.secondarySubtitleCodec);
    if (options.subtitleStyle) params.set('subtitleStyle', JSON.stringify(options.subtitleStyle));
    if (options.forceTranscode) params.set('forceTranscode', '1');
    return {
      url: `${base}/stream?${params.toString()}`,
      contentType: contentTypeMap[ext] || 'video/mp4',
      fileName: filePath.split('/').pop() || '',
      isTranscoded: options.forceTranscode || ['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', '3gp', 'ts'].includes(ext),
    };
  },

  async getServerBase(): Promise<string> {
    if (window.desktopApi) return window.desktopApi.getServerBase();
    return discoverServerBase();
  },

  async getLocalNetworkStatus(): Promise<LocalNetworkStatus> {
    if (window.desktopApi?.getLocalNetworkStatus) return window.desktopApi.getLocalNetworkStatus();
    return fetchJson<LocalNetworkStatus>('/api/lan/status');
  },

  async connectToLocalNetworkLibrary(baseUrl: string, code: string): Promise<RemoteLibraryConnection> {
    const normalizedCode = code.replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(normalizedCode)) {
      throw new Error('Enter a 6-digit sharing code.');
    }

    const normalizedBaseUrl = baseUrl.trim()
      ? normalizeLocalNetworkBaseUrl(baseUrl)
      : await discoverLocalNetworkLibraryBaseUrl(normalizedCode);
    const response = await fetch(`${normalizedBaseUrl}/api/lan/library?token=${encodeURIComponent(normalizedCode)}`);
    if (!response.ok) {
      throw new Error(response.status === 401 ? 'The sharing code was not accepted.' : 'Could not connect to that LoomTV library.');
    }

    return {
      baseUrl: normalizedBaseUrl,
      code: normalizedCode,
      library: await response.json() as LibraryPayload,
    };
  },

  async getThumbnail(filePath: string, time?: string): Promise<{ url: string }> {
    const base = await discoverServerBase();
    let url = `${base}/api/thumbnail?path=${encodeURIComponent(filePath)}`;
    if (time) url += `&t=${encodeURIComponent(time)}`;
    return { url };
  },

  async scanLibrary(mode: LibraryScanMode = 'quick'): Promise<LibraryPayload> {
    if (window.desktopApi) return window.desktopApi.scanLibrary({ force: mode === 'full', mode });
    return fetchJson<LibraryPayload>('/api/library/scan', {
      method: 'POST',
      body: JSON.stringify({ force: mode === 'full', mode }),
    });
  },

  onLibraryScanProgress(callback: (library: LibraryPayload, progress: LibraryScanProgress) => void): () => void {
    return window.desktopApi?.onLibraryScanProgress?.(callback) || (() => undefined);
  },

  async addLibraryFolder(kind: LibraryFolderKind = 'movies'): Promise<LibraryPayload | null> {
    if (window.desktopApi) return window.desktopApi.addLibraryFolder(kind);
    return fetchJson<LibraryPayload | null>('/api/library/add-folder', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    });
  },

  async removeLibraryFolder(folderPath: string): Promise<LibraryPayload> {
    if (window.desktopApi) return window.desktopApi.removeLibraryFolder(folderPath);
    return fetchJson<LibraryPayload>('/api/library/remove-folder', {
      method: 'POST',
      body: JSON.stringify({ folderPath }),
    });
  },

  async getMediaServerPort(): Promise<number> {
    if (window.desktopApi) {
      const base = await window.desktopApi.getServerBase();
      const parsed = new URL(base);
      return Number(parsed.port || DEFAULT_MEDIA_PORT);
    }
    const response = await fetchJson<{ port: number }>('/api/media-server-port');
    return response.port;
  },

  async checkFFmpeg(): Promise<FFmpegStatus> {
    if (window.desktopApi) return window.desktopApi.checkFFmpeg();
    return fetchJson<FFmpegStatus>('/api/ffmpeg');
  },

  async getSettings(): Promise<SettingsPayload> {
    if (window.desktopApi) return window.desktopApi.getSettings();
    return fetchJson<SettingsPayload>('/api/settings');
  },

  async saveSettings(settings: SettingsPayload): Promise<boolean> {
    if (window.desktopApi) return window.desktopApi.saveSettings(settings);
    const response = await fetchJson<{ ok: boolean }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
    return response.ok;
  },

  async getProgress(filePath?: string): Promise<Record<string, StoredProgress> | StoredProgress | null> {
    if (window.desktopApi?.getProgress) return window.desktopApi.getProgress(filePath);
    const query = filePath ? `?filePath=${encodeURIComponent(filePath)}` : '';
    return fetchJson<Record<string, StoredProgress> | StoredProgress | null>(`/api/progress${query}`);
  },

  async saveProgress(filePath: string, position: number, duration: number): Promise<StoredProgress> {
    if (window.desktopApi?.saveProgress) return window.desktopApi.saveProgress(filePath, position, duration);
    return fetchJson<StoredProgress>('/api/progress', {
      method: 'POST',
      body: JSON.stringify({ filePath, position, duration }),
    });
  },

  async importProgress(progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>): Promise<boolean> {
    if (window.desktopApi?.importProgress) return window.desktopApi.importProgress(progress);
    const response = await fetchJson<{ ok: boolean }>('/api/progress/import', {
      method: 'POST',
      body: JSON.stringify({ progress }),
    });
    return response.ok;
  },

  async getCustomArtwork(mediaId: string): Promise<Record<string, string>> {
    if (window.desktopApi?.getCustomArtwork) return window.desktopApi.getCustomArtwork(mediaId);
    return fetchJson<Record<string, string>>(`/api/artwork?mediaId=${encodeURIComponent(mediaId)}`);
  },

  async saveCustomArtwork(mediaId: string, target: string, dataUrl: string): Promise<Record<string, string>> {
    if (window.desktopApi?.saveCustomArtwork) return window.desktopApi.saveCustomArtwork(mediaId, target, dataUrl);
    return fetchJson<Record<string, string>>('/api/artwork', {
      method: 'POST',
      body: JSON.stringify({ mediaId, target, dataUrl }),
    });
  },

  async refreshOfficialArtwork(mediaId: string): Promise<OfficialArtworkResult> {
    if (window.desktopApi?.refreshOfficialArtwork) return window.desktopApi.refreshOfficialArtwork(mediaId);
    return fetchJson<OfficialArtworkResult>('/api/artwork/refresh-official', {
      method: 'POST',
      body: JSON.stringify({ mediaId }),
    });
  },

  async getOfficialMetadataCandidates(mediaId: string): Promise<OfficialMetadataCandidate[]> {
    if (window.desktopApi?.getOfficialMetadataCandidates) return window.desktopApi.getOfficialMetadataCandidates(mediaId);
    return fetchJson<OfficialMetadataCandidate[]>('/api/artwork/official-candidates', {
      method: 'POST',
      body: JSON.stringify({ mediaId }),
    });
  },

  async applyOfficialMetadata(mediaId: string, candidate: OfficialMetadataCandidate): Promise<OfficialArtworkResult> {
    if (window.desktopApi?.applyOfficialMetadata) return window.desktopApi.applyOfficialMetadata(mediaId, candidate);
    return fetchJson<OfficialArtworkResult>('/api/artwork/apply-official', {
      method: 'POST',
      body: JSON.stringify({ mediaId, candidate }),
    });
  },

  async importCustomArtwork(entries: Record<string, Record<string, string>>): Promise<boolean> {
    if (window.desktopApi?.importCustomArtwork) return window.desktopApi.importCustomArtwork(entries);
    const response = await fetchJson<{ ok: boolean }>('/api/artwork/import', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    });
    return response.ok;
  },

  async backupDatabase(): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (window.desktopApi?.backupDatabase) return window.desktopApi.backupDatabase();
    return fetchJson<{ ok: boolean; path?: string; error?: string }>('/api/database/backup', { method: 'POST' });
  },

  async clearAppData(): Promise<LibraryPayload> {
    if (window.desktopApi?.clearAppData) return window.desktopApi.clearAppData();
    return fetchJson<LibraryPayload>('/api/database/clear', { method: 'POST' });
  },

  openExternal(url: string): void {
    if (window.desktopApi?.openExternal) {
      void window.desktopApi.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  },

  async getUpdateState(): Promise<UpdateState> {
    if (window.desktopApi?.getUpdateState) return window.desktopApi.getUpdateState();
    return {
      status: 'disabled',
      currentVersion: 'dev',
      platform: 'browser' as NodeJS.Platform,
      arch: 'unknown',
      supported: false,
      message: 'Automatic updates are only available in the desktop app.',
    };
  },

  async checkForUpdates(): Promise<UpdateState> {
    if (window.desktopApi?.checkForUpdates) return window.desktopApi.checkForUpdates();
    return this.getUpdateState();
  },

  async installUpdate(): Promise<UpdateState> {
    if (window.desktopApi?.installUpdate) return window.desktopApi.installUpdate();
    return this.getUpdateState();
  },

  onUpdateState(callback: (state: UpdateState) => void): () => void {
    if (window.desktopApi?.onUpdateState) return window.desktopApi.onUpdateState(callback);
    return () => undefined;
  },

  async playMedia(filePath: string): Promise<boolean> {
    if (window.desktopApi) return window.desktopApi.playMedia(filePath);
    const response = await fetchJson<{ ok: boolean }>('/api/play-media', {
      method: 'POST',
      body: JSON.stringify({ filePath }),
    });
    return response.ok;
  },

  async playWithMPV(filePath: string, startSecs?: number): Promise<MPVPlayResult> {
    if (window.desktopApi) return window.desktopApi.playWithMPV(filePath, startSecs);
    return { error: 'not_electron' };
  },

  async queryMPV(): Promise<MPVStatus | null> {
    if (window.desktopApi) return window.desktopApi.queryMPV();
    return null;
  },

  async closeMPV(): Promise<void> {
    if (window.desktopApi) return window.desktopApi.closeMPV();
  },

  async toggleMPVPause(): Promise<void> {
    if (window.desktopApi?.toggleMPVPause) return window.desktopApi.toggleMPVPause();
  },

  async seekMPV(seconds: number, mode: 'relative' | 'absolute' = 'relative'): Promise<void> {
    if (window.desktopApi?.seekMPV) return window.desktopApi.seekMPV(seconds, mode);
  },

  async setMPVVolume(value: number): Promise<void> {
    if (window.desktopApi?.setMPVVolume) return window.desktopApi.setMPVVolume(value);
  },

  async toggleMPVMute(): Promise<void> {
    if (window.desktopApi?.toggleMPVMute) return window.desktopApi.toggleMPVMute();
  },

  async setMPVSpeed(value: number): Promise<void> {
    if (window.desktopApi?.setMPVSpeed) return window.desktopApi.setMPVSpeed(value);
  },

  async setMPVFullscreen(fullscreen: boolean): Promise<void> {
    if (window.desktopApi?.setMPVFullscreen) return window.desktopApi.setMPVFullscreen(fullscreen);
  },

  async setMPVAspectMode(mode: MPVAspectMode): Promise<void> {
    if (window.desktopApi?.setMPVAspectMode) return window.desktopApi.setMPVAspectMode(mode);
  },

  async selectMPVTrack(type: MPVTrackType, ffIndex: number): Promise<void> {
    if (window.desktopApi?.selectMPVTrack) return window.desktopApi.selectMPVTrack(type, ffIndex);
  },

  async selectMPVSecondarySubtitleTrack(ffIndex: number): Promise<void> {
    if (window.desktopApi?.selectMPVSecondarySubtitleTrack) return window.desktopApi.selectMPVSecondarySubtitleTrack(ffIndex);
  },

  async setMPVSubtitleStyle(style: SubtitleStyleOptions): Promise<void> {
    if (window.desktopApi?.setMPVSubtitleStyle) return window.desktopApi.setMPVSubtitleStyle(style);
  },

  onMPVEvent(callback: (event: string) => void): () => void {
    if (window.desktopApi) return window.desktopApi.onMPVEvent(callback);
    return () => undefined;
  },

  media: {
    async probe(filePath: string): Promise<ApiResult<unknown>> {
      if (window.desktopApi?.media) return window.desktopApi.media.probe(filePath);
      return fetchJson<ApiResult<unknown>>('/api/media/probe', {
        method: 'POST',
        body: JSON.stringify({ filePath }),
      });
    },

    async canDirectPlay(filePath: string, backend = 'mpv'): Promise<ApiResult<boolean>> {
      if (window.desktopApi?.media) return window.desktopApi.media.canDirectPlay(filePath, backend);
      const probeResult = await this.probe(filePath);
      return probeResult.ok ? { ok: true, data: backend === 'mpv' } : { ok: false, error: probeResult.error };
    },

    async playLocal(filePath: string): Promise<ApiResult<PlaybackState>> {
      if (window.desktopApi?.media) return window.desktopApi.media.playLocal(filePath);
      return { ok: false, error: 'Native local playback is only available inside Electron.' };
    },

    async pause(): Promise<ApiResult<PlaybackState>> {
      if (window.desktopApi?.media) return window.desktopApi.media.pause();
      return { ok: false, error: 'Native local playback is only available inside Electron.' };
    },

    async resume(): Promise<ApiResult<PlaybackState>> {
      if (window.desktopApi?.media) return window.desktopApi.media.resume();
      return { ok: false, error: 'Native local playback is only available inside Electron.' };
    },

    async stop(): Promise<ApiResult<PlaybackState>> {
      if (window.desktopApi?.media) return window.desktopApi.media.stop();
      return { ok: true, data: { backend: 'html5', state: 'stopped' } as PlaybackState };
    },

    async seek(seconds: number): Promise<ApiResult<PlaybackState>> {
      if (window.desktopApi?.media) return window.desktopApi.media.seek(seconds);
      return { ok: false, error: 'Native local playback is only available inside Electron.' };
    },

    async setVolume(value: number): Promise<ApiResult<PlaybackState>> {
      if (window.desktopApi?.media) return window.desktopApi.media.setVolume(value);
      return { ok: false, error: 'Native local playback is only available inside Electron.' };
    },

    async getState(): Promise<ApiResult<PlaybackState>> {
      if (window.desktopApi?.media) return window.desktopApi.media.getState();
      return { ok: true, data: { backend: 'html5', state: 'stopped' } as PlaybackState };
    },

    async startTranscode(filePath: string, options?: TranscodeOptions): Promise<ApiResult<TranscodeSession>> {
      if (window.desktopApi?.media) return window.desktopApi.media.startTranscode(filePath, options);
      return fetchJson<ApiResult<TranscodeSession>>('/api/media/start-transcode', {
        method: 'POST',
        body: JSON.stringify({ filePath, options }),
      });
    },

    async stopTranscode(sessionId: string): Promise<ApiResult<boolean>> {
      if (window.desktopApi?.media) return window.desktopApi.media.stopTranscode(sessionId);
      return fetchJson<ApiResult<boolean>>('/api/media/stop-transcode', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      });
    },
  },
};
