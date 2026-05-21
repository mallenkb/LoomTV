import { BrowserWindow, ipcMain, shell } from 'electron';
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addLocalAccessToken } from './serverSecurity';
import { appendStreamOptionParams } from './transcodeFilters.ts';
import { getMimeType } from './mimeTypes';
import type { ApiResult, ProbeResult, TranscodeOptions, TranscodeSession } from './mediaTypes';
import type { MetadataKeyTestResult } from './metadataKeys';

export type IpcLibraryFolderKind = 'movies' | 'tvShows' | 'anime' | 'others';
export type IpcLibraryScanMode = 'quick' | 'metadata' | 'full';

type LibraryScanProgress<TLibraryData> = TLibraryData & {
  isComplete: boolean;
  scannedFolders: number;
  totalFolders: number;
};

type LanPairedDevice = {
  id: string;
  name: string;
  token: string;
  createdAt: number;
  lastSeenAt: number;
  lastAddress?: string;
};

type NetworkSettings = {
  localNetworkDeviceId?: string;
  localNetworkDeviceName?: string;
  localNetworkPairedDevices?: LanPairedDevice[];
};

type UpdateStateLike = {
  status: string;
};

type OpenExternalResult = ReturnType<typeof shell.openExternal>;
export interface IpcHandlerDependencies<
  TLibraryData,
  TSettings extends NetworkSettings,
  TOfficialMetadataCandidate,
  TUpdateState extends UpdateStateLike,
> {
  getMediaServerPort: () => number;
  localAccessToken: string;
  showOpenFolderDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  loadLibrary: () => TLibraryData;
  libraryForRenderer: (library?: TLibraryData) => unknown;
  scanLibrary: (
    library: TLibraryData,
    options: {
      mode: IpcLibraryScanMode;
      onProgress?: (snapshot: LibraryScanProgress<TLibraryData>) => void;
    },
  ) => Promise<TLibraryData>;
  saveLibraryFromScan: (library: TLibraryData, scanVersion: number) => boolean;
  getLibraryMutationVersion: () => number;
  cacheArtworkNow: (library: TLibraryData) => Promise<void>;
  addFolderToLibrary: (library: TLibraryData, folderPath: string, kind: IpcLibraryFolderKind) => TLibraryData;
  removeFolderFromLibrary: (library: TLibraryData, folderPath: string) => TLibraryData;
  saveLibraryMutation: (library: TLibraryData) => void;
  assertLocalMediaPath: (filePath: string) => void;
  needsBrowserTranscoding: (filePath: string) => boolean;
  loadSettings: () => TSettings;
  saveSettings: (settings: TSettings) => void;
  syncLanAdvertisement: () => void;
  testMetadataKeys: (keys: Record<string, string>) => Promise<MetadataKeyTestResult[]>;
  getLanShareToken: () => string;
  getLanServerBase: () => string | null;
  isLanSharingEnabled: () => boolean;
  getLocalNetworkNameFast: () => string;
  getLocalNetworkAddresses: () => string[];
  discoverLanPeers: (timeoutMs: number, ownDeviceId?: string) => Promise<unknown[]>;
  getProgress: (filePath: string) => unknown;
  getAllProgress: () => unknown;
  saveProgress: (filePath: string, position: number, duration: number) => void;
  importProgress: (progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>) => void;
  customArtworkForRenderer: (mediaId: string) => unknown;
  saveCustomArtwork: (mediaId: string, target: string, dataUrl: string) => void;
  getOfficialMetadataCandidates: (mediaId: string) => unknown;
  applyOfficialMetadataCandidate: (mediaId: string, candidate: TOfficialMetadataCandidate) => unknown;
  refreshOfficialArtwork: (mediaId: string) => unknown;
  getPlaybackLogo: (mediaId: string) => unknown;
  importCustomArtwork: (entries: Record<string, Record<string, string>>) => void;
  backupDatabase: () => unknown;
  clearAppData: () => TLibraryData;
  getUpdateState: () => TUpdateState;
  checkForUpdates: () => TUpdateState | Promise<TUpdateState>;
  installDownloadedUpdate: () => unknown;
  findFFmpeg: () => string | null;
  safeResult: <T>(fn: () => T | Promise<T>) => Promise<ApiResult<T>>;
  probeMedia: (filePath: string) => ProbeResult;
  canDirectPlay: (filePath: string, probe: ProbeResult, backend: 'html5' | 'hls') => unknown;
  startTranscode: (filePath: string, options: TranscodeOptions, serverBase: string) => Promise<TranscodeSession>;
  appendLocalAccessTokenToUrl: (url: string) => string;
  stopTranscode: (sessionId: string) => unknown;
}

function safeLibraryFolderKind(kind: string | undefined): IpcLibraryFolderKind {
  return kind === 'tvShows' || kind === 'anime' || kind === 'movies' || kind === 'others' ? kind : 'movies';
}

function scanProgressPayload<TLibraryData>(snapshot: LibraryScanProgress<TLibraryData>) {
  return {
    isComplete: snapshot.isComplete,
    scannedFolders: snapshot.scannedFolders,
    totalFolders: snapshot.totalFolders,
  };
}

export function registerIpcHandlers<
  TLibraryData,
  TSettings extends NetworkSettings,
  TOfficialMetadataCandidate,
  TUpdateState extends UpdateStateLike,
>(deps: IpcHandlerDependencies<TLibraryData, TSettings, TOfficialMetadataCandidate, TUpdateState>): void {
  ipcMain.handle('library:get', () => deps.libraryForRenderer());

  ipcMain.handle('library:scan', async (event, options?: { force?: boolean; mode?: IpcLibraryScanMode }) => {
    const data = deps.loadLibrary();
    const scanVersion = deps.getLibraryMutationVersion();
    const mode: IpcLibraryScanMode = options?.force
      ? 'full'
      : options?.mode === 'metadata' || options?.mode === 'full'
        ? options.mode
        : 'quick';
    const scanned = await deps.scanLibrary(data, {
      mode,
      onProgress: (snapshot) => {
        event.sender.send('library:scan-progress', deps.libraryForRenderer(snapshot), scanProgressPayload(snapshot));
      },
    });
    if (deps.saveLibraryFromScan(scanned, scanVersion)) {
      await deps.cacheArtworkNow(scanned);
    }
    return deps.libraryForRenderer();
  });

  ipcMain.handle('library:add-folder', async (_event, kind: string = 'movies') => {
    const result = await deps.showOpenFolderDialog({
      properties: ['openDirectory'],
      buttonLabel: 'Add Folder',
      message: 'Select a folder to add to your LoomTV library.',
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const data = deps.loadLibrary();
      const newFolder = result.filePaths[0];
      const updated = deps.addFolderToLibrary(data, newFolder, safeLibraryFolderKind(kind));
      deps.saveLibraryMutation(updated);
      const scanVersion = deps.getLibraryMutationVersion();
      const scanned = await deps.scanLibrary(updated, {
        mode: 'quick',
        onProgress: (snapshot) => {
          BrowserWindow.getAllWindows().forEach((window) => {
            window.webContents.send('library:scan-progress', deps.libraryForRenderer(snapshot), scanProgressPayload(snapshot));
          });
        },
      });
      if (deps.saveLibraryFromScan(scanned, scanVersion)) {
        await deps.cacheArtworkNow(scanned);
      }
      return deps.libraryForRenderer();
    }
    return null;
  });

  ipcMain.handle('library:remove-folder', (_event, folderPath: string) => {
    const data = deps.loadLibrary();
    const updated = deps.removeFolderFromLibrary(data, folderPath);
    deps.saveLibraryMutation(updated);
    return deps.libraryForRenderer();
  });

  ipcMain.handle('media:play', async (_event, filePath: string) => {
    try {
      deps.assertLocalMediaPath(filePath);
      return false;
    } catch {
      return false;
    }
  });

  ipcMain.handle('media:get-server-port', () => deps.getMediaServerPort());

  ipcMain.handle('media:get-stream-url', (_event, filePath: string, options?: TranscodeOptions) => {
    deps.assertLocalMediaPath(filePath);
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), deps.localAccessToken);
    appendStreamOptionParams(params, options);
    const isTranscoded = Boolean(options?.forceTranscode)
      || typeof options?.videoTrackIndex === 'number'
      || typeof options?.audioTrackIndex === 'number'
      || typeof options?.subtitleTrackIndex === 'number'
      || typeof options?.secondarySubtitleTrackIndex === 'number'
      || deps.needsBrowserTranscoding(filePath);
    const url = `http://127.0.0.1:${deps.getMediaServerPort()}/stream?${params.toString()}`;
    return {
      url,
      contentType: isTranscoded ? 'video/mp4' : getMimeType(filePath),
      fileName: path.basename(filePath),
      isTranscoded,
    };
  });

  ipcMain.handle('media:get-subtitle-url', (_event, filePath: string, streamOrdinal?: number) => {
    deps.assertLocalMediaPath(filePath);
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), deps.localAccessToken);
    if (typeof streamOrdinal === 'number' && streamOrdinal >= 0) params.set('streamOrdinal', String(Math.floor(streamOrdinal)));
    return { url: `http://127.0.0.1:${deps.getMediaServerPort()}/subtitle?${params.toString()}` };
  });

  ipcMain.handle('media:get-thumbnail', (_event, filePath: string, time?: string) => {
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), deps.localAccessToken);
    if (time) params.set('t', time);
    return { url: `http://127.0.0.1:${deps.getMediaServerPort()}/api/thumbnail?${params.toString()}` };
  });

  ipcMain.handle('media:get-file-info', (_event, filePath: string) => {
    try {
      deps.assertLocalMediaPath(filePath);
      const exists = fs.existsSync(filePath);
      const size = exists ? fs.statSync(filePath).size : 0;
      return { size, path: filePath, exists };
    } catch {
      return { size: 0, path: filePath, exists: false };
    }
  });

  ipcMain.handle('settings:get', () => deps.loadSettings());

  ipcMain.handle('settings:save', (_event, settings: TSettings) => {
    deps.saveSettings({ ...deps.loadSettings(), ...settings });
    deps.syncLanAdvertisement();
    return true;
  });

  ipcMain.handle('metadata:test-keys', (_event, keys: Record<string, string>) => deps.testMetadataKeys(keys || {}));

  ipcMain.handle('network:status', () => {
    const settings = deps.loadSettings();
    const token = deps.getLanShareToken();
    const base = deps.getLanServerBase();
    return {
      sharingEnabled: deps.isLanSharingEnabled(),
      token,
      deviceId: settings.localNetworkDeviceId,
      deviceName: settings.localNetworkDeviceName || os.hostname(),
      networkName: deps.getLocalNetworkNameFast(),
      port: deps.getMediaServerPort(),
      addresses: deps.getLocalNetworkAddresses(),
      baseUrl: base,
      libraryUrl: base ? `${base}/api/lan/library` : null,
      pairedDevices: settings.localNetworkPairedDevices || [],
    };
  });

  ipcMain.handle('network:discover-peers', async (_event, timeoutMs?: number) => {
    const settings = deps.loadSettings();
    try {
      return await deps.discoverLanPeers(Number(timeoutMs) || 2500, settings.localNetworkDeviceId);
    } catch (error) {
      console.warn('[mdns] discover failed:', error);
      return [];
    }
  });

  ipcMain.handle('network:revoke-paired-device', (_event, deviceId: string) => {
    const settings = deps.loadSettings();
    const remaining = (settings.localNetworkPairedDevices || []).filter((device) => device.id !== deviceId);
    deps.saveSettings({ ...settings, localNetworkPairedDevices: remaining });
    return remaining;
  });

  ipcMain.handle('network:set-device-name', (_event, name: string) => {
    const settings = deps.loadSettings();
    const nextName = String(name || '').trim().slice(0, 80) || os.hostname();
    deps.saveSettings({ ...settings, localNetworkDeviceName: nextName });
    deps.syncLanAdvertisement();
    return nextName;
  });

  ipcMain.handle('progress:get', (_event, filePath?: string) => filePath ? deps.getProgress(filePath) : deps.getAllProgress());
  ipcMain.handle('progress:save', (_event, filePath: string, position: number, duration: number) =>
    deps.saveProgress(filePath, Number(position) || 0, Number(duration) || 0));
  ipcMain.handle('progress:import', (_event, progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>) => {
    deps.importProgress(progress || {});
    return true;
  });
  ipcMain.handle('artwork:get', (_event, mediaId: string) => deps.customArtworkForRenderer(mediaId));
  ipcMain.handle('artwork:save', (_event, mediaId: string, target: string, dataUrl: string) => {
    deps.saveCustomArtwork(mediaId, target, dataUrl);
    return deps.customArtworkForRenderer(mediaId);
  });
  ipcMain.handle('artwork:official-candidates', (_event, mediaId: string) => deps.getOfficialMetadataCandidates(mediaId));
  ipcMain.handle('artwork:apply-official', (_event, mediaId: string, candidate: TOfficialMetadataCandidate) =>
    deps.applyOfficialMetadataCandidate(mediaId, candidate));
  ipcMain.handle('artwork:refresh-official', (_event, mediaId: string) => deps.refreshOfficialArtwork(mediaId));
  ipcMain.handle('artwork:playback-logo', (_event, mediaId: string) => deps.getPlaybackLogo(mediaId));
  ipcMain.handle('artwork:import', (_event, entries: Record<string, Record<string, string>>) => {
    deps.importCustomArtwork(entries || {});
    return true;
  });
  ipcMain.handle('database:backup', () => deps.backupDatabase());
  ipcMain.handle('database:clear', () => deps.libraryForRenderer(deps.clearAppData()));
  ipcMain.handle('shell:open-external', (_event, url: string): OpenExternalResult => {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only http and https links can be opened externally.');
    }
    return shell.openExternal(parsed.toString());
  });
  ipcMain.handle('updates:get-state', () => deps.getUpdateState());
  ipcMain.handle('updates:check', () => deps.checkForUpdates());
  ipcMain.handle('updates:install', () => {
    const updateState = deps.getUpdateState();
    if (updateState.status !== 'downloaded') return updateState;
    return deps.installDownloadedUpdate();
  });

  ipcMain.handle('media:ffmpeg-available', () => {
    const ffmpegPath = deps.findFFmpeg();
    return { available: ffmpegPath !== null, path: ffmpegPath };
  });

  ipcMain.handle('media:probe', (_event, filePath: string) => deps.safeResult(() => deps.probeMedia(filePath)));

  ipcMain.handle('media:can-direct-play', (_event, filePath: string, backend: 'html5' | 'hls' = 'html5') =>
    deps.safeResult(() => {
      const result = deps.probeMedia(filePath);
      return deps.canDirectPlay(filePath, result, backend);
    }),
  );

  ipcMain.handle('media:start-transcode', (_event, filePath: string, options?: TranscodeOptions) =>
    deps.safeResult(async () => {
      const session = await deps.startTranscode(filePath, options || {}, `http://127.0.0.1:${deps.getMediaServerPort()}`);
      return { ...session, playlistUrl: deps.appendLocalAccessTokenToUrl(session.playlistUrl) };
    }),
  );
  ipcMain.handle('media:stop-transcode', (_event, sessionId: string) => deps.safeResult(() => deps.stopTranscode(sessionId)));
}
