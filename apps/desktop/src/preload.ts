import { contextBridge, ipcRenderer as electronIpcRenderer } from 'electron';
import type {
  DesktopBridgeApi,
} from './lib/desktopApi';
import type {
  LibraryPayload,
  LibraryScanMode,
  LibraryScanProgress,
  ManualMediaSegmentInput,
  MediaSegmentRequest,
  MediaSegmentType,
  OfficialMetadataCandidate,
  PlaybackTrackPreferences,
  SubtitleStyleOptions,
  TranscodeOptions,
  UpdateState,
} from './shared/desktopProtocol.ts';
import type { IpcEventChannel, IpcInvokeChannel } from './shared/ipcChannels';
import type { IpcContract, IpcEventContract } from './shared/ipcContract';

const ipcRenderer = {
  invoke<C extends IpcInvokeChannel>(channel: C, ...args: IpcContract[C]['args']): Promise<IpcContract[C]['result']> {
    return electronIpcRenderer.invoke(channel, ...args) as Promise<IpcContract[C]['result']>;
  },
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (event: Electron.IpcRendererEvent, ...args: IpcEventContract[C]['args']) => void,
  ): void {
    electronIpcRenderer.on(channel, listener as Parameters<typeof electronIpcRenderer.on>[1]);
  },
  removeListener<C extends IpcEventChannel>(
    channel: C,
    listener: (event: Electron.IpcRendererEvent, ...args: IpcEventContract[C]['args']) => void,
  ): void {
    electronIpcRenderer.removeListener(channel, listener as Parameters<typeof electronIpcRenderer.removeListener>[1]);
  },
};

// ─── desktopApi — existing library/media/settings surface ────────────────────

const desktopApi = {
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
  getServerBase: () => ipcRenderer.invoke('media:get-server-port').then((port) => `http://127.0.0.1:${port}`),
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
    appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue' | 'twitch';
    appDarkTheme?: 'black';
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
  savePlaybackTrackPreferences: (scope: string, preferences: PlaybackTrackPreferences) =>
    ipcRenderer.invoke('playback-track-preferences:save', scope, preferences),
  getMediaSegments: (request: { mediaId: string; season?: number; episode?: number }) =>
    ipcRenderer.invoke('playback:segments:get', request),
  saveManualMediaSegment: (input: ManualMediaSegmentInput) => ipcRenderer.invoke('playback:segments:save-manual', input),
  deleteManualMediaSegment: (input: MediaSegmentRequest & { candidateId?: string; type: MediaSegmentType }) => ipcRenderer.invoke('playback:segments:delete-manual', input),
  undoManualMediaSegment: (input: MediaSegmentRequest & { candidateId?: string; type: MediaSegmentType }) => ipcRenderer.invoke('playback:segments:undo-manual', input),
  getManagedMediaSegments: (request) => ipcRenderer.invoke('playback:segments:manage-list', request),
  updateManagedMediaSegment: (candidateId, patch) => ipcRenderer.invoke('playback:segments:manage-update', candidateId, patch),
  eraseManagedMediaSegments: (request) => ipcRenderer.invoke('playback:segments:manage-erase', request),
  setPlaybackActivity: (key: string, active: boolean, label?: string) => ipcRenderer.invoke('playback:activity', key, active, label),
  getLocalSegmentAnalysisStatus: () => ipcRenderer.invoke('playback:analysis:status'),
  analyzeLocalSegmentSeason: (mediaId: string, season: number) => ipcRenderer.invoke('playback:analysis:season', mediaId, season),
  runLocalSegmentAnalysis: (scope) => ipcRenderer.invoke('playback:analysis:run', scope),
  cancelLocalSegmentAnalysis: (request?: { jobKey?: string; kind?: 'manual' }) => ipcRenderer.invoke('playback:analysis:cancel', request),
  pauseLocalSegmentAnalysis: () => ipcRenderer.invoke('playback:analysis:pause'),
  resumeLocalSegmentAnalysis: () => ipcRenderer.invoke('playback:analysis:resume'),
  cleanupLocalSegmentAnalysis: () => ipcRenderer.invoke('playback:analysis:cleanup'),
  rebuildLocalSegmentAnalysis: () => ipcRenderer.invoke('playback:analysis:rebuild'),
  getCustomArtwork: (mediaId: string) => ipcRenderer.invoke('artwork:get', mediaId),
  saveCustomArtwork: (mediaId: string, target: string, dataUrl: string) => ipcRenderer.invoke('artwork:save', mediaId, target, dataUrl),
  getOfficialMetadataCandidates: (mediaId: string) => ipcRenderer.invoke('artwork:official-candidates', mediaId),
  applyOfficialMetadata: (mediaId: string, candidate: OfficialMetadataCandidate) => ipcRenderer.invoke('artwork:apply-official', mediaId, candidate),
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
    canDirectPlay: (filePath: string, backend: 'html5' | 'hls' = 'html5') => ipcRenderer.invoke('media:can-direct-play', filePath, backend),
    startTranscode: (filePath: string, options?: TranscodeOptions) =>
      ipcRenderer.invoke('media:start-transcode', filePath, options || {}),
    stopTranscode: (sessionId: string) => ipcRenderer.invoke('media:stop-transcode', sessionId),
  },
} satisfies DesktopBridgeApi;

contextBridge.exposeInMainWorld('desktopApi', desktopApi);

// ─── playerApi — kept for any future use; VideoPlayer now uses HTML5 <video> ──

// The bridge implementation is compile-time checked against DesktopBridgeApi.
