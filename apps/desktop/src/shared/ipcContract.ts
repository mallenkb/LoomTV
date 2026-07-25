import type {
  ApiResult,
  LibraryFolderKind,
  LibraryPayload,
  LibraryScanMode,
  LocalNetworkPairedDevice,
  LocalNetworkPeer,
  LocalNetworkStatus,
  LocalSegmentAnalysisStatus,
  ManualMediaSegmentInput,
  ManagedMediaSegment,
  MediaSegmentRequest,
  MediaSegmentResponse,
  MediaSegmentType,
  MetadataApiKeys,
  MetadataKeyTestResult,
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
  SettingsPayload,
  SkipAnalysisRunScope,
  StoredProgress,
  StreamUrlOptions,
  StreamUrlResult,
  TranscodeOptions,
  TranscodeSession,
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
  'database:clear': { args: []; result: LibraryPayload };
  'library:add-folder': { args: [kind?: LibraryFolderKind]; result: LibraryPayload | null };
  'library:get': { args: []; result: LibraryPayload };
  'library:remove-folder': { args: [folderPath: string]; result: LibraryPayload };
  'library:scan': { args: [options?: { force?: boolean; mode?: LibraryScanMode }]; result: LibraryPayload };
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
  'network:discover-peers': { args: [timeoutMs?: number]; result: LocalNetworkPeer[] };
  'network:remote-connect': { args: [baseUrl: string, code: string]; result: RemoteLibraryConnection };
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
  'settings:get': { args: []; result: SettingsPayload };
  'settings:save': { args: [settings: SettingsPayload]; result: boolean };
  'shell:open-external': { args: [url: string]; result: void };
  'shell:open-folder-path': { args: [filePath: string]; result: boolean };
  'shell:show-item': { args: [filePath: string]; result: boolean };
  'updates:check': { args: []; result: UpdateState };
  'updates:get-state': { args: []; result: UpdateState };
  'updates:install': { args: []; result: UpdateState };
}

export type IpcInvokeChannel = keyof IpcContract;

export interface IpcEventContract {
  'library:scan-progress': { args: [library: LibraryPayload, progress: import('./desktopProtocol.ts').LibraryScanProgress] };
  'profile:active-changed': { args: [state: ActiveProfileState] };
  'profiles:changed': { args: [event: import('./desktopProtocol.ts').ProfilesChangedEvent] };
  'updates:state': { args: [state: UpdateState] };
}

export type IpcEventChannel = keyof IpcEventContract;
