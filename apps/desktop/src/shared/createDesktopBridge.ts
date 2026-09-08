import type {
  DesktopBridgeApi,
  LibVlcPlaybackState,
} from '../lib/desktopApi';
import type { PlaybackCommand, PlaybackStartOptions, PlaybackViewport } from './playbackProtocol';
import type {
  MediaSessionCommand,
  MediaSessionDiagnostics,
  MediaSessionSnapshot,
} from './mediaControlProtocol';
import type {
  LibraryIndexPayload,
  LibraryItemDetailsPayload,
  LibraryScanMode,
  LibraryScanProgress,
  IptvChannelRequest,
  IptvSourceInput,
  IptvSourcePatch,
  ManualMediaSegmentInput,
  MediaSegmentRequest,
  MediaSegmentType,
  MetadataProviderRequest,
  MpvCommand,
  MpvPlaybackState,
  MpvStartOptions,
  OfficialMetadataCandidate,
  OfficialMetadataApplyTarget,
  OfficialArtworkRefreshTarget,
  OfficialStremioAddon,
  PlaybackTrackPreferences,
  ProfileListKind,
  ProfilePreferences,
  ProfileRestrictions,
  ProfilesChangedEvent,
  ProfileCreateInput,
  ProfileUpdateInput,
  RemoteLibraryRequest,
  StremioPluginCatalogRequest,
  StremioPluginMetaRequest,
  SubtitleStyleOptions,
  TranscodeOptions,
  UpdateState,
} from './desktopProtocol.ts';
import type { IpcEventChannel, IpcInvokeChannel } from './ipcChannels';
import type { IpcContract, IpcEventContract } from './ipcContract';

type CompactLibraryBridgeApi = {
  getLibraryIndex: () => Promise<LibraryIndexPayload>;
  getLibraryItem: (mediaId: string) => Promise<LibraryItemDetailsPayload | null>;
};

export interface DesktopTransport {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

/** Both shells use the same argument defaults, event transforms, and result mapping. */
export function createDesktopBridge(electronIpcRenderer: DesktopTransport) {
const ipcRenderer = {
  invoke<C extends IpcInvokeChannel>(channel: C, ...args: IpcContract[C]['args']): Promise<IpcContract[C]['result']> {
    return electronIpcRenderer.invoke(channel, ...args) as Promise<IpcContract[C]['result']>;
  },
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (event: unknown, ...args: IpcEventContract[C]['args']) => void,
  ): void {
    electronIpcRenderer.on(channel, listener as Parameters<typeof electronIpcRenderer.on>[1]);
  },
  removeListener<C extends IpcEventChannel>(
    channel: C,
    listener: (event: unknown, ...args: IpcEventContract[C]['args']) => void,
  ): void {
    electronIpcRenderer.removeListener(channel, listener as Parameters<typeof electronIpcRenderer.removeListener>[1]);
  },
};

// ─── desktopApi — existing library/media/settings surface ────────────────────

const desktopApi = {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  getLibraryIndex: () => ipcRenderer.invoke('library:get-index'),
  getLibraryItem: (mediaId: string) => ipcRenderer.invoke('library:get-item', mediaId),
  scanLibrary: (options?: { force?: boolean; mode?: LibraryScanMode }) => ipcRenderer.invoke('library:scan', options),
  onLibraryScanProgress: (callback: (progress: LibraryScanProgress) => void) => {
    const handler = (
      _: unknown,
      progress: LibraryScanProgress,
    ) => callback(progress);
    ipcRenderer.on('library:scan-progress', handler);
    return () => ipcRenderer.removeListener('library:scan-progress', handler);
  },
  addLibraryFolder: (kind?: 'movies' | 'tvShows' | 'anime' | 'others') => ipcRenderer.invoke('library:add-folder', kind),
  addLibraryFolderPath: (kind: 'movies' | 'tvShows' | 'anime' | 'others', folderPath: string) => ipcRenderer.invoke('library:add-folder-path', kind, folderPath),
  pickLibraryFolder: (currentPath?: string) => ipcRenderer.invoke('library:pick-folder', currentPath),
  removeLibraryFolder: (folderPath: string) => ipcRenderer.invoke('library:remove-folder', folderPath),
  updateLibraryFolder: (folderPath: string, nextFolderPath: string, kind: 'movies' | 'tvShows' | 'anime' | 'others') => ipcRenderer.invoke('library:update-folder', folderPath, nextFolderPath, kind),
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
  getRendererSession: () => ipcRenderer.invoke('renderer:session'),
  setFullscreen: (enabled: boolean) => ipcRenderer.invoke('window:set-fullscreen', enabled),
  setWindowChromeVisible: (visible: boolean) => ipcRenderer.invoke('window:set-chrome-visible', visible),
  onFullscreenChanged: (callback: (fullscreen: boolean) => void) => {
    const handler = (_: unknown, fullscreen: boolean) => callback(fullscreen);
    ipcRenderer.on('window:fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', handler);
  },
  publishMediaSession: (snapshot: MediaSessionSnapshot): Promise<MediaSessionDiagnostics> =>
    ipcRenderer.invoke('media-control:publish', snapshot),
  releaseMediaSession: () => ipcRenderer.invoke('media-control:release'),
  onMediaSessionCommand: (
    callback: (command: MediaSessionCommand, handledInMain: boolean) => void,
  ) => {
    const handler = (
      _: unknown,
      command: MediaSessionCommand,
      handledInMain: boolean,
    ) => callback(command, handledInMain);
    ipcRenderer.on('media-control:command', handler);
    return () => ipcRenderer.removeListener('media-control:command', handler);
  },
  checkFFmpeg: () => ipcRenderer.invoke('media:ffmpeg-available'),
  listIptvSources: () => ipcRenderer.invoke('iptv:list-sources'),
  addIptvSource: (input: IptvSourceInput) => ipcRenderer.invoke('iptv:add-source', input),
  updateIptvSource: (sourceId: string, patch: IptvSourcePatch) =>
    ipcRenderer.invoke('iptv:update-source', sourceId, patch),
  removeIptvSource: (sourceId: string) => ipcRenderer.invoke('iptv:remove-source', sourceId),
  refreshIptvSource: (sourceId: string) => ipcRenderer.invoke('iptv:refresh-source', sourceId),
  listIptvChannels: (request: IptvChannelRequest) => ipcRenderer.invoke('iptv:list-channels', request),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  listStremioPlugins: () => ipcRenderer.invoke('plugins:stremio:list'),
  listAvailableStremioPlugins: () => ipcRenderer.invoke('plugins:stremio:available'),
  listOfficialStremioAddons: () => ipcRenderer.invoke('plugins:stremio:official'),
  reviewOfficialStremioAddon: (officialId: OfficialStremioAddon['id']) =>
    ipcRenderer.invoke('plugins:stremio:review-official', officialId),
  reviewStremioManifestUrl: (manifestUrl: string) =>
    ipcRenderer.invoke('plugins:stremio:review-url', manifestUrl),
  reviewInstalledStremioAddon: (addonId: string) =>
    ipcRenderer.invoke('plugins:stremio:review-installed', addonId),
  approveStremioAddon: (addonId: string, reviewToken: string) =>
    ipcRenderer.invoke('plugins:stremio:approve', addonId, reviewToken),
  disableStremioAddon: (addonId: string) =>
    ipcRenderer.invoke('plugins:stremio:disable', addonId),
  removeStremioAddon: (addonId: string) =>
    ipcRenderer.invoke('plugins:stremio:remove', addonId),
  listStremioProfileAccess: (profileId: string) =>
    ipcRenderer.invoke('plugins:stremio:profile-access', profileId),
  setStremioProfileAccess: (profileId: string, addonId: string, enabled: boolean) =>
    ipcRenderer.invoke('plugins:stremio:set-profile-access', profileId, addonId, enabled),
  getStremioCatalog: (addonId: string, request: StremioPluginCatalogRequest) =>
    ipcRenderer.invoke('plugins:stremio:catalog', addonId, request),
  getStremioMeta: (addonId: string, request: StremioPluginMetaRequest) =>
    ipcRenderer.invoke('plugins:stremio:meta', addonId, request),
  getStremioMetaByItem: (request: StremioPluginMetaRequest) =>
    ipcRenderer.invoke('plugins:stremio:meta-item', request),
  getStremioStreams: (addonId: string, request: import('./desktopProtocol.ts').StremioStreamRequest) =>
    ipcRenderer.invoke('plugins:stremio:streams', addonId, request),
  getStremioAddonConfiguration: (addonId: string) =>
    ipcRenderer.invoke('plugins:stremio:configuration', addonId),
  saveStremioAddonConfiguration: (addonId: string, values: Record<string, unknown>) =>
    ipcRenderer.invoke('plugins:stremio:save-configuration', addonId, values),
  listStremioPluginAudit: (addonId: string, limit?: number) =>
    ipcRenderer.invoke('plugins:stremio:audit', addonId, limit),
  saveSettings: (settings: {
    omdbApiKey?: string;
    tmdbApiKey?: string;
    metadataApiKeys?: Record<string, string>;
    metadataOfflineMode?: boolean;
    openSubtitlesUsername?: string;
    openSubtitlesPassword?: string;
    openSubtitlesLanguages?: string;
    openSubtitlesAutoDownload?: boolean;
    autoSyncIntervalHours?: number;
    playbackSkipBackSeconds?: number;
    playbackSkipForwardSeconds?: number;
    playbackDisplaySleepTimeoutMinutes?: number;
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
  connectRemoteLibrary: (baseUrl: string, code: string, certFingerprint?: string) =>
    ipcRenderer.invoke('network:remote-connect', baseUrl, code, certFingerprint),
  remoteLibraryRequest: (pathname: string, request?: RemoteLibraryRequest) => ipcRenderer.invoke('network:remote-request', pathname, request),
  getRemoteLibrarySession: () => ipcRenderer.invoke('network:remote-session'),
  disconnectRemoteLibrary: (revoke?: boolean) => ipcRenderer.invoke('network:remote-disconnect', revoke),
  revokePairedDevice: (deviceId: string) => ipcRenderer.invoke('network:revoke-paired-device', deviceId),
  setLocalNetworkDeviceName: (name: string) => ipcRenderer.invoke('network:set-device-name', name),
  getUnifiedDesktopServerState: () => ipcRenderer.invoke('server:unified-state'),
  configureUnifiedDesktopOwner: (input: { name: string; password: string }) => ipcRenderer.invoke('server:configure-owner', input),
  openUnifiedDesktopAdmin: () => ipcRenderer.invoke('server:open-admin'),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  chooseProfileAvatar: () => ipcRenderer.invoke('profiles:choose-avatar'),
  getActiveProfileState: () => ipcRenderer.invoke('profiles:get-active'),
  createProfile: (input: ProfileCreateInput) => ipcRenderer.invoke('profiles:create', input),
  updateProfile: (profileId: string, patch: ProfileUpdateInput) => ipcRenderer.invoke('profiles:update', profileId, patch),
  deleteProfile: (profileId: string) => ipcRenderer.invoke('profiles:delete', profileId),
  exportProfile: (profileId: string) => ipcRenderer.invoke('profiles:export', profileId),
  importProfile: () => ipcRenderer.invoke('profiles:import'),
  selectProfile: (profileId: string, pin?: string) => ipcRenderer.invoke('profiles:select', profileId, pin),
  selectGuestProfile: () => ipcRenderer.invoke('profiles:select-guest'),
  lockProfile: () => ipcRenderer.invoke('profiles:lock'),
  reorderProfiles: (profileIds: string[]) => ipcRenderer.invoke('profiles:reorder', profileIds),
  changeProfilePin: (profileId: string, pin: string | null) => ipcRenderer.invoke('profiles:pin', profileId, pin),
  resetOwnerProfile: (confirmation: string) => ipcRenderer.invoke('profiles:reset-owner', confirmation),
  setAutomaticProfileSignIn: (enabled: boolean) => ipcRenderer.invoke('profiles:set-auto-sign-in', enabled),
  getProfilePreferences: () => ipcRenderer.invoke('profile-preferences:get'),
  saveProfilePreferences: (patch: ProfilePreferences, expectedProfileId?: string) => ipcRenderer.invoke('profile-preferences:save', patch, expectedProfileId),
  getProfileRestrictions: (profileId: string) => ipcRenderer.invoke('profile-restrictions:get', profileId),
  saveProfileRestrictions: (profileId: string, restrictions: Omit<ProfileRestrictions, 'revision'>) =>
    ipcRenderer.invoke('profile-restrictions:save', profileId, restrictions),
  getProfileLists: (kind?: ProfileListKind) => ipcRenderer.invoke('profile-lists:get', kind),
  setProfileListEntry: (mediaId: string, kind: ProfileListKind, present: boolean, expectedProfileId?: string) =>
    ipcRenderer.invoke('profile-lists:set', mediaId, kind, present, expectedProfileId),
  onProfilesChanged: (callback: (event: ProfilesChangedEvent) => void) => {
    const handler = (_: unknown, event: ProfilesChangedEvent) => callback(event);
    ipcRenderer.on('profiles:changed', handler);
    return () => ipcRenderer.removeListener('profiles:changed', handler);
  },
  onActiveProfileChanged: (callback) => {
    const handler = (_: unknown, state: import('./desktopProtocol.ts').ActiveProfileState) => callback(state);
    ipcRenderer.on('profile:active-changed', handler);
    return () => ipcRenderer.removeListener('profile:active-changed', handler);
  },
  getProgress: (filePath?: string) => ipcRenderer.invoke('progress:get', filePath),
  saveProgress: (filePath: string, position: number, duration: number, expectedProfileId?: string) =>
    ipcRenderer.invoke('progress:save', filePath, position, duration, expectedProfileId),
  importProgress: (progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>, expectedProfileId?: string) =>
    ipcRenderer.invoke('progress:import', progress, expectedProfileId),
  getPlaybackTrackPreferences: (scope?: string) => ipcRenderer.invoke('playback-track-preferences:get', scope),
  savePlaybackTrackPreferences: (scope: string, preferences: PlaybackTrackPreferences, expectedProfileId?: string) =>
    ipcRenderer.invoke('playback-track-preferences:save', scope, preferences, expectedProfileId),
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
  applyOfficialMetadata: (mediaId: string, candidate: OfficialMetadataCandidate, target?: OfficialMetadataApplyTarget) =>
    ipcRenderer.invoke('artwork:apply-official', mediaId, candidate, target),
  refreshOfficialArtwork: (mediaId: string, target?: OfficialArtworkRefreshTarget) => ipcRenderer.invoke('artwork:refresh-official', mediaId, target),
  getPlaybackLogo: (mediaId: string) => ipcRenderer.invoke('artwork:playback-logo', mediaId),
  refreshIncompleteMetadata: (mediaId: string) => ipcRenderer.invoke('metadata:refresh-incomplete', mediaId),
  requestMetadataProvider: (request: MetadataProviderRequest) => ipcRenderer.invoke('metadata:provider-request', request),
  getStreamingProviders: (mediaId: string) => ipcRenderer.invoke('metadata:streaming-providers', mediaId),
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
    const handler = (_: unknown, state: UpdateState) => callback(state);
    ipcRenderer.on('updates:state', handler);
    return () => ipcRenderer.removeListener('updates:state', handler);
  },

  mpv: {
    availability: () => ipcRenderer.invoke('mpv:availability'),
    chooseExecutable: () => ipcRenderer.invoke('mpv:choose-executable'),
    resetExecutable: () => ipcRenderer.invoke('mpv:reset-executable'),
    refreshAvailability: () => ipcRenderer.invoke('mpv:refresh-availability'),
    start: (filePath: string, options?: MpvStartOptions) => ipcRenderer.invoke('mpv:start', filePath, options || {}),
    command: (sessionId: string, command: MpvCommand) => ipcRenderer.invoke('mpv:command', sessionId, command),
    stop: (sessionId: string) => ipcRenderer.invoke('mpv:stop', sessionId),
    onState: (callback: (state: MpvPlaybackState) => void) => {
      const handler = (_: unknown, state: MpvPlaybackState) => callback(state);
      ipcRenderer.on('mpv:state', handler);
      return () => ipcRenderer.removeListener('mpv:state', handler);
    },
  },

  libvlc: {
    availability: () => ipcRenderer.invoke('libvlc:availability'),
    refreshAvailability: () => ipcRenderer.invoke('libvlc:refresh-availability'),
    start: (filePath: string, options?: PlaybackStartOptions) =>
      ipcRenderer.invoke('libvlc:start', filePath, options || {}),
    command: (sessionId: string, command: PlaybackCommand) =>
      ipcRenderer.invoke('libvlc:command', sessionId, command),
    stop: (sessionId: string) => ipcRenderer.invoke('libvlc:stop', sessionId),
    syncSurface: () => ipcRenderer.invoke('libvlc:sync-surface'),
    setFullscreenTransition: (transitioning: boolean, waitForFinalViewport = true) =>
      ipcRenderer.invoke('libvlc:set-fullscreen-transition', transitioning, waitForFinalViewport),
    setViewport: (viewport: PlaybackViewport) => ipcRenderer.invoke('libvlc:set-viewport', viewport),
    onState: (callback: (state: LibVlcPlaybackState) => void) => {
      const handler = (_: unknown, state: LibVlcPlaybackState) => callback(state);
      ipcRenderer.on('libvlc:state', handler);
      return () => ipcRenderer.removeListener('libvlc:state', handler);
    },
  },

  media: {
    probe: (filePath: string) => ipcRenderer.invoke('media:probe', filePath),
    canDirectPlay: (filePath: string, backend: 'html5' | 'hls' = 'html5') => ipcRenderer.invoke('media:can-direct-play', filePath, backend),
    startTranscode: (filePath: string, options?: TranscodeOptions) =>
      ipcRenderer.invoke('media:start-transcode', filePath, options || {}),
    stopTranscode: (sessionId: string) => ipcRenderer.invoke('media:stop-transcode', sessionId),
  },
} satisfies DesktopBridgeApi & CompactLibraryBridgeApi;


return desktopApi;
}
