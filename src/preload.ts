import { contextBridge, ipcRenderer } from 'electron';

// ─── desktopApi — existing library/media/settings surface ────────────────────

contextBridge.exposeInMainWorld('desktopApi', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  scanLibrary: () => ipcRenderer.invoke('library:scan'),
  addLibraryFolder: () => ipcRenderer.invoke('library:add-folder'),
  removeLibraryFolder: (folderPath: string) => ipcRenderer.invoke('library:remove-folder', folderPath),
  playMedia: (filePath: string) => ipcRenderer.invoke('media:play', filePath),
  getStreamUrl: (filePath: string) => ipcRenderer.invoke('media:get-stream-url', filePath),
  getThumbnail: (filePath: string, time?: string) => ipcRenderer.invoke('media:get-thumbnail', filePath, time),
  getFileInfo: (filePath: string) => ipcRenderer.invoke('media:get-file-info', filePath),
  getServerBase: () => ipcRenderer.invoke('media:get-server-port').then((port: number) => `http://127.0.0.1:${port}`),
  checkFFmpeg: () => ipcRenderer.invoke('media:ffmpeg-available'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: {
    omdbApiKey?: string;
    tmdbApiKey?: string;
    metadataApiKeys?: Record<string, string>;
  }) => ipcRenderer.invoke('settings:save', settings),

  // Legacy MPV handlers (still used by existing VideoPlayer)
  playWithMPV: (filePath: string, startSecs?: number) => ipcRenderer.invoke('media:play-mpv', filePath, startSecs),
  queryMPV: () => ipcRenderer.invoke('media:query-mpv'),
  closeMPV: () => ipcRenderer.invoke('media:close-mpv'),
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
      getLibrary: () => Promise<{ movies: any[]; tvShows: any[]; animeShows?: any[]; libraryFolders: string[] }>;
      scanLibrary: () => Promise<{ movies: any[]; tvShows: any[]; animeShows?: any[]; libraryFolders: string[] }>;
      addLibraryFolder: () => Promise<{ movies: any[]; tvShows: any[]; animeShows?: any[]; libraryFolders: string[] } | null>;
      removeLibraryFolder: (folderPath: string) => Promise<{ movies: any[]; tvShows: any[]; animeShows?: any[]; libraryFolders: string[] }>;
      playMedia: (filePath: string) => Promise<boolean>;
      getStreamUrl: (filePath: string) => Promise<{ url: string; contentType: string; fileName: string }>;
      getThumbnail: (filePath: string, time?: string) => Promise<{ url: string }>;
      getFileInfo: (filePath: string) => Promise<{ size: number; path: string; exists: boolean }>;
      getServerBase: () => Promise<string>;
      checkFFmpeg: () => Promise<{ available: boolean; path: string | null }>;
      getSettings: () => Promise<{
        omdbApiKey?: string;
        tmdbApiKey?: string;
        metadataApiKeys?: Record<string, string>;
      }>;
      saveSettings: (settings: {
        omdbApiKey?: string;
        tmdbApiKey?: string;
        metadataApiKeys?: Record<string, string>;
      }) => Promise<boolean>;
      playWithMPV: (filePath: string, startSecs?: number) => Promise<{ ok?: boolean; error?: string }>;
      queryMPV: () => Promise<{ position: number | null; duration: number | null } | null>;
      closeMPV: () => Promise<void>;
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
        }) => Promise<{ ok: boolean; data?: { sessionId: string; playlistUrl: string }; error?: string }>;
        stopTranscode: (sessionId: string) => Promise<{ ok: boolean; data?: boolean; error?: string }>;
      };
    };

  }
}
