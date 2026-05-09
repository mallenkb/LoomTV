type LibraryPayload = { movies: any[]; tvShows: any[]; animeShows?: any[]; libraryFolders: string[] };
type MetadataApiKeys = Record<string, string>;
type SettingsPayload = {
  omdbApiKey?: string;
  tmdbApiKey?: string;
  metadataApiKeys?: MetadataApiKeys;
};
type FFmpegStatus = { available: boolean; path: string | null };
type MPVPlayResult = { ok?: boolean; error?: string };
type MPVStatus = { position: number | null; duration: number | null };
type ApiResult<T> = { ok: boolean; data?: T; error?: string };
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
};
type TranscodeSession = { sessionId: string; filePath: string; playlistUrl: string; outputDir: string };

declare global {
  interface Window {
    desktopApi?: {
      getLibrary: () => Promise<LibraryPayload>;
      scanLibrary: () => Promise<LibraryPayload>;
      addLibraryFolder: () => Promise<LibraryPayload | null>;
      removeLibraryFolder: (folderPath: string) => Promise<LibraryPayload>;
      playMedia: (filePath: string) => Promise<boolean>;
      getStreamUrl: (filePath: string) => Promise<{ url: string; contentType: string; fileName: string }>;
      getThumbnail: (filePath: string, time?: string) => Promise<{ url: string }>;
      getFileInfo: (filePath: string) => Promise<{ size: number; path: string; exists: boolean }>;
      getServerBase: () => Promise<string>;
      checkFFmpeg: () => Promise<FFmpegStatus>;
      getSettings: () => Promise<SettingsPayload>;
      saveSettings: (settings: SettingsPayload) => Promise<boolean>;
      playWithMPV: (filePath: string, startSecs?: number) => Promise<MPVPlayResult>;
      queryMPV: () => Promise<MPVStatus | null>;
      closeMPV: () => Promise<void>;
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

export const desktopApi = {
  async getLibrary(): Promise<LibraryPayload> {
    if (window.desktopApi) return window.desktopApi.getLibrary();
    return fetchJson<LibraryPayload>('/api/library');
  },

  async getStreamUrl(filePath: string): Promise<{ url: string; contentType: string; fileName: string }> {
    if (window.desktopApi) {
      return window.desktopApi.getStreamUrl(filePath);
    }
    const base = await discoverServerBase();
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const contentTypeMap: Record<string, string> = {
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/mp4', m4v: 'video/mp4',
      mkv: 'video/mp4', avi: 'video/mp4', wmv: 'video/mp4',
    };
    return {
      url: `${base}/stream?path=${encodeURIComponent(filePath)}`,
      contentType: contentTypeMap[ext] || 'video/mp4',
      fileName: filePath.split('/').pop() || '',
    };
  },

  async getServerBase(): Promise<string> {
    if (window.desktopApi) return window.desktopApi.getServerBase();
    return discoverServerBase();
  },

  async getThumbnail(filePath: string, time?: string): Promise<{ url: string }> {
    const base = await discoverServerBase();
    let url = `${base}/api/thumbnail?path=${encodeURIComponent(filePath)}`;
    if (time) url += `&t=${encodeURIComponent(time)}`;
    return { url };
  },

  async scanLibrary(): Promise<LibraryPayload> {
    if (window.desktopApi) return window.desktopApi.scanLibrary();
    return fetchJson<LibraryPayload>('/api/library/scan', { method: 'POST' });
  },

  async addLibraryFolder(): Promise<LibraryPayload | null> {
    if (window.desktopApi) return window.desktopApi.addLibraryFolder();
    return fetchJson<LibraryPayload | null>('/api/library/add-folder', { method: 'POST' });
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
