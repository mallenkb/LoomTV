import { contextBridge, ipcRenderer } from 'electron';

type SubtitleStyleOptions = {
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
};

type LibraryPayload = {
  movies: unknown[];
  tvShows: unknown[];
  animeShows?: unknown[];
  libraryFolders: string[];
  libraryFolderGroups?: { movies: string[]; tvShows: string[]; anime: string[]; others: string[] };
};
type LibraryScanMode = 'quick' | 'metadata' | 'full';
type LibraryScanProgress = { isComplete: boolean; scannedFolders: number; totalFolders: number };
type UpdateState = {
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
};

// ─── desktopApi — existing library/media/settings surface ────────────────────

contextBridge.exposeInMainWorld('desktopApi', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  scanLibrary: (options?: { force?: boolean; mode?: LibraryScanMode }) => ipcRenderer.invoke('library:scan', options),
  onLibraryScanProgress: (callback: (library: LibraryPayload, progress: LibraryScanProgress) => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      library: LibraryPayload,
      progress: LibraryScanProgress,
    ) => callback(library, progress);
    ipcRenderer.on('library:scan-progress', handler);
    return () => ipcRenderer.removeListener('library:scan-progress', handler);
  },
  addLibraryFolder: (kind?: 'movies' | 'tvShows' | 'anime' | 'others') => ipcRenderer.invoke('library:add-folder', kind),
  removeLibraryFolder: (folderPath: string) => ipcRenderer.invoke('library:remove-folder', folderPath),
  playMedia: (filePath: string) => ipcRenderer.invoke('media:play', filePath),
  getStreamUrl: (filePath: string, options?: {
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
  }) => ipcRenderer.invoke('media:get-stream-url', filePath, options || {}),
  getSubtitleUrl: (filePath: string, streamOrdinal?: number) => ipcRenderer.invoke('media:get-subtitle-url', filePath, streamOrdinal),
  getThumbnail: (filePath: string, time?: string) => ipcRenderer.invoke('media:get-thumbnail', filePath, time),
  getFileInfo: (filePath: string) => ipcRenderer.invoke('media:get-file-info', filePath),
  getServerBase: () => ipcRenderer.invoke('media:get-server-port').then((port: number) => `http://127.0.0.1:${port}`),
  checkFFmpeg: () => ipcRenderer.invoke('media:ffmpeg-available'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: {
    omdbApiKey?: string;
    tmdbApiKey?: string;
    metadataApiKeys?: Record<string, string>;
    openSubtitlesUsername?: string;
    openSubtitlesPassword?: string;
    openSubtitlesLanguages?: string;
    openSubtitlesAutoDownload?: boolean;
    autoSyncIntervalHours?: number;
    playbackSkipBackSeconds?: number;
    playbackSkipForwardSeconds?: number;
    localSkipAnalysisEnabled?: boolean;
    sidebarNavOrder?: string[];
    appThemeMode?: 'dark' | 'light';
    appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue';
    appDarkTheme?: 'default' | 'justwatch' | 'black';
    appLoaderStyle?: 'play-mark' | 'logo-mark' | 'horizontal-logo';
    localNetworkSharingEnabled?: boolean;
    localNetworkShareToken?: string;
  }) => ipcRenderer.invoke('settings:save', settings),
  testMetadataKeys: (keys: Record<string, string>) => ipcRenderer.invoke('metadata:test-keys', keys),
  getLocalNetworkStatus: () => ipcRenderer.invoke('network:status'),
  discoverLocalNetworkPeers: (timeoutMs?: number) => ipcRenderer.invoke('network:discover-peers', timeoutMs),
  revokePairedDevice: (deviceId: string) => ipcRenderer.invoke('network:revoke-paired-device', deviceId),
  setLocalNetworkDeviceName: (name: string) => ipcRenderer.invoke('network:set-device-name', name),
  getProgress: (filePath?: string) => ipcRenderer.invoke('progress:get', filePath),
  saveProgress: (filePath: string, position: number, duration: number) => ipcRenderer.invoke('progress:save', filePath, position, duration),
  importProgress: (progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>) =>
    ipcRenderer.invoke('progress:import', progress),
  getPlaybackTrackPreferences: (scope?: string) => ipcRenderer.invoke('playback-track-preferences:get', scope),
  savePlaybackTrackPreferences: (scope: string, preferences: unknown) =>
    ipcRenderer.invoke('playback-track-preferences:save', scope, preferences),
  getMediaSegments: (request: { mediaId: string; season?: number; episode?: number }) =>
    ipcRenderer.invoke('playback:segments:get', request),
  saveManualMediaSegment: (input: unknown) => ipcRenderer.invoke('playback:segments:save-manual', input),
  deleteManualMediaSegment: (input: unknown) => ipcRenderer.invoke('playback:segments:delete-manual', input),
  undoManualMediaSegment: (input: unknown) => ipcRenderer.invoke('playback:segments:undo-manual', input),
  setPlaybackActivity: (key: string, active: boolean, label?: string) => ipcRenderer.invoke('playback:activity', key, active, label),
  getLocalSegmentAnalysisStatus: () => ipcRenderer.invoke('playback:analysis:status'),
  analyzeLocalSegmentSeason: (mediaId: string, season: number) => ipcRenderer.invoke('playback:analysis:season', mediaId, season),
  getCustomArtwork: (mediaId: string) => ipcRenderer.invoke('artwork:get', mediaId),
  saveCustomArtwork: (mediaId: string, target: string, dataUrl: string) => ipcRenderer.invoke('artwork:save', mediaId, target, dataUrl),
  getOfficialMetadataCandidates: (mediaId: string) => ipcRenderer.invoke('artwork:official-candidates', mediaId),
  applyOfficialMetadata: (mediaId: string, candidate: unknown) => ipcRenderer.invoke('artwork:apply-official', mediaId, candidate),
  refreshOfficialArtwork: (mediaId: string) => ipcRenderer.invoke('artwork:refresh-official', mediaId),
  getPlaybackLogo: (mediaId: string) => ipcRenderer.invoke('artwork:playback-logo', mediaId),
  importCustomArtwork: (entries: Record<string, Record<string, string>>) => ipcRenderer.invoke('artwork:import', entries),
  backupDatabase: () => ipcRenderer.invoke('database:backup'),
  clearAppData: () => ipcRenderer.invoke('database:clear'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  openFolderPath: async (filePath: string) => {
    try {
      return await ipcRenderer.invoke('shell:open-folder-path', filePath);
    } catch (error) {
      if (error instanceof Error && error.message.includes("No handler registered for 'shell:open-folder-path'")) {
        return ipcRenderer.invoke('shell:show-item', filePath);
      }
      throw error;
    }
  },
  getUpdateState: () => ipcRenderer.invoke('updates:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateState: (callback: (state: UpdateState) => void) => {
    const handler = (_: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on('updates:state', handler);
    return () => ipcRenderer.removeListener('updates:state', handler);
  },

  media: {
    probe: (filePath: string) => ipcRenderer.invoke('media:probe', filePath),
    canDirectPlay: (filePath: string, backend = 'html5') => ipcRenderer.invoke('media:can-direct-play', filePath, backend),
    startTranscode: (filePath: string, options?: {
      preset?: string;
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
    }) =>
      ipcRenderer.invoke('media:start-transcode', filePath, options || {}),
    stopTranscode: (sessionId: string) => ipcRenderer.invoke('media:stop-transcode', sessionId),
  },
});

// ─── playerApi — kept for any future use; VideoPlayer now uses HTML5 <video> ──

// The Window.desktopApi type lives in src/lib/desktopApi.ts as the single
// source of truth for renderer consumers. Preload only writes that surface
// via contextBridge.exposeInMainWorld above.
