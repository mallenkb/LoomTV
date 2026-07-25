import { BrowserWindow, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addLocalAccessToken } from './serverSecurity';
import { appendStreamOptionParams } from './transcodeFilters.ts';
import { getMimeType } from './mimeTypes';
import type { ApiResult, ProbeResult, TranscodeOptions, TranscodeSession } from './mediaTypes';
import type { MetadataKeyTestResult } from './metadataKeys';
import type { BrowserPlaybackPlan } from './transcodeDecision';
import type { ManualMediaSegmentInput, MediaSegmentRequest, MediaSegmentResponse } from './skipSegments/types';
import type { IpcInvokeChannel } from '../shared/ipcChannels';
import type { IpcContract } from '../shared/ipcContract';
import type { StoredProgress } from '../shared/desktopProtocol.ts';
import { buildNetworkStatus, ffmpegAvailability } from './ipcHandlerPolicy.ts';

type IpcLibraryFolderKind = 'movies' | 'tvShows' | 'anime' | 'others';
type IpcLibraryScanMode = 'quick' | 'metadata' | 'full';

type LibraryScanProgress<TLibraryData> = TLibraryData & {
  isComplete: boolean;
  scannedFolders: number;
  totalFolders: number;
};

type LanPairedDevice = {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  lastAddress?: string;
};

type NetworkSettings = {
  localNetworkDeviceId?: string;
  localNetworkDeviceName?: string;
  localNetworkPairedDevices?: LanPairedDevice[];
};

type OpenExternalResult = ReturnType<typeof shell.openExternal>;
type IpcResult<C extends IpcInvokeChannel> = IpcContract[C]['result'];
type OfficialMetadataCandidate = IpcContract['artwork:apply-official']['args'][1];
type OfficialMetadataApplyTarget = IpcContract['artwork:apply-official']['args'][2];
type OfficialArtworkRefreshTarget = IpcContract['artwork:refresh-official']['args'][1];
export interface IpcHandlerDependencies<
  TLibraryData,
  TSettings extends NetworkSettings & IpcResult<'settings:get'>,
> {
  getMediaServerPort: () => number;
  localAccessToken: string;
  showOpenFolderDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  loadLibrary: () => TLibraryData;
  libraryForRenderer: (library?: TLibraryData) => IpcResult<'library:get'>;
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
  authorizeMediaPath: (filePath: string) => void;
  needsBrowserTranscoding: (filePath: string) => boolean;
  browserPlaybackPlan: (filePath: string, options?: TranscodeOptions) => BrowserPlaybackPlan;
  loadSettings: () => TSettings;
  settingsForRenderer: () => TSettings;
  authorizeSettingsWrite: () => void;
  saveSettings: (settings: TSettings) => void;
  onSettingsSaved?: () => void;
  syncLanAdvertisement: () => void;
  testMetadataKeys: (keys: Record<string, string>) => Promise<MetadataKeyTestResult[]>;
  getLanShareToken: () => string;
  getLanServerBase: () => string | null;
  isLanSharingEnabled: () => boolean;
  getLocalNetworkNameFast: () => string;
  getLocalNetworkAddresses: () => string[];
  discoverLanPeers: (timeoutMs: number, ownDeviceId?: string) => Promise<IpcResult<'network:discover-peers'>>;
  connectRemoteLibrary: (
    baseUrl: string,
    code: string,
    device: { id?: string; name: string },
  ) => Promise<IpcResult<'network:remote-connect'>>;
  requestRemoteLibrary: (
    pathname: string,
    request?: IpcContract['network:remote-request']['args'][1],
  ) => Promise<IpcResult<'network:remote-request'>>;
  getRemoteLibrarySession: () => IpcResult<'network:remote-session'>;
  disconnectRemoteLibrary: (revoke?: boolean) => Promise<boolean>;
  getProgress: (filePath: string) => StoredProgress | null;
  getAllProgress: () => Record<string, StoredProgress>;
  saveProgress: (filePath: string, position: number, duration: number, expectedProfileId?: string) => IpcResult<'progress:save'>;
  importProgress: (progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>, expectedProfileId?: string) => void;
  listProfiles: () => IpcResult<'profiles:list'>;
  chooseProfileAvatar: () => Promise<IpcResult<'profiles:choose-avatar'>>;
  getActiveProfileState: () => IpcResult<'profiles:get-active'>;
  createProfile: (input: IpcContract['profiles:create']['args'][0]) => IpcResult<'profiles:create'>;
  updateProfile: (profileId: string, patch: IpcContract['profiles:update']['args'][1]) => IpcResult<'profiles:update'>;
  deleteProfile: (profileId: string) => IpcResult<'profiles:delete'>;
  exportProfile: (profileId: string) => Promise<IpcResult<'profiles:export'>>;
  importProfile: () => Promise<IpcResult<'profiles:import'>>;
  selectProfile: (profileId: string, pin?: string) => IpcResult<'profiles:select'> | Promise<IpcResult<'profiles:select'>>;
  selectGuestProfile: () => IpcResult<'profiles:select-guest'>;
  lockProfile: () => IpcResult<'profiles:lock'>;
  reorderProfiles: (profileIds: string[]) => IpcResult<'profiles:reorder'>;
  changeProfilePin: (profileId: string, pin: string | null) => Promise<IpcResult<'profiles:pin'>>;
  resetOwnerProfile: (confirmation: string) => IpcResult<'profiles:reset-owner'>;
  setAutomaticSignIn: (enabled: boolean) => IpcResult<'profiles:set-auto-sign-in'>;
  getProfilePreferences: () => IpcResult<'profile-preferences:get'>;
  saveProfilePreferences: (patch: IpcContract['profile-preferences:save']['args'][0], expectedProfileId?: string) => IpcResult<'profile-preferences:save'>;
  getProfileRestrictions: (profileId: string) => IpcResult<'profile-restrictions:get'>;
  saveProfileRestrictions: (profileId: string, input: IpcContract['profile-restrictions:save']['args'][1]) => IpcResult<'profile-restrictions:save'>;
  getProfileLists: (kind?: IpcContract['profile-lists:get']['args'][0]) => IpcResult<'profile-lists:get'>;
  setProfileListEntry: (mediaId: string, kind: IpcContract['profile-lists:set']['args'][1], present: boolean, expectedProfileId?: string) => IpcResult<'profile-lists:set'>;
  getPlaybackTrackPreferences: (scope?: string) => IpcResult<'playback-track-preferences:get'>;
  savePlaybackTrackPreferences: (
    scope: string,
    preferences: IpcContract['playback-track-preferences:save']['args'][1],
    expectedProfileId?: string,
  ) => IpcResult<'playback-track-preferences:save'>;
  getMediaSegments: (request: MediaSegmentRequest) => Promise<MediaSegmentResponse>;
  saveManualMediaSegment: (input: ManualMediaSegmentInput) => MediaSegmentResponse;
  deleteManualMediaSegment: (input: MediaSegmentRequest & { candidateId?: string; type: ManualMediaSegmentInput['type'] }) => MediaSegmentResponse;
  undoManualMediaSegment: (input: MediaSegmentRequest & { candidateId?: string; type: ManualMediaSegmentInput['type'] }) => MediaSegmentResponse;
  getManagedMediaSegments: (request?: Partial<MediaSegmentRequest>) => IpcResult<'playback:segments:manage-list'>;
  updateManagedMediaSegment: (candidateId: string, patch: IpcContract['playback:segments:manage-update']['args'][1]) => boolean;
  eraseManagedMediaSegments: (request: MediaSegmentRequest) => IpcResult<'playback:segments:manage-erase'>;
  setPlaybackActivityLease: (key: string, active: boolean, label?: string) => void;
  getLocalSegmentAnalysisStatus: () => IpcResult<'playback:analysis:status'>;
  analyzeLocalSegmentSeason: (mediaId: string, season: number) => Promise<MediaSegmentResponse>;
  runLocalSegmentAnalysis: (scope?: IpcContract['playback:analysis:run']['args'][0]) => IpcResult<'playback:analysis:run'>;
  cancelLocalSegmentAnalysis: (request?: { jobKey?: string; kind?: 'manual' }) => IpcResult<'playback:analysis:cancel'>;
  pauseLocalSegmentAnalysis: () => boolean;
  resumeLocalSegmentAnalysis: () => boolean;
  cleanupLocalSegmentAnalysis: () => IpcResult<'playback:analysis:cleanup'>;
  rebuildLocalSegmentAnalysis: () => IpcResult<'playback:analysis:rebuild'>;
  customArtworkForRenderer: (mediaId: string) => IpcResult<'artwork:get'>;
  saveCustomArtwork: (mediaId: string, target: string, dataUrl: string) => void;
  getOfficialMetadataCandidates: (mediaId: string) => IpcResult<'artwork:official-candidates'> | Promise<IpcResult<'artwork:official-candidates'>>;
  applyOfficialMetadataCandidate: (mediaId: string, candidate: OfficialMetadataCandidate, target?: OfficialMetadataApplyTarget) => IpcResult<'artwork:apply-official'> | Promise<IpcResult<'artwork:apply-official'>>;
  refreshOfficialArtwork: (mediaId: string, target?: OfficialArtworkRefreshTarget) => IpcResult<'artwork:refresh-official'> | Promise<IpcResult<'artwork:refresh-official'>>;
  getPlaybackLogo: (mediaId: string) => IpcResult<'artwork:playback-logo'> | Promise<IpcResult<'artwork:playback-logo'>>;
  importCustomArtwork: (entries: Record<string, Record<string, string>>) => void;
  backupDatabase: () => IpcResult<'database:backup'> | Promise<IpcResult<'database:backup'>>;
  clearAppData: () => TLibraryData;
  getUpdateState: () => IpcResult<'updates:get-state'>;
  checkForUpdates: () => IpcResult<'updates:check'> | Promise<IpcResult<'updates:check'>>;
  installDownloadedUpdate: () => IpcResult<'updates:install'> | Promise<IpcResult<'updates:install'>>;
  findFFmpeg: () => string | null;
  safeResult: <T>(fn: () => T | Promise<T>) => Promise<ApiResult<T>>;
  probeMedia: (filePath: string) => Promise<ProbeResult>;
  canDirectPlay: (filePath: string, probe: ProbeResult, backend: 'html5' | 'hls') => boolean;
  startTranscode: (filePath: string, options: TranscodeOptions, serverBase: string) => Promise<TranscodeSession>;
  appendLocalAccessTokenToUrl: (url: string) => string;
  stopTranscode: (sessionId: string) => boolean;
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
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
  TSettings extends NetworkSettings & IpcResult<'settings:get'>,
>(deps: IpcHandlerDependencies<TLibraryData, TSettings>): void {
  const handle = <C extends IpcInvokeChannel>(
    channel: C,
    listener: (
      event: IpcMainInvokeEvent,
      ...args: IpcContract[C]['args']
    ) => IpcContract[C]['result'] | Promise<IpcContract[C]['result']>,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!deps.isTrustedSender(event)) throw new Error('Untrusted IPC sender.');
      return listener(event, ...(args as IpcContract[C]['args']));
    });
  };

  handle('library:get', () => deps.libraryForRenderer());

  handle('library:scan', async (event, options?: { force?: boolean; mode?: IpcLibraryScanMode }) => {
    deps.authorizeSettingsWrite();
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

  handle('library:add-folder', async (_event, kind: string = 'movies') => {
    deps.authorizeSettingsWrite();
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

  handle('library:remove-folder', (_event, folderPath: string) => {
    deps.authorizeSettingsWrite();
    const data = deps.loadLibrary();
    const updated = deps.removeFolderFromLibrary(data, folderPath);
    deps.saveLibraryMutation(updated);
    return deps.libraryForRenderer();
  });

  handle('media:play', async (_event, filePath: string) => {
    try {
      deps.authorizeMediaPath(filePath);
      deps.assertLocalMediaPath(filePath);
      return false;
    } catch {
      return false;
    }
  });

  handle('media:get-server-port', () => deps.getMediaServerPort());

  handle('media:get-stream-url', (_event, filePath: string, options?: TranscodeOptions) => {
    deps.authorizeMediaPath(filePath);
    deps.assertLocalMediaPath(filePath);
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), deps.localAccessToken);
    appendStreamOptionParams(params, options);
    const playbackPlan = deps.browserPlaybackPlan(filePath, options || {});
    const url = `http://127.0.0.1:${deps.getMediaServerPort()}/stream?${params.toString()}`;
    return {
      url,
      contentType: playbackPlan.mode === 'direct' ? getMimeType(filePath) : playbackPlan.contentType,
      fileName: path.basename(filePath),
      isTranscoded: playbackPlan.requiresSeekRestart,
      isRemuxed: playbackPlan.mode === 'remux',
      playbackMode: playbackPlan.mode,
      decisionReason: playbackPlan.reason,
    };
  });

  handle('media:get-subtitle-url', (_event, filePath: string, streamOrdinal?: number) => {
    deps.authorizeMediaPath(filePath);
    deps.assertLocalMediaPath(filePath);
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), deps.localAccessToken);
    if (typeof streamOrdinal === 'number' && streamOrdinal >= 0) params.set('streamOrdinal', String(Math.floor(streamOrdinal)));
    return { url: `http://127.0.0.1:${deps.getMediaServerPort()}/subtitle?${params.toString()}` };
  });

  handle('media:get-thumbnail', (_event, filePath: string, time?: string) => {
    deps.authorizeMediaPath(filePath);
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), deps.localAccessToken);
    if (time) params.set('t', time);
    return { url: `http://127.0.0.1:${deps.getMediaServerPort()}/api/thumbnail?${params.toString()}` };
  });

  handle('media:get-file-info', (_event, filePath: string) => {
    try {
      deps.authorizeMediaPath(filePath);
      deps.assertLocalMediaPath(filePath);
      const exists = fs.existsSync(filePath);
      const size = exists ? fs.statSync(filePath).size : 0;
      return { size, path: filePath, exists };
    } catch {
      return { size: 0, path: filePath, exists: false };
    }
  });

  handle('settings:get', () => deps.settingsForRenderer());

  handle('settings:save', (_event, settings) => {
    deps.authorizeSettingsWrite();
    deps.saveSettings({ ...deps.loadSettings(), ...settings });
    deps.onSettingsSaved?.();
    deps.syncLanAdvertisement();
    return true;
  });

  handle('metadata:test-keys', (_event, keys: Record<string, string>) => {
    deps.authorizeSettingsWrite();
    return deps.testMetadataKeys(keys || {});
  });

  handle('network:status', () => {
    const status = buildNetworkStatus(deps);
    return { ...status, deviceName: status.deviceName || os.hostname() };
  });

  handle('network:discover-peers', async (_event, timeoutMs?: number) => {
    const settings = deps.loadSettings();
    try {
      return await deps.discoverLanPeers(Number(timeoutMs) || 2500, settings.localNetworkDeviceId);
    } catch (error) {
      console.warn('[mdns] discover failed:', error);
      return [];
    }
  });

  handle('network:remote-connect', (_event, baseUrl, code) => {
    const settings = deps.loadSettings();
    return deps.connectRemoteLibrary(String(baseUrl || ''), String(code || ''), {
      id: settings.localNetworkDeviceId,
      name: settings.localNetworkDeviceName || os.hostname(),
    });
  });

  handle('network:remote-request', (_event, pathname, request) =>
    deps.requestRemoteLibrary(String(pathname || ''), request));

  handle('network:remote-session', () => deps.getRemoteLibrarySession());

  handle('network:remote-disconnect', (_event, revoke) =>
    deps.disconnectRemoteLibrary(Boolean(revoke)));

  handle('network:revoke-paired-device', (_event, deviceId: string) => {
    deps.authorizeSettingsWrite();
    const settings = deps.loadSettings();
    const remaining = (settings.localNetworkPairedDevices || []).filter((device) => device.id !== deviceId);
    deps.saveSettings({ ...settings, localNetworkPairedDevices: remaining });
    return remaining;
  });

  handle('network:set-device-name', (_event, name: string) => {
    deps.authorizeSettingsWrite();
    const settings = deps.loadSettings();
    const nextName = String(name || '').trim().slice(0, 80) || os.hostname();
    deps.saveSettings({ ...settings, localNetworkDeviceName: nextName });
    deps.syncLanAdvertisement();
    return nextName;
  });

  handle('profiles:list', () => deps.listProfiles());
  handle('profiles:choose-avatar', () => deps.chooseProfileAvatar());
  handle('profiles:get-active', () => deps.getActiveProfileState());
  handle('profiles:lock', () => deps.lockProfile());
  handle('profiles:create', (_event, input) => deps.createProfile(input || { name: '' }));
  handle('profiles:update', (_event, profileId: string, patch) => deps.updateProfile(String(profileId || ''), patch || {}));
  handle('profiles:delete', (_event, profileId: string) => deps.deleteProfile(String(profileId || '')));
  handle('profiles:export', (_event, profileId: string) => deps.exportProfile(String(profileId || '')));
  handle('profiles:import', () => deps.importProfile());
  handle('profiles:select', (_event, profileId: string, pin?: string) => deps.selectProfile(String(profileId || ''), pin));
  handle('profiles:select-guest', () => deps.selectGuestProfile());
  handle('profiles:reorder', (_event, profileIds) => deps.reorderProfiles(Array.isArray(profileIds) ? profileIds.map(String) : []));
  handle('profiles:pin', (_event, profileId, pin) => deps.changeProfilePin(String(profileId || ''), pin === null ? null : String(pin || '')));
  handle('profiles:reset-owner', (_event, confirmation) => deps.resetOwnerProfile(String(confirmation || '')));
  handle('profiles:set-auto-sign-in', (_event, enabled) => deps.setAutomaticSignIn(Boolean(enabled)));
  handle('profile-preferences:get', () => deps.getProfilePreferences());
  handle('profile-preferences:save', (_event, patch, expectedProfileId) => deps.saveProfilePreferences(patch || {}, expectedProfileId));
  handle('profile-restrictions:get', (_event, profileId) => deps.getProfileRestrictions(String(profileId || '')));
  handle('profile-restrictions:save', (_event, profileId, input) => deps.saveProfileRestrictions(String(profileId || ''), input));
  handle('profile-lists:get', (_event, kind) => deps.getProfileLists(kind));
  handle('profile-lists:set', (_event, mediaId, kind, present, expectedProfileId) => deps.setProfileListEntry(String(mediaId || ''), kind, Boolean(present), expectedProfileId));
  handle('progress:get', (_event, filePath?: string) => filePath ? deps.getProgress(filePath) : deps.getAllProgress());
  handle('progress:save', (_event, filePath: string, position: number, duration: number, expectedProfileId?: string) =>
    deps.saveProgress(filePath, Number(position) || 0, Number(duration) || 0, expectedProfileId));
  handle('progress:import', (_event, progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>, expectedProfileId?: string) => {
    deps.importProgress(progress || {}, expectedProfileId);
    return true;
  });
  handle('playback-track-preferences:get', (_event, scope?: string) => deps.getPlaybackTrackPreferences(scope));
  handle('playback-track-preferences:save', (_event, scope: string, preferences, expectedProfileId) =>
    deps.savePlaybackTrackPreferences(scope, preferences || {}, expectedProfileId));
  handle('playback:segments:get', (_event, request: MediaSegmentRequest) =>
    deps.getMediaSegments(request || { mediaId: '' }));
  handle('playback:segments:save-manual', (_event, input: ManualMediaSegmentInput) => {
    deps.authorizeSettingsWrite();
    return deps.saveManualMediaSegment(input);
  });
  handle('playback:segments:delete-manual', (_event, input: MediaSegmentRequest & { candidateId?: string; type: ManualMediaSegmentInput['type'] }) => {
    deps.authorizeSettingsWrite();
    return deps.deleteManualMediaSegment(input);
  });
  handle('playback:segments:undo-manual', (_event, input: MediaSegmentRequest & { candidateId?: string; type: ManualMediaSegmentInput['type'] }) => {
    deps.authorizeSettingsWrite();
    return deps.undoManualMediaSegment(input);
  });
  handle('playback:segments:manage-list', (_event, request) => {
    deps.authorizeSettingsWrite();
    return deps.getManagedMediaSegments(request ? {
      mediaId: request.mediaId ? String(request.mediaId).slice(0, 240) : undefined,
      season: request.season === undefined ? undefined : Math.max(0, Math.floor(Number(request.season) || 0)),
      episode: request.episode === undefined ? undefined : Math.max(0, Math.floor(Number(request.episode) || 0)),
    } : undefined);
  });
  handle('playback:segments:manage-update', (_event, candidateId, patch) => {
    deps.authorizeSettingsWrite();
    const status = patch?.status === 'active' || patch?.status === 'review' || patch?.status === 'rejected' ? patch.status : undefined;
    const type = patch?.type === 'intro' || patch?.type === 'recap' || patch?.type === 'outro' || patch?.type === 'credits' || patch?.type === 'preview' ? patch.type : undefined;
    return deps.updateManagedMediaSegment(String(candidateId || '').slice(0, 240), { status, type });
  });
  handle('playback:segments:manage-erase', (_event, request) => {
    deps.authorizeSettingsWrite();
    return deps.eraseManagedMediaSegments({
      mediaId: String(request?.mediaId || '').slice(0, 240),
      season: request?.season === undefined ? undefined : Math.max(0, Math.floor(Number(request.season) || 0)),
      episode: request?.episode === undefined ? undefined : Math.max(0, Math.floor(Number(request.episode) || 0)),
    });
  });
  handle('playback:activity', (_event, key: string, active: boolean, label?: string) => {
    deps.setPlaybackActivityLease(key, Boolean(active), label);
    return true;
  });
  handle('playback:analysis:status', () => {
    deps.authorizeSettingsWrite();
    return deps.getLocalSegmentAnalysisStatus();
  });
  handle('playback:analysis:season', (_event, mediaId: string, season: number) => {
    deps.authorizeSettingsWrite();
    return deps.analyzeLocalSegmentSeason(
      String(mediaId || '').slice(0, 240),
      Number.isFinite(Number(season)) ? Math.max(0, Math.floor(Number(season))) : 1,
    );
  });
  handle('playback:analysis:run', (_event, scope) => {
    deps.authorizeSettingsWrite();
    return deps.runLocalSegmentAnalysis(scope ? {
      mediaId: scope.mediaId ? String(scope.mediaId).slice(0, 240) : undefined,
      season: scope.season === undefined || !Number.isFinite(Number(scope.season)) ? undefined : Math.max(0, Math.floor(Number(scope.season))),
      episode: scope.episode === undefined || !Number.isFinite(Number(scope.episode)) ? undefined : Math.max(0, Math.floor(Number(scope.episode))),
      mode: scope.mode === 'quick' ? 'quick' : scope.mode === 'full' ? 'full' : undefined,
    } : undefined);
  });
  handle('playback:analysis:cancel', (_event, request) => {
    deps.authorizeSettingsWrite();
    return deps.cancelLocalSegmentAnalysis(request ? {
      jobKey: request.jobKey ? String(request.jobKey).slice(0, 128) : undefined,
      kind: request.kind === 'manual' ? 'manual' : undefined,
    } : undefined);
  });
  handle('playback:analysis:pause', () => {
    deps.authorizeSettingsWrite();
    return deps.pauseLocalSegmentAnalysis();
  });
  handle('playback:analysis:resume', () => {
    deps.authorizeSettingsWrite();
    return deps.resumeLocalSegmentAnalysis();
  });
  handle('playback:analysis:cleanup', () => {
    deps.authorizeSettingsWrite();
    return deps.cleanupLocalSegmentAnalysis();
  });
  handle('playback:analysis:rebuild', () => {
    deps.authorizeSettingsWrite();
    return deps.rebuildLocalSegmentAnalysis();
  });
  handle('artwork:get', (_event, mediaId: string) => deps.customArtworkForRenderer(mediaId));
  handle('artwork:save', (_event, mediaId: string, target: string, dataUrl: string) => {
    deps.authorizeSettingsWrite();
    deps.saveCustomArtwork(mediaId, target, dataUrl);
    return deps.customArtworkForRenderer(mediaId);
  });
  handle('artwork:official-candidates', (_event, mediaId: string) => {
    deps.authorizeSettingsWrite();
    return deps.getOfficialMetadataCandidates(mediaId);
  });
  handle('artwork:apply-official', (_event, mediaId: string, candidate: OfficialMetadataCandidate, target?: OfficialMetadataApplyTarget) => {
    deps.authorizeSettingsWrite();
    return deps.applyOfficialMetadataCandidate(mediaId, candidate, target);
  });
  handle('artwork:refresh-official', (_event, mediaId: string, target?: OfficialArtworkRefreshTarget) => {
    deps.authorizeSettingsWrite();
    return deps.refreshOfficialArtwork(mediaId, target);
  });
  handle('artwork:playback-logo', (_event, mediaId: string) => deps.getPlaybackLogo(mediaId));
  handle('artwork:import', (_event, entries: Record<string, Record<string, string>>) => {
    deps.authorizeSettingsWrite();
    deps.importCustomArtwork(entries || {});
    return true;
  });
  handle('database:backup', () => { deps.authorizeSettingsWrite(); return deps.backupDatabase(); });
  handle('database:clear', () => { deps.authorizeSettingsWrite(); return deps.libraryForRenderer(deps.clearAppData()); });
  handle('shell:open-external', (_event, url: string): OpenExternalResult => {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only http and https links can be opened externally.');
    }
    return shell.openExternal(parsed.toString());
  });
  const openFolderPath = (filePath: string) => {
    const target = String(filePath || '').trim();
    if (!target) throw new Error('A local path is required.');
    if (/^[a-z]+:\/\//i.test(target)) throw new Error('Only local paths can be opened in the file manager.');
    if (!fs.existsSync(target)) throw new Error('That file path could not be found.');
    shell.showItemInFolder(path.resolve(target));
    return true;
  };
  handle('shell:open-folder-path', (_event, filePath: string) => openFolderPath(filePath));
  handle('shell:show-item', (_event, filePath: string) => openFolderPath(filePath));
  handle('updates:get-state', () => deps.getUpdateState());
  handle('updates:check', () => deps.checkForUpdates());
  handle('updates:install', () => {
    const updateState = deps.getUpdateState();
    if (updateState.status !== 'downloaded') return updateState;
    return deps.installDownloadedUpdate();
  });

  handle('media:ffmpeg-available', () => ffmpegAvailability(deps.findFFmpeg));

  handle('media:probe', (_event, filePath: string) => deps.safeResult(() => {
    deps.authorizeMediaPath(filePath);
    return deps.probeMedia(filePath);
  }));

  handle('media:can-direct-play', (_event, filePath: string, backend: 'html5' | 'hls' = 'html5') =>
    deps.safeResult(async () => {
      deps.authorizeMediaPath(filePath);
      if (backend === 'html5') return deps.browserPlaybackPlan(filePath).mode === 'direct';
      const result = await deps.probeMedia(filePath);
      return deps.canDirectPlay(filePath, result, backend);
    }),
  );

  handle('media:start-transcode', (_event, filePath: string, options?: TranscodeOptions) =>
    deps.safeResult(async () => {
      deps.authorizeMediaPath(filePath);
      const session = await deps.startTranscode(filePath, options || {}, `http://127.0.0.1:${deps.getMediaServerPort()}`);
      return { ...session, playlistUrl: deps.appendLocalAccessTokenToUrl(session.playlistUrl) };
    }),
  );
  handle('media:stop-transcode', (_event, sessionId: string) => deps.safeResult(() => deps.stopTranscode(sessionId)));
}
