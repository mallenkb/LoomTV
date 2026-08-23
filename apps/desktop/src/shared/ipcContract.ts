import type {
  ApiResult,
  LibraryFolderKind,
  LibraryIndexPayload,
  LibraryItemDetailsPayload,
  LibraryPayload,
  LibraryScanMode,
  LocalNetworkPairedDevice,
  LocalNetworkPeer,
  LocalNetworkStatus,
  LocalSegmentAnalysisStatus,
  MpvAvailability,
  MpvCommand,
  MpvPlaybackState,
  MpvStartOptions,
  ManualMediaSegmentInput,
  ManagedMediaSegment,
  MediaSegmentRequest,
  MediaSegmentResponse,
  MediaSegmentType,
  MetadataApiKeys,
  MetadataKeyTestResult,
  MetadataProviderRequest,
  OfficialArtworkResult,
  OfficialArtworkRefreshTarget,
  OfficialMetadataApplyTarget,
  OfficialMetadataCandidate,
  ActiveProfileState,
  PlaybackLogoResult,
  PlaybackTrackPreferences,
  ProfileListEntry,
  ProfileListKind,
  ProfilePreferences,
  ProfileRestrictions,
  ProfileCreateInput,
  ProfileSummary,
  ProfileTransferResult,
  ProfileUpdateInput,
  RemoteLibraryConnection,
  RemoteLibraryRequest,
  RemoteLibraryResponse,
  RemoteLibrarySessionState,
  StreamingProvider,
  RendererSession,
  SettingsPayload,
  SkipAnalysisRunScope,
  StoredProgress,
  StremioPluginCatalogRequest,
  StremioPluginCatalogResult,
  StremioPluginConfigurationState,
  StremioPluginAuditEntry,
  StremioPluginIpcResult,
  StremioPluginMetaRequest,
  StremioPluginMetaResult,
  StremioPluginReview,
  StremioPluginSummary,
  OfficialStremioAddon,
  StreamUrlOptions,
  StreamUrlResult,
  TranscodeOptions,
  TranscodeSession,
  UnifiedDesktopServerState,
  UpdateState,
} from './desktopProtocol.ts';

type ImportedProgress = Record<string, number | { position?: number; duration?: number; updatedAt?: number }>;

export interface IpcContract {
  'artwork:apply-official': { args: [mediaId: string, candidate: OfficialMetadataCandidate, target?: OfficialMetadataApplyTarget]; result: OfficialArtworkResult };
  'artwork:get': { args: [mediaId: string]; result: Record<string, string> };
  'artwork:import': { args: [entries: Record<string, Record<string, string>>]; result: boolean };
  'artwork:official-candidates': { args: [mediaId: string]; result: OfficialMetadataCandidate[] };
  'artwork:playback-logo': { args: [mediaId: string]; result: PlaybackLogoResult };
  'artwork:refresh-official': { args: [mediaId: string, target?: OfficialArtworkRefreshTarget]; result: OfficialArtworkResult };
  'artwork:save': { args: [mediaId: string, target: string, dataUrl: string]; result: Record<string, string> };
  'database:backup': { args: []; result: { ok: boolean; path?: string; error?: string } };
  'database:clear': { args: []; result: LibraryIndexPayload };
  'library:add-folder': { args: [kind?: LibraryFolderKind]; result: LibraryIndexPayload | null };
  'library:add-folder-path': { args: [kind: LibraryFolderKind, folderPath: string]; result: LibraryIndexPayload };
  'library:get': { args: []; result: LibraryPayload };
  'library:get-index': { args: []; result: LibraryIndexPayload };
  'library:get-item': { args: [mediaId: string]; result: LibraryItemDetailsPayload | null };
  'library:pick-folder': { args: [currentPath?: string]; result: string | null };
  'library:remove-folder': { args: [folderPath: string]; result: LibraryIndexPayload };
  'library:update-folder': { args: [folderPath: string, nextFolderPath: string, kind: LibraryFolderKind]; result: LibraryIndexPayload };
  'library:scan': { args: [options?: { force?: boolean; mode?: LibraryScanMode }]; result: LibraryIndexPayload };
  'media:can-direct-play': { args: [filePath: string, backend?: 'html5' | 'hls']; result: ApiResult<boolean> };
  'media:ffmpeg-available': { args: []; result: { available: boolean; path: string | null } };
  'media:get-file-info': { args: [filePath: string]; result: { size: number; path: string; exists: boolean } };
  'media:get-server-port': { args: []; result: number };
  'media:get-stream-url': { args: [filePath: string, options?: StreamUrlOptions]; result: StreamUrlResult };
  'media:get-subtitle-url': { args: [filePath: string, streamOrdinal?: number]; result: { url: string } };
  'media:get-thumbnail': { args: [filePath: string, time?: string]; result: { url: string } };
  'media:play': { args: [filePath: string]; result: boolean };
  'media:probe': { args: [filePath: string]; result: ApiResult<unknown> };
  'media:start-transcode': { args: [filePath: string, options?: TranscodeOptions]; result: ApiResult<TranscodeSession> };
  'media:stop-transcode': { args: [sessionId: string]; result: ApiResult<boolean> };
  'metadata:test-keys': { args: [keys: MetadataApiKeys]; result: MetadataKeyTestResult[] };
  'metadata:refresh-incomplete': { args: [mediaId: string]; result: boolean };
  'metadata:provider-request': { args: [request: MetadataProviderRequest]; result: unknown };
  'metadata:streaming-providers': { args: [mediaId: string]; result: StreamingProvider[] };
  'mpv:availability': { args: []; result: MpvAvailability };
  'mpv:choose-executable': { args: []; result: MpvAvailability };
  'mpv:reset-executable': { args: []; result: MpvAvailability };
  'mpv:refresh-availability': { args: []; result: MpvAvailability };
  'mpv:start': { args: [filePath: string, options?: MpvStartOptions]; result: { ok: boolean; sessionId?: string; error?: string } };
  'mpv:command': { args: [sessionId: string, command: MpvCommand]; result: boolean };
  'mpv:stop': { args: [sessionId: string]; result: boolean };
  'network:discover-peers': { args: [timeoutMs?: number]; result: LocalNetworkPeer[] };
  'network:remote-connect': { args: [baseUrl: string, code: string, certFingerprint?: string]; result: RemoteLibraryConnection };
  'network:remote-disconnect': { args: [revoke?: boolean]; result: boolean };
  'network:remote-request': { args: [pathname: string, request?: RemoteLibraryRequest]; result: RemoteLibraryResponse };
  'network:remote-session': { args: []; result: RemoteLibrarySessionState };
  'network:revoke-paired-device': { args: [deviceId: string]; result: LocalNetworkPairedDevice[] };
  'network:set-device-name': { args: [name: string]; result: string };
  'network:status': { args: []; result: LocalNetworkStatus };
  'playback-track-preferences:get': { args: [scope?: string]; result: PlaybackTrackPreferences | Record<string, PlaybackTrackPreferences> };
  'playback-track-preferences:save': { args: [scope: string, preferences: PlaybackTrackPreferences, expectedProfileId?: string]; result: PlaybackTrackPreferences };
  'playback:activity': { args: [key: string, active: boolean, label?: string]; result: boolean };
  'playback:analysis:season': { args: [mediaId: string, season: number]; result: MediaSegmentResponse };
  'playback:analysis:status': { args: []; result: LocalSegmentAnalysisStatus };
  'playback:analysis:run': { args: [scope?: SkipAnalysisRunScope]; result: { queued: number } };
  'playback:analysis:cancel': { args: [request?: { jobKey?: string; kind?: 'manual' }]; result: { cancelled: number } };
  'playback:analysis:pause': { args: []; result: boolean };
  'playback:analysis:resume': { args: []; result: boolean };
  'playback:analysis:cleanup': { args: []; result: { queued: number } };
  'playback:analysis:rebuild': { args: []; result: { removed: number; queued: number } };
  'playback:segments:delete-manual': { args: [input: MediaSegmentRequest & { candidateId?: string; type: MediaSegmentType }]; result: MediaSegmentResponse };
  'playback:segments:get': { args: [request: MediaSegmentRequest]; result: MediaSegmentResponse };
  'playback:segments:save-manual': { args: [input: ManualMediaSegmentInput]; result: MediaSegmentResponse };
  'playback:segments:undo-manual': { args: [input: MediaSegmentRequest & { candidateId?: string; type: MediaSegmentType }]; result: MediaSegmentResponse };
  'playback:segments:manage-list': { args: [request?: Partial<MediaSegmentRequest>]; result: ManagedMediaSegment[] };
  'playback:segments:manage-update': { args: [candidateId: string, patch: { status?: 'active' | 'review' | 'rejected'; type?: MediaSegmentType }]; result: boolean };
  'playback:segments:manage-erase': { args: [request: MediaSegmentRequest]; result: { removed: number } };
  'profiles:create': { args: [input: ProfileCreateInput]; result: ProfileSummary[] };
  'profiles:delete': { args: [profileId: string]; result: ProfileSummary[] };
  'profiles:export': { args: [profileId: string]; result: ProfileTransferResult };
  'profiles:get-active': { args: []; result: ActiveProfileState };
  'profiles:lock': { args: []; result: ActiveProfileState };
  'profiles:list': { args: []; result: ProfileSummary[] };
  'profiles:choose-avatar': { args: []; result: string | null };
  'profiles:import': { args: []; result: ProfileTransferResult };
  'profiles:pin': { args: [profileId: string, pin: string | null]; result: ProfileSummary };
  'profiles:reorder': { args: [profileIds: string[]]; result: ProfileSummary[] };
  'profiles:reset-owner': { args: [confirmation: string]; result: ProfileSummary };
  'profiles:select': { args: [profileId: string, pin?: string]; result: ProfileSummary };
  'profiles:select-guest': { args: []; result: ProfileSummary };
  'profiles:set-auto-sign-in': { args: [enabled: boolean]; result: ActiveProfileState };
  'profiles:update': { args: [profileId: string, patch: ProfileUpdateInput]; result: ProfileSummary[] };
  'profile-preferences:get': { args: []; result: ProfilePreferences };
  'profile-preferences:save': { args: [patch: ProfilePreferences, expectedProfileId?: string]; result: ProfilePreferences };
  'profile-restrictions:get': { args: [profileId: string]; result: ProfileRestrictions };
  'profile-restrictions:save': { args: [profileId: string, restrictions: Omit<ProfileRestrictions, 'revision'>]; result: ProfileRestrictions };
  'profile-lists:get': { args: [kind?: ProfileListKind]; result: ProfileListEntry[] };
  'profile-lists:set': { args: [mediaId: string, kind: ProfileListKind, present: boolean, expectedProfileId?: string]; result: ProfileListEntry[] };
  'progress:get': { args: [filePath?: string]; result: Record<string, StoredProgress> | StoredProgress | null };
  'progress:import': { args: [progress: ImportedProgress, expectedProfileId?: string]; result: boolean };
  'progress:save': { args: [filePath: string, position: number, duration: number, expectedProfileId?: string]; result: StoredProgress };
  'renderer:session': { args: []; result: RendererSession };
  'plugins:stremio:list': { args: []; result: StremioPluginIpcResult<StremioPluginSummary[]> };
  'plugins:stremio:available': { args: []; result: StremioPluginIpcResult<StremioPluginSummary[]> };
  'plugins:stremio:official': { args: []; result: StremioPluginIpcResult<OfficialStremioAddon[]> };
  'plugins:stremio:review-official': { args: [officialId: OfficialStremioAddon['id']]; result: StremioPluginIpcResult<StremioPluginReview> };
  'plugins:stremio:review-url': { args: [manifestUrl: string]; result: StremioPluginIpcResult<StremioPluginReview> };
  'plugins:stremio:approve': { args: [addonId: string, reviewToken: string]; result: StremioPluginIpcResult<StremioPluginSummary> };
  'plugins:stremio:disable': { args: [addonId: string]; result: StremioPluginIpcResult<StremioPluginSummary> };
  'plugins:stremio:remove': { args: [addonId: string]; result: StremioPluginIpcResult<boolean> };
  'plugins:stremio:profile-access': { args: [profileId: string]; result: StremioPluginIpcResult<string[]> };
  'plugins:stremio:set-profile-access': { args: [profileId: string, addonId: string, enabled: boolean]; result: StremioPluginIpcResult<boolean> };
  'plugins:stremio:catalog': { args: [addonId: string, request: StremioPluginCatalogRequest]; result: StremioPluginIpcResult<StremioPluginCatalogResult> };
  'plugins:stremio:meta': { args: [addonId: string, request: StremioPluginMetaRequest]; result: StremioPluginIpcResult<StremioPluginMetaResult> };
  'plugins:stremio:meta-item': { args: [request: StremioPluginMetaRequest]; result: StremioPluginIpcResult<StremioPluginMetaResult> };
  'plugins:stremio:configuration': { args: [addonId: string]; result: StremioPluginIpcResult<StremioPluginConfigurationState> };
  'plugins:stremio:save-configuration': { args: [addonId: string, values: Record<string, unknown>]; result: StremioPluginIpcResult<StremioPluginConfigurationState> };
  'plugins:stremio:audit': { args: [addonId: string, limit?: number]; result: StremioPluginIpcResult<readonly StremioPluginAuditEntry[]> };
  'settings:get': { args: []; result: SettingsPayload };
  'settings:save': { args: [settings: SettingsPayload]; result: boolean };
  'server:unified-state': { args: []; result: UnifiedDesktopServerState };
  'server:configure-owner': { args: [input: { name: string; password: string }]; result: UnifiedDesktopServerState };
  'server:open-admin': { args: []; result: boolean };
  'shell:open-external': { args: [url: string]; result: void };
  'shell:open-folder-path': { args: [filePath: string]; result: boolean };
  'shell:show-item': { args: [filePath: string]; result: boolean };
  'updates:check': { args: []; result: UpdateState };
  'updates:get-state': { args: []; result: UpdateState };
  'updates:install': { args: []; result: UpdateState };
}

export type IpcInvokeChannel = keyof IpcContract;

export interface IpcEventContract {
  'playback:system-media-key': { args: [action: 'play-pause' | 'previous-track' | 'next-track'] };
  'library:scan-progress': { args: [progress: import('./desktopProtocol.ts').LibraryScanProgress] };
  'profile:active-changed': { args: [state: ActiveProfileState] };
  'profiles:changed': { args: [event: import('./desktopProtocol.ts').ProfilesChangedEvent] };
  'updates:state': { args: [state: UpdateState] };
  'mpv:state': { args: [state: MpvPlaybackState] };
}

export type IpcEventChannel = keyof IpcEventContract;
