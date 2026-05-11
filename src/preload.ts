import { contextBridge, ipcRenderer } from 'electron';

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

type LibraryPayload = {
  movies: unknown[];
  tvShows: unknown[];
  animeShows?: unknown[];
  libraryFolders: string[];
  libraryFolderGroups?: { movies: string[]; tvShows: string[]; anime: string[] };
};
type LibraryScanMode = 'quick' | 'metadata' | 'full';
type LibraryScanProgress = { isComplete: boolean; scannedFolders: number; totalFolders: number };
type UpdateState = {
  status: 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  supported: boolean;
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
  addLibraryFolder: (kind?: 'movies' | 'tvShows' | 'anime') => ipcRenderer.invoke('library:add-folder', kind),
  removeLibraryFolder: (folderPath: string) => ipcRenderer.invoke('library:remove-folder', folderPath),
  playMedia: (filePath: string) => ipcRenderer.invoke('media:play', filePath),
  getStreamUrl: (filePath: string, options?: {
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
  }) => ipcRenderer.invoke('media:get-stream-url', filePath, options || {}),
  getThumbnail: (filePath: string, time?: string) => ipcRenderer.invoke('media:get-thumbnail', filePath, time),
  getFileInfo: (filePath: string) => ipcRenderer.invoke('media:get-file-info', filePath),
  getServerBase: () => ipcRenderer.invoke('media:get-server-port').then((port: number) => `http://127.0.0.1:${port}`),
  checkFFmpeg: () => ipcRenderer.invoke('media:ffmpeg-available'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: {
    omdbApiKey?: string;
    tmdbApiKey?: string;
    metadataApiKeys?: Record<string, string>;
    autoSyncIntervalHours?: number;
    sidebarNavOrder?: string[];
    appThemeMode?: 'dark' | 'light';
    appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue';
    appDarkTheme?: 'default' | 'justwatch' | 'black';
    appLoaderStyle?: 'play-mark' | 'logo-mark' | 'horizontal-logo';
    localNetworkSharingEnabled?: boolean;
    localNetworkShareToken?: string;
  }) => ipcRenderer.invoke('settings:save', settings),
  getLocalNetworkStatus: () => ipcRenderer.invoke('network:status'),
  getProgress: (filePath?: string) => ipcRenderer.invoke('progress:get', filePath),
  saveProgress: (filePath: string, position: number, duration: number) => ipcRenderer.invoke('progress:save', filePath, position, duration),
  importProgress: (progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>) =>
    ipcRenderer.invoke('progress:import', progress),
  getCustomArtwork: (mediaId: string) => ipcRenderer.invoke('artwork:get', mediaId),
  saveCustomArtwork: (mediaId: string, target: string, dataUrl: string) => ipcRenderer.invoke('artwork:save', mediaId, target, dataUrl),
  getOfficialMetadataCandidates: (mediaId: string) => ipcRenderer.invoke('artwork:official-candidates', mediaId),
  applyOfficialMetadata: (mediaId: string, candidate: unknown) => ipcRenderer.invoke('artwork:apply-official', mediaId, candidate),
  refreshOfficialArtwork: (mediaId: string) => ipcRenderer.invoke('artwork:refresh-official', mediaId),
  importCustomArtwork: (entries: Record<string, Record<string, string>>) => ipcRenderer.invoke('artwork:import', entries),
  backupDatabase: () => ipcRenderer.invoke('database:backup'),
  clearAppData: () => ipcRenderer.invoke('database:clear'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  getUpdateState: () => ipcRenderer.invoke('updates:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateState: (callback: (state: UpdateState) => void) => {
    const handler = (_: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on('updates:state', handler);
    return () => ipcRenderer.removeListener('updates:state', handler);
  },

  // Legacy MPV handlers (still used by existing VideoPlayer)
  playWithMPV: (filePath: string, startSecs?: number) => ipcRenderer.invoke('media:play-mpv', filePath, startSecs),
  queryMPV: () => ipcRenderer.invoke('media:query-mpv'),
  closeMPV: () => ipcRenderer.invoke('media:close-mpv'),
  toggleMPVPause: () => ipcRenderer.invoke('media:mpv-toggle-pause'),
  seekMPV: (seconds: number, mode: 'relative' | 'absolute' = 'relative') => ipcRenderer.invoke('media:mpv-seek', seconds, mode),
  setMPVVolume: (value: number) => ipcRenderer.invoke('media:mpv-set-volume', value),
  toggleMPVMute: () => ipcRenderer.invoke('media:mpv-toggle-mute'),
  setMPVSpeed: (value: number) => ipcRenderer.invoke('media:mpv-set-speed', value),
  setMPVFullscreen: (fullscreen: boolean) => ipcRenderer.invoke('media:mpv-set-fullscreen', fullscreen),
  setMPVAspectMode: (mode: 'default' | 'contain' | 'fill' | '4 / 3' | '16 / 9' | '21 / 9') =>
    ipcRenderer.invoke('media:mpv-set-aspect-mode', mode),
  selectMPVTrack: (type: 'video' | 'audio' | 'sub', ffIndex: number) =>
    ipcRenderer.invoke('media:mpv-select-track', type, ffIndex),
  selectMPVSecondarySubtitleTrack: (ffIndex: number) =>
    ipcRenderer.invoke('media:mpv-select-secondary-subtitle-track', ffIndex),
  setMPVSubtitleStyle: (style: SubtitleStyleOptions) =>
    ipcRenderer.invoke('media:mpv-set-subtitle-style', style),
  cycleMPVAudio: () => ipcRenderer.invoke('media:mpv-cycle-audio'),
  cycleMPVSubtitle: () => ipcRenderer.invoke('media:mpv-cycle-subtitle'),
  disableMPVSubtitles: () => ipcRenderer.invoke('media:mpv-disable-subtitles'),
  onMPVEvent: (callback: (event: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: string) => callback(event);
    ipcRenderer.on('mpv:event', handler);
    return () => ipcRenderer.removeListener('mpv:event', handler);
  },

  media: {
    probe: (filePath: string) => ipcRenderer.invoke('media:probe', filePath),
    canDirectPlay: (filePath: string, backend = 'mpv') => ipcRenderer.invoke('media:can-direct-play', filePath, backend),
    playLocal: (filePath: string) => ipcRenderer.invoke('media:play-local', filePath),
    pause: () => ipcRenderer.invoke('media:pause-local'),
    resume: () => ipcRenderer.invoke('media:resume-local'),
    stop: () => ipcRenderer.invoke('media:stop-local'),
    seek: (seconds: number) => ipcRenderer.invoke('media:seek-local', seconds),
    setVolume: (value: number) => ipcRenderer.invoke('media:set-volume-local', value),
    getState: () => ipcRenderer.invoke('media:get-playback-state'),
    startTranscode: (filePath: string, options?: {
      preset?: string;
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
    }) =>
      ipcRenderer.invoke('media:start-transcode', filePath, options || {}),
    stopTranscode: (sessionId: string) => ipcRenderer.invoke('media:stop-transcode', sessionId),
  },
});

// ─── playerApi — kept for any future use; VideoPlayer now uses HTML5 <video> ──

// ─── TypeScript declarations ──────────────────────────────────────────────────

declare global {
  interface Window {
    desktopApi: {
      getLibrary: () => Promise<{ movies: any[]; tvShows: any[]; animeShows?: any[]; libraryFolders: string[]; libraryFolderGroups?: { movies: string[]; tvShows: string[]; anime: string[] } }>;
      scanLibrary: (options?: { force?: boolean; mode?: LibraryScanMode }) => Promise<{ movies: any[]; tvShows: any[]; animeShows?: any[]; libraryFolders: string[]; libraryFolderGroups?: { movies: string[]; tvShows: string[]; anime: string[] } }>;
      onLibraryScanProgress?: (callback: (library: LibraryPayload, progress: LibraryScanProgress) => void) => () => void;
      addLibraryFolder: (kind?: 'movies' | 'tvShows' | 'anime') => Promise<{ movies: any[]; tvShows: any[]; animeShows?: any[]; libraryFolders: string[]; libraryFolderGroups?: { movies: string[]; tvShows: string[]; anime: string[] } } | null>;
      removeLibraryFolder: (folderPath: string) => Promise<{ movies: any[]; tvShows: any[]; animeShows?: any[]; libraryFolders: string[]; libraryFolderGroups?: { movies: string[]; tvShows: string[]; anime: string[] } }>;
      playMedia: (filePath: string) => Promise<boolean>;
      getStreamUrl: (filePath: string, options?: {
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
      }) => Promise<{ url: string; contentType: string; fileName: string; isTranscoded?: boolean }>;
      getThumbnail: (filePath: string, time?: string) => Promise<{ url: string }>;
      getFileInfo: (filePath: string) => Promise<{ size: number; path: string; exists: boolean }>;
      getServerBase: () => Promise<string>;
      checkFFmpeg: () => Promise<{ available: boolean; path: string | null }>;
      getSettings: () => Promise<{
        omdbApiKey?: string;
        tmdbApiKey?: string;
        metadataApiKeys?: Record<string, string>;
        autoSyncIntervalHours?: number;
        sidebarNavOrder?: string[];
        appThemeMode?: 'dark' | 'light';
        appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue';
        appDarkTheme?: 'default' | 'justwatch' | 'black';
        appLoaderStyle?: 'play-mark' | 'logo-mark' | 'horizontal-logo';
        localNetworkSharingEnabled?: boolean;
        localNetworkShareToken?: string;
      }>;
      saveSettings: (settings: {
        omdbApiKey?: string;
        tmdbApiKey?: string;
        metadataApiKeys?: Record<string, string>;
        autoSyncIntervalHours?: number;
        sidebarNavOrder?: string[];
        appThemeMode?: 'dark' | 'light';
        appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue';
        appDarkTheme?: 'default' | 'justwatch' | 'black';
        appLoaderStyle?: 'play-mark' | 'logo-mark' | 'horizontal-logo';
        localNetworkSharingEnabled?: boolean;
        localNetworkShareToken?: string;
      }) => Promise<boolean>;
      getLocalNetworkStatus: () => Promise<{
        sharingEnabled: boolean;
        token: string;
        networkName: string;
        port: number;
        addresses: string[];
        baseUrl: string | null;
        libraryUrl: string | null;
      }>;
      getProgress: (filePath?: string) => Promise<Record<string, { position: number; duration: number; updatedAt: number; watched: boolean }> | { position: number; duration: number; updatedAt: number; watched: boolean } | null>;
      saveProgress: (filePath: string, position: number, duration: number) => Promise<{ position: number; duration: number; updatedAt: number; watched: boolean }>;
      importProgress: (progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>) => Promise<boolean>;
      getCustomArtwork: (mediaId: string) => Promise<Record<string, string>>;
      saveCustomArtwork: (mediaId: string, target: string, dataUrl: string) => Promise<Record<string, string>>;
      getOfficialMetadataCandidates: (mediaId: string) => Promise<Array<{
        id: string;
        source: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
        title: string;
        year?: number;
        thumbnail?: string;
        cover?: string;
        summary?: string;
        rating?: number;
        genres?: string[];
        posterCandidates?: string[];
        backdropCandidates?: string[];
      }>>;
      applyOfficialMetadata: (mediaId: string, candidate: {
        id: string;
        source: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
        title: string;
        year?: number;
        thumbnail?: string;
        cover?: string;
        summary?: string;
        rating?: number;
        genres?: string[];
        posterCandidates?: string[];
        backdropCandidates?: string[];
      }) => Promise<{
        thumbnail?: string;
        cover?: string;
        summary?: string;
        rating?: number;
        posterCandidates?: string[];
        backdropCandidates?: string[];
      }>;
      refreshOfficialArtwork: (mediaId: string) => Promise<{
        thumbnail?: string;
        cover?: string;
        summary?: string;
        rating?: number;
        posterCandidates?: string[];
        backdropCandidates?: string[];
      }>;
      importCustomArtwork: (entries: Record<string, Record<string, string>>) => Promise<boolean>;
      backupDatabase: () => Promise<{ ok: boolean; path?: string; error?: string }>;
      clearAppData: () => Promise<LibraryPayload>;
      openExternal: (url: string) => Promise<void>;
      getUpdateState: () => Promise<UpdateState>;
      checkForUpdates: () => Promise<UpdateState>;
      installUpdate: () => Promise<UpdateState>;
      onUpdateState: (callback: (state: UpdateState) => void) => () => void;
      playWithMPV: (filePath: string, startSecs?: number) => Promise<{ ok?: boolean; error?: string }>;
      queryMPV: () => Promise<{
        position: number;
        duration: number;
        paused: boolean;
        volume: number;
        muted: boolean;
        speed: number;
      } | null>;
      closeMPV: () => Promise<void>;
      toggleMPVPause: () => Promise<void>;
      seekMPV: (seconds: number, mode?: 'relative' | 'absolute') => Promise<void>;
      setMPVVolume: (value: number) => Promise<void>;
      toggleMPVMute: () => Promise<void>;
      setMPVSpeed: (value: number) => Promise<void>;
      setMPVFullscreen: (fullscreen: boolean) => Promise<void>;
      setMPVAspectMode: (mode: 'default' | 'contain' | 'fill' | '4 / 3' | '16 / 9' | '21 / 9') => Promise<void>;
      selectMPVTrack: (type: 'video' | 'audio' | 'sub', ffIndex: number) => Promise<void>;
      selectMPVSecondarySubtitleTrack: (ffIndex: number) => Promise<void>;
      setMPVSubtitleStyle?: (style: SubtitleStyleOptions) => Promise<void>;
      cycleMPVAudio: () => Promise<void>;
      cycleMPVSubtitle: () => Promise<void>;
      disableMPVSubtitles: () => Promise<void>;
      onMPVEvent: (callback: (event: string) => void) => () => void;
      media: {
        probe: (filePath: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
        canDirectPlay: (filePath: string, backend?: string) => Promise<{ ok: boolean; data?: boolean; error?: string }>;
        playLocal: (filePath: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
        pause: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
        resume: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
        stop: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
        seek: (seconds: number) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
        setVolume: (value: number) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
        getState: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
        startTranscode: (filePath: string, options?: {
          preset?: string;
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
        }) => Promise<{ ok: boolean; data?: { sessionId: string; playlistUrl: string }; error?: string }>;
        stopTranscode: (sessionId: string) => Promise<{ ok: boolean; data?: boolean; error?: string }>;
      };
    };

  }
}
