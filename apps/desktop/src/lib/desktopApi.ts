import packageJson from '../../package.json';
import type {
  ActiveProfileState,
  ApiResult,
  ProfileCreateInput,
  ProfileListEntry,
  ProfileListKind,
  ProfilePreferences,
  ProfileRestrictions,
  ProfilesChangedEvent,
  ProfileSummary,
  ProfileTransferResult,
  ProfileUpdateInput,
  FFmpegStatus,
  LibraryFolderKind,
  LibraryIndexPayload,
  LibraryItemDetailsPayload,
  LibraryPayload,
  LibraryScanMode,
  LibraryScanProgress,
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
  StreamingProvider,
  OfficialArtworkResult,
  OfficialArtworkRefreshTarget,
  OfficialMetadataApplyTarget,
  OfficialMetadataCandidate,
  OfficialStremioAddon,
  PlaybackLogoResult,
  PlaybackCapabilities,
  PlaybackPlanResponse,
  PlaybackMode,
  PlaybackTrackPreferences,
  RemoteLibraryConnection,
  RemoteLibraryRequest,
  RemoteLibraryResponse,
  RemoteLibrarySessionState,
  RendererSession,
  SettingsPayload,
  SkipAnalysisRunScope,
  StoredProgress,
  StreamUrlOptions,
  StreamUrlResult,
  StremioPluginCatalogRequest,
  StremioPluginCatalogResult,
  StremioPluginConfigurationState,
  StremioPluginAuditEntry,
  StremioPluginIpcError as StremioPluginIpcErrorPayload,
  StremioPluginIpcIssue,
  StremioPluginIpcResult,
  StremioPluginMetaRequest,
  StremioPluginMetaResult,
  StremioPluginReview,
  StremioPluginSummary,
  TranscodeOptions,
  TranscodeSession,
  UnifiedDesktopServerState,
  UpdateState,
} from '../shared/desktopProtocol.ts';
import type { PlaybackCommand, PlaybackStartOptions, PlaybackState, PlaybackViewport } from '../shared/playbackProtocol';
import {
  clearDesktopLibraryMode,
  clearRemoteDesktopSession,
  getRemoteDesktopSession,
  isRemoteDesktopMode,
  remoteProfileSessionPatch,
  remoteResourceId,
  saveRemoteDesktopSession,
  setDesktopLibraryMode,
  updateRemoteDesktopSession,
} from './remoteDesktop';
import {
  browserPairResponseSchema,
  apiResultSchema,
  backupResultSchema,
  desktopActiveProfileSchema,
  desktopLibraryIndexSchema,
  desktopLibraryItemDetailsSchema,
  desktopLibrarySchema,
  desktopProfileListSchema,
  desktopProfilePreferencesSchema,
  desktopProfileSelectionSchema,
  desktopProfilesPayloadSchema,
  desktopProgressMapSchema,
  desktopStoredProgressSchema,
  ffmpegStatusSchema,
  githubReleaseSchema,
  localNetworkStatusSchema,
  mediaSegmentResponseSchema,
  metadataKeyTestResultsSchema,
  officialArtworkResultSchema,
  officialMetadataCandidateSchema,
  okResultSchema,
  playbackLogoResultSchema,
  playbackPlanResultSchema,
  playbackTrackPreferencesResultSchema,
  playbackTrackPreferencesSchema,
  portResultSchema,
  profileCreateResponseSchema,
  readErrorResponse,
  readJsonResponse,
  refreshedCredentialsSchema,
  resourceIdResultSchema,
  settingsPayloadSchema,
  stringRecordSchema,
  transcodeSessionSchema,
  unknownApiResultSchema,
} from './desktopDecoders';
import { lanStreamingProviderSchema } from '@loom-media-server/lan-protocol';
import { z } from 'zod';
export type {
  ActiveProfileState,
  ApiResult,
  LibraryFolderKind,
  LibraryIndexPayload,
  LibraryItemDetailsPayload,
  LibraryPayload,
  LibraryScanMode,
  LibraryScanProgress,
  LocalNetworkPairedDevice,
  LocalNetworkPeer,
  LocalNetworkStatus,
  LocalSegmentAnalysisStatus,
  ManualMediaSegmentInput,
  ManagedMediaSegment,
  MediaSegment,
  MediaSegmentRequest,
  MediaSegmentResponse,
  MediaSegmentType,
  MetadataApiKeys,
  MetadataKeyTestResult,
  StreamingProvider,
  MpvAvailability,
  MpvCommand,
  MpvPlaybackDiagnostics,
  MpvPlaybackState,
  MpvStartOptions,
  OfficialArtworkResult,
  OfficialArtworkRefreshTarget,
  OfficialMetadataApplyTarget,
  OfficialMetadataCandidate,
  OfficialStremioAddon,
  PlaybackLogoResult,
  PlaybackCapabilities,
  PlaybackPlanResponse,
  PlaybackTrackPreferences,
  ProfileCreateInput,
  ProfileListEntry,
  ProfileListKind,
  ProfilePreferences,
  ProfileRestrictions,
  ProfileSummary,
  ProfileTransferResult,
  ProfileType,
  ProfileUpdateInput,
  RemoteLibraryConnection,
  RemoteLibraryRequest,
  RemoteLibraryResponse,
  SettingsPayload,
  SkipAnalysisRunScope,
  StoredProgress,
  StreamUrlOptions,
  StreamUrlResult,
  StremioPluginCatalogExtra,
  StremioPluginCatalogDefinition,
  StremioPluginCatalogItem,
  StremioPluginCatalogRequest,
  StremioPluginCatalogResult,
  StremioPluginConfigurationState,
  StremioPluginAuditEntry,
  StremioPluginIpcResult,
  StremioPluginMetaRequest,
  StremioPluginMetaResult,
  StremioPluginReview,
  StremioPluginSummary,
  SubtitleStyleOptions,
  TranscodeOptions,
  TranscodeSession,
  UpdateState,
} from '../shared/desktopProtocol.ts';
export type { MpvPlaybackTrack } from '../shared/desktopProtocol.ts';
export type { SkipAnalysisSettings } from '../shared/desktopProtocol.ts';

export type LibVlcSurface = 'composited-window' | 'unavailable';
export type LibVlcAvailability = MpvAvailability & {
  enabled?: boolean;
  surface?: LibVlcSurface;
  libraryPath?: string;
};
export type LibVlcPlaybackState = Omit<PlaybackState, 'sessionId'> & {
  sessionId?: string;
};
export type LibVlcStartOptions = PlaybackStartOptions;
export type LibVlcStartResult = {
  ok: boolean;
  sessionId?: string;
  surface?: LibVlcSurface;
  error?: string;
};
export type LibVlcCommand = PlaybackCommand;
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION = typeof __APP_VERSION__ === 'string' && __APP_VERSION__
  ? __APP_VERSION__
  : packageJson.version || 'dev';

export type DesktopBridgeApi = {
      getLibrary: () => Promise<LibraryPayload>;
      getLibraryIndex?: () => Promise<LibraryIndexPayload>;
      getLibraryItem?: (mediaId: string) => Promise<LibraryItemDetailsPayload | null>;
      scanLibrary: (options?: { force?: boolean; mode?: LibraryScanMode }) => Promise<LibraryIndexPayload>;
      onLibraryScanProgress?: (callback: (progress: LibraryScanProgress) => void) => () => void;
      addLibraryFolder: (kind?: LibraryFolderKind) => Promise<LibraryIndexPayload | null>;
      addLibraryFolderPath?: (kind: LibraryFolderKind, folderPath: string) => Promise<LibraryIndexPayload>;
      pickLibraryFolder?: (currentPath?: string) => Promise<string | null>;
      removeLibraryFolder: (folderPath: string) => Promise<LibraryIndexPayload>;
      updateLibraryFolder?: (folderPath: string, nextFolderPath: string, kind: LibraryFolderKind) => Promise<LibraryIndexPayload>;
      playMedia: (filePath: string) => Promise<boolean>;
      getStreamUrl: (filePath: string, options?: StreamUrlOptions) => Promise<StreamUrlResult>;
      getSubtitleUrl?: (filePath: string, streamOrdinal?: number) => Promise<{ url: string }>;
      getThumbnail: (filePath: string, time?: string) => Promise<{ url: string }>;
      getFileInfo: (filePath: string) => Promise<{ size: number; path: string; exists: boolean }>;
      getServerBase: () => Promise<string>;
      getRendererSession?: () => Promise<RendererSession>;
      setFullscreen?: (enabled: boolean) => Promise<boolean>;
      setWindowChromeVisible?: (visible: boolean) => Promise<boolean>;
      onFullscreenChanged?: (callback: (fullscreen: boolean) => void) => () => void;
      onSystemMediaKey?: (
        callback: (action: 'play-pause' | 'previous-track' | 'next-track') => void,
      ) => () => void;
      checkFFmpeg: () => Promise<FFmpegStatus>;
      getSettings: () => Promise<SettingsPayload>;
      saveSettings: (settings: SettingsPayload) => Promise<boolean>;
      listStremioPlugins?: () => Promise<StremioPluginIpcResult<StremioPluginSummary[]>>;
      listAvailableStremioPlugins?: () => Promise<StremioPluginIpcResult<StremioPluginSummary[]>>;
      listOfficialStremioAddons?: () => Promise<StremioPluginIpcResult<OfficialStremioAddon[]>>;
      reviewOfficialStremioAddon?: (officialId: OfficialStremioAddon['id']) => Promise<StremioPluginIpcResult<StremioPluginReview>>;
      reviewStremioManifestUrl?: (manifestUrl: string) => Promise<StremioPluginIpcResult<StremioPluginReview>>;
      approveStremioAddon?: (addonId: string, reviewToken: string) => Promise<StremioPluginIpcResult<StremioPluginSummary>>;
      disableStremioAddon?: (addonId: string) => Promise<StremioPluginIpcResult<StremioPluginSummary>>;
      removeStremioAddon?: (addonId: string) => Promise<StremioPluginIpcResult<boolean>>;
      listStremioProfileAccess?: (profileId: string) => Promise<StremioPluginIpcResult<string[]>>;
      setStremioProfileAccess?: (profileId: string, addonId: string, enabled: boolean) => Promise<StremioPluginIpcResult<boolean>>;
      getStremioCatalog?: (addonId: string, request: StremioPluginCatalogRequest) => Promise<StremioPluginIpcResult<StremioPluginCatalogResult>>;
      getStremioMeta?: (addonId: string, request: StremioPluginMetaRequest) => Promise<StremioPluginIpcResult<StremioPluginMetaResult>>;
      getStremioMetaByItem?: (request: StremioPluginMetaRequest) => Promise<StremioPluginIpcResult<StremioPluginMetaResult>>;
      getStremioAddonConfiguration?: (addonId: string) => Promise<StremioPluginIpcResult<StremioPluginConfigurationState>>;
      saveStremioAddonConfiguration?: (addonId: string, values: Record<string, unknown>) => Promise<StremioPluginIpcResult<StremioPluginConfigurationState>>;
      listStremioPluginAudit?: (addonId: string, limit?: number) => Promise<StremioPluginIpcResult<readonly StremioPluginAuditEntry[]>>;
      testMetadataKeys?: (keys: MetadataApiKeys) => Promise<MetadataKeyTestResult[]>;
      getLocalNetworkStatus?: () => Promise<LocalNetworkStatus>;
      discoverLocalNetworkPeers?: (timeoutMs?: number) => Promise<LocalNetworkPeer[]>;
      connectRemoteLibrary?: (baseUrl: string, code: string, certFingerprint?: string) => Promise<RemoteLibraryConnection>;
      remoteLibraryRequest?: (pathname: string, request?: RemoteLibraryRequest) => Promise<RemoteLibraryResponse>;
      getRemoteLibrarySession?: () => Promise<RemoteLibrarySessionState>;
      disconnectRemoteLibrary?: (revoke?: boolean) => Promise<boolean>;
      revokePairedDevice?: (deviceId: string) => Promise<LocalNetworkPairedDevice[]>;
      setLocalNetworkDeviceName?: (name: string) => Promise<string>;
      getUnifiedDesktopServerState?: () => Promise<UnifiedDesktopServerState>;
      configureUnifiedDesktopOwner?: (input: { name: string; password: string }) => Promise<UnifiedDesktopServerState>;
      openUnifiedDesktopAdmin?: () => Promise<boolean>;
      listProfiles?: () => Promise<ProfileSummary[]>;
      chooseProfileAvatar?: () => Promise<string | null>;
      getActiveProfileState?: () => Promise<ActiveProfileState>;
      createProfile?: (input: ProfileCreateInput) => Promise<ProfileSummary[]>;
      updateProfile?: (profileId: string, patch: ProfileUpdateInput) => Promise<ProfileSummary[]>;
      deleteProfile?: (profileId: string) => Promise<ProfileSummary[]>;
      exportProfile?: (profileId: string) => Promise<ProfileTransferResult>;
      importProfile?: () => Promise<ProfileTransferResult>;
      selectProfile?: (profileId: string, pin?: string) => Promise<ProfileSummary>;
      selectGuestProfile?: () => Promise<ProfileSummary>;
      lockProfile?: () => Promise<ActiveProfileState>;
      reorderProfiles?: (profileIds: string[]) => Promise<ProfileSummary[]>;
      changeProfilePin?: (profileId: string, pin: string | null) => Promise<ProfileSummary>;
      resetOwnerProfile?: (confirmation: string) => Promise<ProfileSummary>;
      setAutomaticProfileSignIn?: (enabled: boolean) => Promise<ActiveProfileState>;
      getProfilePreferences?: () => Promise<ProfilePreferences>;
      saveProfilePreferences?: (patch: ProfilePreferences, expectedProfileId?: string) => Promise<ProfilePreferences>;
      getProfileRestrictions?: (profileId: string) => Promise<ProfileRestrictions>;
      saveProfileRestrictions?: (profileId: string, restrictions: Omit<ProfileRestrictions, 'revision'>) => Promise<ProfileRestrictions>;
      getProfileLists?: (kind?: ProfileListKind) => Promise<ProfileListEntry[]>;
      setProfileListEntry?: (mediaId: string, kind: ProfileListKind, present: boolean, expectedProfileId?: string) => Promise<ProfileListEntry[]>;
      onProfilesChanged?: (callback: (event: ProfilesChangedEvent) => void) => () => void;
      onActiveProfileChanged?: (callback: (state: ActiveProfileState) => void) => () => void;
      getProgress?: (filePath?: string) => Promise<Record<string, StoredProgress> | StoredProgress | null>;
      saveProgress?: (filePath: string, position: number, duration: number, expectedProfileId?: string) => Promise<StoredProgress>;
      importProgress?: (progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>, expectedProfileId?: string) => Promise<boolean>;
      getPlaybackTrackPreferences?: (scope?: string) => Promise<PlaybackTrackPreferences | Record<string, PlaybackTrackPreferences>>;
      savePlaybackTrackPreferences?: (scope: string, preferences: PlaybackTrackPreferences, expectedProfileId?: string) => Promise<PlaybackTrackPreferences>;
      getMediaSegments?: (request: MediaSegmentRequest) => Promise<MediaSegmentResponse>;
      saveManualMediaSegment?: (input: ManualMediaSegmentInput) => Promise<MediaSegmentResponse>;
      deleteManualMediaSegment?: (input: MediaSegmentRequest & { candidateId?: string; type: MediaSegmentType }) => Promise<MediaSegmentResponse>;
      undoManualMediaSegment?: (input: MediaSegmentRequest & { candidateId?: string; type: MediaSegmentType }) => Promise<MediaSegmentResponse>;
      getManagedMediaSegments?: (request?: Partial<MediaSegmentRequest>) => Promise<ManagedMediaSegment[]>;
      updateManagedMediaSegment?: (candidateId: string, patch: { status?: ManagedMediaSegment['status']; type?: MediaSegmentType }) => Promise<boolean>;
      eraseManagedMediaSegments?: (request: MediaSegmentRequest) => Promise<{ removed: number }>;
      setPlaybackActivity?: (key: string, active: boolean, label?: string) => Promise<boolean>;
      getLocalSegmentAnalysisStatus?: () => Promise<LocalSegmentAnalysisStatus>;
      analyzeLocalSegmentSeason?: (mediaId: string, season: number) => Promise<MediaSegmentResponse>;
      runLocalSegmentAnalysis?: (scope?: SkipAnalysisRunScope) => Promise<{ queued: number }>;
      cancelLocalSegmentAnalysis?: (request?: { jobKey?: string; kind?: 'manual' }) => Promise<{ cancelled: number }>;
      pauseLocalSegmentAnalysis?: () => Promise<boolean>;
      resumeLocalSegmentAnalysis?: () => Promise<boolean>;
      cleanupLocalSegmentAnalysis?: () => Promise<{ queued: number }>;
      rebuildLocalSegmentAnalysis?: () => Promise<{ removed: number; queued: number }>;
      getCustomArtwork?: (mediaId: string) => Promise<Record<string, string>>;
      saveCustomArtwork?: (mediaId: string, target: string, dataUrl: string) => Promise<Record<string, string>>;
      getOfficialMetadataCandidates?: (mediaId: string) => Promise<OfficialMetadataCandidate[]>;
      applyOfficialMetadata?: (mediaId: string, candidate: OfficialMetadataCandidate, target?: OfficialMetadataApplyTarget) => Promise<OfficialArtworkResult>;
      refreshOfficialArtwork?: (mediaId: string, target?: OfficialArtworkRefreshTarget) => Promise<OfficialArtworkResult>;
      getPlaybackLogo?: (mediaId: string) => Promise<PlaybackLogoResult>;
      refreshIncompleteMetadata?: (mediaId: string) => Promise<boolean>;
      requestMetadataProvider?: (request: import('@/shared/desktopProtocol').MetadataProviderRequest) => Promise<unknown>;
      getStreamingProviders?: (mediaId: string) => Promise<StreamingProvider[]>;
      importCustomArtwork?: (entries: Record<string, Record<string, string>>) => Promise<boolean>;
      backupDatabase?: () => Promise<{ ok: boolean; path?: string; error?: string }>;
      clearAppData?: () => Promise<LibraryIndexPayload>;
      openExternal?: (url: string) => Promise<void>;
      openFolderPath?: (filePath: string) => Promise<boolean>;
      getUpdateState?: () => Promise<UpdateState>;
      checkForUpdates?: () => Promise<UpdateState>;
      installUpdate?: () => Promise<UpdateState>;
      onUpdateState?: (callback: (state: UpdateState) => void) => () => void;
      mpv?: {
        availability: () => Promise<MpvAvailability>;
        chooseExecutable: () => Promise<MpvAvailability>;
        resetExecutable: () => Promise<MpvAvailability>;
        refreshAvailability: () => Promise<MpvAvailability>;
        start: (filePath: string, options?: MpvStartOptions) => Promise<{ ok: boolean; sessionId?: string; error?: string }>;
        command: (sessionId: string, command: MpvCommand) => Promise<boolean>;
        stop: (sessionId: string) => Promise<boolean>;
        onState: (callback: (state: MpvPlaybackState) => void) => () => void;
      };
      libvlc?: {
        availability: () => Promise<LibVlcAvailability>;
        refreshAvailability: () => Promise<LibVlcAvailability>;
        start: (filePath: string, options?: PlaybackStartOptions) => Promise<LibVlcStartResult>;
        command: (sessionId: string, command: LibVlcCommand) => Promise<boolean>;
        stop: (sessionId: string) => Promise<boolean>;
        syncSurface: () => Promise<boolean>;
        setFullscreenTransition: (transitioning: boolean, waitForFinalViewport?: boolean) => Promise<boolean>;
        setViewport: (viewport: PlaybackViewport) => Promise<boolean>;
        onState: (callback: (state: LibVlcPlaybackState) => void) => () => void;
      };
      media?: {
        probe: (filePath: string) => Promise<ApiResult<unknown>>;
        canDirectPlay: (filePath: string, backend?: 'html5' | 'hls') => Promise<ApiResult<boolean>>;
        getPlaybackPlan?: (filePath: string, capabilities?: PlaybackCapabilities) => Promise<PlaybackPlanResponse | null>;
        startTranscode: (filePath: string, options?: TranscodeOptions) => Promise<ApiResult<TranscodeSession>>;
        stopTranscode: (sessionId: string) => Promise<ApiResult<boolean>>;
      };
};

declare global {
  interface Window {
    desktopApi?: DesktopBridgeApi;
  }
}

export class StremioPluginIpcError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly issues: readonly StremioPluginIpcIssue[];

  constructor(error: StremioPluginIpcErrorPayload) {
    super(error.message);
    this.name = 'StremioPluginIpcError';
    this.code = error.code;
    this.retryable = error.retryable;
    this.issues = error.issues || [];
  }
}

function unwrapStremioPluginResult<T>(result: StremioPluginIpcResult<T>): T {
  if (result?.ok === true) return result.data;
  if (result?.ok === false && result.error) throw new StremioPluginIpcError(result.error);
  throw new StremioPluginIpcError({
    code: 'STREMIO_PLUGIN_IPC_INVALID_RESPONSE',
    message: 'The Stremio add-on host returned an invalid response.',
    retryable: false,
  });
}

const DEFAULT_MEDIA_PORT = 3847;
const LOCAL_ACCESS_QUERY_PARAM = 'loomtvToken';
const LOCAL_ACCESS_HEADER = 'x-loomtv-token';
const BROWSER_LOCAL_SESSION_KEY = 'loomtv:browser-local-session-token.v1';
let resolvedServerBase: string | null = null;
let resolvedLocalAccessToken: string | null = null;
let remoteCatalogCache: { identity: string; etag: string; index: LibraryIndexPayload } | null = null;

function browserLocalSessionToken(): string | null {
  if (typeof window === 'undefined' || window.desktopApi) return null;
  try {
    const url = new URL(window.location.href);
    const queryToken = url.searchParams.get(LOCAL_ACCESS_QUERY_PARAM)?.trim() || '';
    const storedToken = window.sessionStorage.getItem(BROWSER_LOCAL_SESSION_KEY)?.trim() || '';
    const token = queryToken || storedToken;
    if (!token) return null;

    if (queryToken) {
      window.sessionStorage.setItem(BROWSER_LOCAL_SESSION_KEY, token);
      url.searchParams.delete(LOCAL_ACCESS_QUERY_PARAM);
      window.history.replaceState(window.history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
    }
    return token;
  } catch {
    return null;
  }
}

function clearBrowserLocalSessionToken(): void {
  if (typeof window === 'undefined' || window.desktopApi) return;
  try {
    window.sessionStorage.removeItem(BROWSER_LOCAL_SESSION_KEY);
  } catch {
    // Ignore unavailable session storage.
  }
}

export function hasBrowserLocalSession(): boolean {
  return Boolean(browserLocalSessionToken());
}

export function isBrowserLocalApp(): boolean {
  if (typeof window === 'undefined' || window.desktopApi) return false;
  const host = window.location.hostname.toLowerCase();
  const isLoopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  return isLoopbackHost && (window.location.pathname === '/app' || window.location.pathname.startsWith('/app/'));
}

async function discoverServerBase(): Promise<string> {
  if (!window.desktopApi && !resolvedLocalAccessToken) {
    resolvedLocalAccessToken = browserLocalSessionToken();
  }
  if (resolvedServerBase) return resolvedServerBase;

  // Electron renderers receive the port and the local access token over
  // sender-validated IPC. No HTTP route hands out that credential, because HTTP
  // could only identify this renderer by a header any local process can forge.
  const bridge = window.desktopApi;
  if (bridge?.getRendererSession) {
    const session = await bridge.getRendererSession().catch(() => null);
    if (session && typeof session.localAccessToken === 'string' && session.port > 0) {
      resolvedServerBase = `http://127.0.0.1:${session.port}`;
      resolvedLocalAccessToken = session.localAccessToken;
      return resolvedServerBase;
    }
  }

  // A browser tab opened directly has no credential. The tray's local web
  // handoff stores one in sessionStorage after removing it from the address bar;
  // direct tabs still discover the port without credentials and fail closed on
  // token-bearing routes.
  const candidatePorts = Array.from({ length: 8 }, (_, index) => DEFAULT_MEDIA_PORT + index);
  for (const port of candidatePorts) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`);
      if (response.ok) {
        resolvedServerBase = `http://127.0.0.1:${port}`;
        return resolvedServerBase;
      }
    } catch {
      // Try the next port; the media server can shift if the default is occupied.
    }
  }

  resolvedServerBase = `http://127.0.0.1:${DEFAULT_MEDIA_PORT}`;
  return resolvedServerBase;
}

async function discoverLocalAccessToken(): Promise<string | null> {
  await discoverServerBase();
  return resolvedLocalAccessToken;
}

async function localMediaUrl(pathname: string, params: URLSearchParams): Promise<string> {
  const base = await discoverServerBase();
  const token = await discoverLocalAccessToken();
  if (token) params.set(LOCAL_ACCESS_QUERY_PARAM, token);
  return `${base}${pathname}?${params.toString()}`;
}

async function fetchJson<TSchema extends z.ZodType>(
  pathname: string,
  schema: TSchema,
  init?: RequestInit,
): Promise<z.output<TSchema>> {
  const response = await fetchLocalResponse(pathname, init);

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return readJsonResponse(response, schema, pathname);
}

async function fetchLocalResponse(pathname: string, init?: RequestInit): Promise<Response> {
  const request = async (): Promise<Response> => {
    const base = await discoverServerBase();
    const token = await discoverLocalAccessToken();
    return fetch(`${base}${pathname}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { [LOCAL_ACCESS_HEADER]: token } : {}),
        ...(init?.headers || {}),
      },
    });
  };

  // A 401 means the cached port or token no longer matches the running main
  // process — a restarted main process mints a new token. Re-resolve once and
  // retry, in both the bridged and browser-only cases.
  let response = await request();
  if (response.status === 401) {
    resolvedServerBase = null;
    resolvedLocalAccessToken = null;
    clearBrowserLocalSessionToken();
    response = await request();
  }
  return response;
}

function normalizeLocalNetworkBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter the other device address.');
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== 'https:') throw new Error('Enter a secure HTTPS address.');
  if (!parsed.port) throw new Error('Include the secure port shown by the LoomTV host.');
  return parsed.origin;
}

async function fetchRequestWithTimeout(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

const REMOTE_REQUEST_TIMEOUT_MS = 10_000;
const REMOTE_PROFILE_API_HEADER = { 'X-Loom-Profile-Api-Version': '1' };

async function refreshRemoteCredentials(): Promise<ReturnType<typeof getRemoteDesktopSession>> {
  const session = getRemoteDesktopSession();
  if (!session?.refreshToken) throw new Error('Pair this laptop with the host again.');
  const response = await fetchRequestWithTimeout(`${session.baseUrl}/api/v2/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...REMOTE_PROFILE_API_HEADER },
    body: JSON.stringify({ refreshToken: session.refreshToken, deviceName: 'LoomTV Desktop' }),
  }, REMOTE_REQUEST_TIMEOUT_MS);
  if (!response.ok) {
    clearRemoteDesktopSession();
    throw new Error('The host pairing expired or was revoked. Pair this laptop again.');
  }
  const credentials = await readJsonResponse(response, refreshedCredentialsSchema, 'Credential refresh');
  return updateRemoteDesktopSession({
    deviceToken: credentials.accessToken || credentials.deviceToken,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt,
    refreshToken: credentials.refreshToken,
    refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
  });
}

async function remoteRequest(pathname: string, init: RequestInit = {}, retry = true): Promise<Response> {
  if (window.desktopApi?.remoteLibraryRequest) {
    if (!isRemoteDesktopMode()) throw new Error('This laptop is not connected to a LoomTV host.');
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const result = await window.desktopApi.remoteLibraryRequest(pathname, {
      method: (init.method || 'GET') as RemoteLibraryRequest['method'],
      headers,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const body = result.status === 204 || result.status === 205 || result.status === 304 ? null : result.body;
    return new Response(body, { status: result.status, headers: result.headers });
  }

  let session = getRemoteDesktopSession();
  if (!session || !isRemoteDesktopMode()) throw new Error('This laptop is not connected to a LoomTV host.');
  if (session.accessTokenExpiresAt <= Date.now() + 60_000) {
    session = await refreshRemoteCredentials();
  }
  if (!session) throw new Error('Pair this laptop with the host again.');
  const response = await fetchRequestWithTimeout(`${session.baseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.deviceToken}`,
      ...REMOTE_PROFILE_API_HEADER,
      ...(init.headers || {}),
    },
  }, REMOTE_REQUEST_TIMEOUT_MS);
  if (response.status === 401 && retry) {
    await refreshRemoteCredentials();
    return remoteRequest(pathname, init, false);
  }
  return response;
}

async function remoteJson<TSchema extends z.ZodType>(
  pathname: string,
  schema: TSchema,
  init?: RequestInit,
): Promise<z.output<TSchema>> {
  const response = await remoteRequest(pathname, init);
  if (!response.ok) {
    const payload = await readErrorResponse(response, pathname).catch(() => null);
    throw new Error(payload?.error || `The host returned ${response.status}.`);
  }
  return readJsonResponse(response, schema, pathname);
}

const DEFAULT_REMOTE_PLAYBACK_CAPABILITIES: PlaybackCapabilities = {
  containers: ['mp4', 'webm'],
  videoCodecs: ['h264', 'vp8', 'vp9', 'av1'],
  audioCodecs: ['aac', 'mp3', 'opus', 'vorbis'],
  supportsHls: true,
  supportsHdr: false,
  supportsTextSubtitles: true,
};

async function remotePlaybackPlan(
  filePath: string,
  capabilities: PlaybackCapabilities = DEFAULT_REMOTE_PLAYBACK_CAPABILITIES,
): Promise<PlaybackPlanResponse | null> {
  if (!isRemoteDesktopMode() || !/^https?:\/\//i.test(filePath)) return null;
  const result = await remoteJson('/api/v2/playback-plan', playbackPlanResultSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mediaId: remoteResourceId(filePath),
      capabilities,
      selectionRevision: getRemoteDesktopSession()?.selectionRevision,
    }),
  });
  if (!result.ok || !result.data) throw new Error(result.error || 'The host could not choose a playback plan.');
  return result.data;
}

function remoteProgressByStreamUrl(progress: Record<string, StoredProgress>): Record<string, StoredProgress> {
  const library = getRemoteDesktopSession()?.library;
  if (!library) return progress;
  // Keep opaque resource keys for compact cards while also mapping them to the
  // signed stream URLs used by the legacy full-library compatibility path.
  const mapped: Record<string, StoredProgress> = { ...progress };
  for (const item of [...(library.movies || []), ...(library.tvShows || []), ...(library.animeShows || [])]) {
    const paths = [item.filePath, ...(item.episodeFiles || []).map((episode) => episode.filePath)].filter(Boolean);
    for (const streamUrl of paths) {
      const value = progress[remoteResourceId(streamUrl)];
      if (value) mapped[streamUrl] = value;
    }
  }
  return mapped;
}

async function discoverLocalNetworkLibraryBaseUrl(): Promise<string> {
  // mDNS first — fast and accurate when peers advertise. Returns the first host
  // that publishes a LoomTV service.
  if (window.desktopApi?.discoverLocalNetworkPeers) {
    try {
      const peers = await window.desktopApi.discoverLocalNetworkPeers(2500);
      const peer = peers.find((candidate) => candidate.host && candidate.port);
      if (peer) return `https://${peer.host}:${peer.port}`;
    } catch {
      // Fall through to subnet scan if the mDNS browse failed.
    }
  }

  throw new Error('No LoomTV host was discovered. Select a host or enter its IP address manually.');
}

function bearerHeaders(token: string, init?: RequestInit): RequestInit {
  return {
    ...(init || {}),
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  };
}

function remoteMediaSource(url: string, remoteBaseUrl?: string): string {
  if (!window.desktopApi?.remoteLibraryRequest) return url;
  try {
    const parsed = new URL(url);
    const baseUrl = remoteBaseUrl || getRemoteDesktopSession()?.baseUrl;
    if (!baseUrl || parsed.origin !== new URL(baseUrl).origin) return url;
    return `plexserver://remote${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function remoteLibrarySources(library: LibraryPayload, remoteBaseUrl?: string): LibraryPayload {
  const rewrite = (value?: string | null): string => value ? remoteMediaSource(value, remoteBaseUrl) : '';
  const rewriteItem = (item: NonNullable<LibraryPayload['movies']>[number]) => ({
    ...item,
    poster: rewrite(item.poster),
    backdrop: rewrite(item.backdrop),
    logo: rewrite(item.logo),
    posterCandidates: item.posterCandidates?.map(rewrite),
    backdropCandidates: item.backdropCandidates?.map(rewrite),
    logoCandidates: item.logoCandidates?.map(rewrite),
    cast: item.cast.map((credit) => ({
      ...credit,
      image: rewrite(credit.image),
      characterImage: rewrite(credit.characterImage),
      voiceActorImage: rewrite(credit.voiceActorImage),
    })),
    subtitles: item.subtitles?.map((subtitle) => ({ ...subtitle, url: rewrite(subtitle.url) })),
    episodes: item.episodes?.map((episode) => ({ ...episode, still: rewrite(episode.still) })),
    episodeFiles: item.episodeFiles?.map((episode) => ({
      ...episode,
      still: rewrite(episode.still),
      thumbnail: rewrite(episode.thumbnail),
      subtitles: episode.subtitles?.map((subtitle) => ({ ...subtitle, url: rewrite(subtitle.url) })),
    })),
  });
  return {
    ...library,
    movies: library.movies.map(rewriteItem),
    tvShows: library.tvShows.map(rewriteItem),
    animeShows: library.animeShows?.map(rewriteItem),
    others: library.others?.map(rewriteItem),
  };
}

function remoteLibraryIndexSources(index: LibraryIndexPayload): LibraryIndexPayload {
  const rewrite = (value?: string | null): string => value ? remoteMediaSource(value) : '';
  const rewriteCard = (item: LibraryIndexPayload['movies'][number]) => ({
    ...item,
    poster: rewrite(item.poster),
    backdrop: rewrite(item.backdrop),
    logo: rewrite(item.logo),
    posterCandidates: item.posterCandidates?.map(rewrite),
    backdropCandidates: item.backdropCandidates?.map(rewrite),
    logoCandidates: item.logoCandidates?.map(rewrite),
  });
  return {
    ...index,
    movies: index.movies.map(rewriteCard),
    tvShows: index.tvShows.map(rewriteCard),
    animeShows: index.animeShows.map(rewriteCard),
    others: index.others?.map(rewriteCard),
  };
}

function remoteLibraryItemSources(payload: LibraryItemDetailsPayload): LibraryItemDetailsPayload {
  const library = remoteLibrarySources({
    movies: payload.item.type === 'movie' ? [payload.item] : [],
    tvShows: payload.item.type === 'tv' ? [payload.item] : [],
    animeShows: payload.item.type === 'anime' ? [payload.item] : [],
    libraryFolders: [],
  });
  return {
    ...payload,
    item: [...library.movies, ...library.tvShows, ...(library.animeShows || [])][0] || payload.item,
  };
}

async function refreshRemoteActiveProfileState(): Promise<ActiveProfileState> {
  const response = await remoteRequest('/api/v2/profiles/active');
  if (response.status === 409) {
    return { profileId: null, selectionRequired: true, selectionRevision: 0, automaticSignIn: false };
  }
  if (!response.ok) throw new Error('Could not read the active profile from the host.');
  const state = await readJsonResponse(response, desktopActiveProfileSchema, 'Active profile');
  updateRemoteDesktopSession(remoteProfileSessionPatch(state));
  return state;
}

export const desktopApi = {
  async getLibraryIndex(): Promise<LibraryIndexPayload | null> {
    if (isRemoteDesktopMode()) {
      const session = getRemoteDesktopSession();
      const identity = session
        ? `${session.baseUrl}:${session.deviceId}:${session.selectedProfileId || 'profile:none'}:${session.selectionRevision || 0}`
        : 'remote:none';
      const cached = remoteCatalogCache?.identity === identity ? remoteCatalogCache : null;
      const response = await remoteRequest('/api/v2/library/index', {
        headers: cached?.etag ? { 'If-None-Match': cached.etag } : {},
      });
      if (response.status === 304 && cached) return cached.index;
      if (response.status === 403 || response.status === 404 || response.status === 410 || response.status === 501) return null;
      if (!response.ok) {
        if (response.status === 409) throw new Error('Select a profile from the host first.');
        throw new Error(response.status === 401 ? 'Pairing was revoked on the host.' : 'Could not load the shared catalog.');
      }
      const index = remoteLibraryIndexSources(await readJsonResponse(response, desktopLibraryIndexSchema, 'Library index'));
      const etag = response.headers.get('ETag') || '';
      remoteCatalogCache = { identity, etag, index };
      updateRemoteDesktopSession({
        library: { movies: [], tvShows: [], animeShows: [], libraryFolders: [] },
        libraryEtag: etag,
      });
      return index;
    }
    if (window.desktopApi?.getLibraryIndex) return window.desktopApi.getLibraryIndex();
    const response = await fetchLocalResponse('/api/renderer/library/index');
    if (response.status === 403 || response.status === 404 || response.status === 410 || response.status === 501) return null;
    if (!response.ok) throw new Error(`Could not load the local catalog (${response.status}).`);
    return readJsonResponse(response, desktopLibraryIndexSchema, 'Library index');
  },

  async getLibraryItem(mediaId: string): Promise<LibraryItemDetailsPayload | null> {
    const encodedId = encodeURIComponent(mediaId);
    if (isRemoteDesktopMode()) {
      const response = await remoteRequest(`/api/v2/library/items/${encodedId}`);
      if (response.status === 403 || response.status === 404 || response.status === 410 || response.status === 501) return null;
      if (!response.ok) throw new Error(`Could not load media details (${response.status}).`);
      return remoteLibraryItemSources(await readJsonResponse(response, desktopLibraryItemDetailsSchema, 'Library item'));
    }
    if (window.desktopApi?.getLibraryItem) return window.desktopApi.getLibraryItem(mediaId);
    const response = await fetchLocalResponse(`/api/renderer/library/items/${encodedId}`);
    if (response.status === 403 || response.status === 404 || response.status === 410 || response.status === 501) return null;
    if (!response.ok) throw new Error(`Could not load media details (${response.status}).`);
    return readJsonResponse(response, desktopLibraryItemDetailsSchema, 'Library item');
  },

  async getLibrary(): Promise<LibraryPayload> {
    if (isRemoteDesktopMode()) {
      const response = await remoteRequest('/api/v2/library');
      if (!response.ok) {
        if (response.status === 409) throw new Error('Select a profile from the host first.');
        throw new Error(response.status === 401 ? 'Pairing was revoked on the host.' : 'Could not load the shared library.');
      }
      const library = remoteLibrarySources(await readJsonResponse(response, desktopLibrarySchema, 'Shared library'));
      const session = getRemoteDesktopSession();
      if (session) updateRemoteDesktopSession({ library, libraryEtag: response.headers.get('ETag') || session.libraryEtag });
      return library;
    }
    if (window.desktopApi) return window.desktopApi.getLibrary();
    return fetchJson('/api/renderer/library', desktopLibrarySchema);
  },

  async getStreamUrl(filePath: string, options: StreamUrlOptions = {}): Promise<StreamUrlResult> {
    if (isRemoteDesktopMode() && /^https?:\/\//i.test(filePath)) {
      let fileName = 'Remote stream';
      try { fileName = new URL(filePath).pathname.split('/').pop() || fileName; } catch { /* Keep fallback. */ }
      const playbackPlan = await remotePlaybackPlan(filePath).catch(() => null);
      const plan = playbackPlan?.plan;
      return {
        url: remoteMediaSource(filePath),
        contentType: 'video/mp4',
        fileName,
        isTranscoded: plan?.sourceAction === 'transcode',
        isRemuxed: plan?.mode === 'remux',
        playbackMode: plan?.mode || 'direct-stream',
        decisionReason: plan?.reason || 'Signed stream supplied by the paired LoomTV host',
      };
    }
    if (window.desktopApi) {
      return window.desktopApi.getStreamUrl(filePath, options);
    }
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const contentTypeMap: Record<string, string> = {
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/mp4', m4v: 'video/mp4',
      mkv: 'video/mp4', avi: 'video/mp4', wmv: 'video/mp4',
    };
    const params = new URLSearchParams({ path: filePath });
    if (options.startSeconds && options.startSeconds > 0) params.set('t', String(Math.floor(options.startSeconds)));
    if (typeof options.videoTrackIndex === 'number') params.set('video', String(options.videoTrackIndex));
    if (typeof options.audioTrackIndex === 'number') params.set('audio', String(options.audioTrackIndex));
    if (typeof options.subtitleTrackIndex === 'number') params.set('subtitle', String(options.subtitleTrackIndex));
    if (typeof options.subtitleStreamOrdinal === 'number') params.set('subtitleOrdinal', String(options.subtitleStreamOrdinal));
    if (options.subtitleCodec) params.set('subtitleCodec', options.subtitleCodec);
    const [subtitleResource, secondarySubtitleResource] = await Promise.all([
      options.subtitleFilePath
        ? fetchJson('/api/renderer/media/subtitle-resource', resourceIdResultSchema, {
          method: 'POST',
          body: JSON.stringify({ mediaFilePath: filePath, subtitleFilePath: options.subtitleFilePath }),
        })
        : null,
      options.secondarySubtitleFilePath
        ? fetchJson('/api/renderer/media/subtitle-resource', resourceIdResultSchema, {
          method: 'POST',
          body: JSON.stringify({ mediaFilePath: filePath, subtitleFilePath: options.secondarySubtitleFilePath }),
        })
        : null,
    ]);
    if (subtitleResource?.resourceId) params.set('subtitleResourceId', subtitleResource.resourceId);
    if (typeof options.secondarySubtitleTrackIndex === 'number') params.set('secondarySubtitle', String(options.secondarySubtitleTrackIndex));
    if (typeof options.secondarySubtitleStreamOrdinal === 'number') params.set('secondarySubtitleOrdinal', String(options.secondarySubtitleStreamOrdinal));
    if (options.secondarySubtitleCodec) params.set('secondarySubtitleCodec', options.secondarySubtitleCodec);
    if (secondarySubtitleResource?.resourceId) {
      params.set('secondarySubtitleResourceId', secondarySubtitleResource.resourceId);
    }
    if (options.subtitleStyle) params.set('subtitleStyle', JSON.stringify(options.subtitleStyle));
    if (options.forceTranscode) params.set('forceTranscode', '1');
    const playbackMode: PlaybackMode = options.forceTranscode
      ? 'transcode'
      : ['mp4', 'm4v', 'mov', 'webm'].includes(ext)
        ? 'direct'
        : ['mkv'].includes(ext)
          ? 'remux'
          : 'transcode';
    return {
      url: await localMediaUrl('/stream', params),
      contentType: contentTypeMap[ext] || 'video/mp4',
      fileName: filePath.split('/').pop() || '',
      isTranscoded: playbackMode !== 'direct',
      isRemuxed: playbackMode === 'remux',
      playbackMode,
      decisionReason: 'client-side extension estimate',
    };
  },

  async getFileInfo(filePath: string): Promise<{ size: number; path: string; exists: boolean }> {
    if (window.desktopApi?.getFileInfo) return window.desktopApi.getFileInfo(filePath);
    // The browser renderer cannot inspect host paths directly. Electron's
    // bridge is the authoritative check; keep a conservative fallback for
    // local web mode so it can continue using its existing stream route.
    return { size: 0, path: filePath, exists: false };
  },

  async getSubtitleUrl(filePath: string, streamOrdinal?: number): Promise<{ url: string }> {
    if (isRemoteDesktopMode() && /^https?:\/\//i.test(filePath)) {
      const parsed = new URL(filePath);
      if (parsed.pathname === '/subtitle') return { url: remoteMediaSource(filePath) };
      throw new Error('Embedded remote subtitles require a host-provided subtitle URL.');
    }
    if (window.desktopApi?.getSubtitleUrl) return window.desktopApi.getSubtitleUrl(filePath, streamOrdinal);
    const params = new URLSearchParams({ path: filePath });
    if (typeof streamOrdinal === 'number') params.set('streamOrdinal', String(streamOrdinal));
    return { url: await localMediaUrl('/subtitle', params) };
  },

  async getServerBase(): Promise<string> {
    if (window.desktopApi) return window.desktopApi.getServerBase();
    return discoverServerBase();
  },

  async setWindowChromeVisible(visible: boolean): Promise<boolean> {
    return window.desktopApi?.setWindowChromeVisible?.(visible) ?? false;
  },

  async setFullscreen(enabled: boolean): Promise<boolean> {
    return window.desktopApi?.setFullscreen?.(enabled) ?? false;
  },

  onFullscreenChanged(callback: (fullscreen: boolean) => void): () => void {
    return window.desktopApi?.onFullscreenChanged?.(callback) || (() => undefined);
  },

  onSystemMediaKey(
    callback: (action: 'play-pause' | 'previous-track' | 'next-track') => void,
  ): () => void {
    return window.desktopApi?.onSystemMediaKey?.(callback) || (() => undefined);
  },

  async getLocalNetworkStatus(): Promise<LocalNetworkStatus> {
    if (window.desktopApi?.getLocalNetworkStatus) return window.desktopApi.getLocalNetworkStatus();
    return fetchJson('/api/lan/status', localNetworkStatusSchema);
  },

  async discoverLocalNetworkPeers(timeoutMs = 2500): Promise<LocalNetworkPeer[]> {
    if (window.desktopApi?.discoverLocalNetworkPeers) return window.desktopApi.discoverLocalNetworkPeers(timeoutMs);
    return [];
  },

  async revokePairedDevice(deviceId: string): Promise<LocalNetworkPairedDevice[]> {
    if (window.desktopApi?.revokePairedDevice) return window.desktopApi.revokePairedDevice(deviceId);
    return [];
  },

  async setLocalNetworkDeviceName(name: string): Promise<string> {
    if (window.desktopApi?.setLocalNetworkDeviceName) return window.desktopApi.setLocalNetworkDeviceName(name);
    return name;
  },

  async connectToLocalNetworkLibrary(baseUrl: string, code: string, certFingerprint?: string): Promise<RemoteLibraryConnection> {
    const normalizedCode = code.trim();
    if (!/^\d{6}$/.test(normalizedCode)) {
      throw new Error('Enter the 6-digit pairing PIN.');
    }

    const normalizedBaseUrl = baseUrl.trim()
      ? normalizeLocalNetworkBaseUrl(baseUrl)
      : await discoverLocalNetworkLibraryBaseUrl();

    if (window.desktopApi?.connectRemoteLibrary) {
      const connection = await window.desktopApi.connectRemoteLibrary(
        normalizedBaseUrl,
        normalizedCode,
        certFingerprint,
      );
      return { ...connection, library: remoteLibrarySources(connection.library, connection.baseUrl) };
    }

    const response = await fetchRequestWithTimeout(`${normalizedBaseUrl}/api/v2/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: normalizedCode,
        deviceName: 'LoomTV browser',
      }),
    }, REMOTE_REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      const payload = await readErrorResponse(response, 'Pairing').catch(() => null);
      throw new Error(payload?.message || payload?.error || `The host rejected pairing (${response.status}).`);
    }
    const payload = await readJsonResponse(response, browserPairResponseSchema, 'Pairing');
    return {
      baseUrl: normalizedBaseUrl,
      deviceId: payload.deviceId,
      deviceToken: payload.accessToken,
      accessTokenExpiresAt: Number(payload.accessTokenExpiresAt) || 0,
      refreshToken: payload.refreshToken,
      refreshTokenExpiresAt: Number(payload.refreshTokenExpiresAt) || 0,
      hostDeviceId: payload.hostDeviceId,
      hostDeviceName: payload.hostDeviceName,
      library: remoteLibrarySources(payload.library || { movies: [], tvShows: [], animeShows: [], libraryFolders: [] }, normalizedBaseUrl),
      libraryEtag: payload.libraryEtag || '',
    };
  },

  activateRemoteLibrary(connection: RemoteLibraryConnection): void {
    saveRemoteDesktopSession(connection);
    setDesktopLibraryMode('remote');
  },

  useThisComputerAsHost(): void {
    setDesktopLibraryMode('host');
  },

  returnToDesktopOnboarding(): void {
    clearDesktopLibraryMode();
  },

  async getUnifiedDesktopServerState(): Promise<UnifiedDesktopServerState> {
    return window.desktopApi?.getUnifiedDesktopServerState?.() || {
      enabled: false,
      ready: false,
      ownerConfigured: false,
    };
  },

  async configureUnifiedDesktopOwner(input: { name: string; password: string }): Promise<UnifiedDesktopServerState> {
    if (!window.desktopApi?.configureUnifiedDesktopOwner) {
      throw new Error('Unified server setup is unavailable in this desktop session.');
    }
    return window.desktopApi.configureUnifiedDesktopOwner(input);
  },

  async openUnifiedDesktopAdmin(): Promise<boolean> {
    return window.desktopApi?.openUnifiedDesktopAdmin?.() || false;
  },

  isRemoteLibraryMode(): boolean {
    return isRemoteDesktopMode();
  },

  async getPersistedRemoteLibrary(): Promise<RemoteLibraryConnection | null> {
    if (!window.desktopApi?.getRemoteLibrarySession) return getRemoteDesktopSession();
    const state = await window.desktopApi.getRemoteLibrarySession();
    if (state.status === 'connected') return state.connection;
    if (state.status === 'pairing-required') throw new Error(state.reason);
    return null;
  },

  disconnectRemoteDesktop(): void {
    void window.desktopApi?.disconnectRemoteLibrary?.(false);
    clearRemoteDesktopSession();
    setDesktopLibraryMode('host');
  },

  async refreshRemoteLibrary(
    baseUrl: string,
    deviceToken: string,
    etag?: string,
    refreshToken?: string,
    accessTokenExpiresAt?: number,
    refreshTokenExpiresAt?: number,
  ): Promise<{
    library: LibraryPayload;
    etag: string;
    deviceToken: string;
    accessTokenExpiresAt: number;
    refreshToken: string;
    refreshTokenExpiresAt: number;
  } | null> {
    if (window.desktopApi?.remoteLibraryRequest) {
      const response = await remoteRequest('/api/v2/library', {
        headers: etag ? { 'If-None-Match': etag } : {},
      });
      if (response.status === 304) return null;
      if (!response.ok) {
        if (response.status === 401) throw new Error('Pairing was revoked on the host.');
        throw new Error('Could not refresh the shared library.');
      }
      const localSession = getRemoteDesktopSession();
      return {
        library: remoteLibrarySources(await readJsonResponse(response, desktopLibrarySchema, 'Shared library')),
        etag: response.headers.get('ETag') || '',
        deviceToken: '',
        accessTokenExpiresAt: localSession?.accessTokenExpiresAt || 0,
        refreshToken: '',
        refreshTokenExpiresAt: localSession?.refreshTokenExpiresAt || 0,
      };
    }

    let activeToken = deviceToken;
    let activeRefreshToken = refreshToken || '';
    let activeAccessExpiresAt = Number(accessTokenExpiresAt) || 0;
    let refreshExpiresAt = Number(refreshTokenExpiresAt) || 0;
    if (activeRefreshToken && activeAccessExpiresAt <= Date.now() + 60_000) {
      const refreshResponse = await fetchRequestWithTimeout(`${baseUrl}/api/v2/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...REMOTE_PROFILE_API_HEADER },
        body: JSON.stringify({ refreshToken: activeRefreshToken }),
      }, REMOTE_REQUEST_TIMEOUT_MS);
      if (!refreshResponse.ok) throw new Error('The secure pairing session expired. Pair again.');
      const credentials = await readJsonResponse(refreshResponse, refreshedCredentialsSchema, 'Credential refresh');
      activeToken = credentials.accessToken;
      activeAccessExpiresAt = credentials.accessTokenExpiresAt;
      activeRefreshToken = credentials.refreshToken;
      refreshExpiresAt = credentials.refreshTokenExpiresAt;
    }
    const response = await fetchRequestWithTimeout(`${baseUrl}/api/v2/library`, bearerHeaders(activeToken, {
      headers: { ...REMOTE_PROFILE_API_HEADER, ...(etag ? { 'If-None-Match': etag } : {}) },
    }), REMOTE_REQUEST_TIMEOUT_MS);
    if (response.status === 304) return null;
    if (!response.ok) {
      if (response.status === 401) throw new Error('Pairing was revoked on the host.');
      throw new Error('Could not refresh the shared library.');
    }
    const library = await readJsonResponse(response, desktopLibrarySchema, 'Shared library');
    return {
      library,
      etag: response.headers.get('ETag') || '',
      deviceToken: activeToken,
      accessTokenExpiresAt: activeAccessExpiresAt,
      refreshToken: activeRefreshToken,
      refreshTokenExpiresAt: refreshExpiresAt,
    };
  },

  async unpairFromRemoteLibrary(baseUrl: string, deviceToken: string): Promise<void> {
    if (window.desktopApi?.disconnectRemoteLibrary) {
      await window.desktopApi.disconnectRemoteLibrary(true);
      return;
    }
    await fetch(`${baseUrl}/api/v2/unpair`, bearerHeaders(deviceToken, {
      method: 'POST',
    })).catch(() => undefined);
  },

  async getThumbnail(filePath: string, time?: string): Promise<{ url: string }> {
    if (window.desktopApi?.getThumbnail) return window.desktopApi.getThumbnail(filePath, time);
    const params = new URLSearchParams({ path: filePath });
    if (time) params.set('t', time);
    return { url: await localMediaUrl('/api/thumbnail', params) };
  },

  async scanLibrary(mode: LibraryScanMode = 'quick'): Promise<LibraryIndexPayload | null> {
    if (window.desktopApi) return window.desktopApi.scanLibrary({ force: mode === 'full', mode });
    // Folder scanning is owned by Electron. In a browser renderer, refresh the
    // shared desktop snapshot instead of calling the intentionally IPC-only
    // scan route.
    return this.getLibraryIndex();
  },

  onLibraryScanProgress(callback: (progress: LibraryScanProgress) => void): () => void {
    return window.desktopApi?.onLibraryScanProgress?.(callback) || (() => undefined);
  },

  async addLibraryFolder(kind: LibraryFolderKind = 'movies'): Promise<LibraryIndexPayload | null> {
    if (window.desktopApi) return window.desktopApi.addLibraryFolder(kind);
    return fetchJson('/api/library/add-folder', desktopLibraryIndexSchema.nullable(), {
      method: 'POST',
      body: JSON.stringify({ kind }),
    });
  },

  async addLibraryFolderPath(kind: LibraryFolderKind, folderPath: string): Promise<LibraryIndexPayload> {
    if (window.desktopApi?.addLibraryFolderPath) return window.desktopApi.addLibraryFolderPath(kind, folderPath);
    throw new Error('Folders can only be added from the LoomTV host desktop app.');
  },

  async removeLibraryFolder(folderPath: string): Promise<LibraryIndexPayload> {
    if (window.desktopApi) return window.desktopApi.removeLibraryFolder(folderPath);
    return fetchJson('/api/library/remove-folder', desktopLibraryIndexSchema, {
      method: 'POST',
      body: JSON.stringify({ folderPath }),
    });
  },

  async pickLibraryFolder(currentPath?: string): Promise<string | null> {
    if (window.desktopApi?.pickLibraryFolder) return window.desktopApi.pickLibraryFolder(currentPath);
    throw new Error('Folders can only be selected from the LoomTV host desktop app.');
  },

  async updateLibraryFolder(folderPath: string, nextFolderPath: string, kind: LibraryFolderKind): Promise<LibraryIndexPayload> {
    if (window.desktopApi?.updateLibraryFolder) {
      return window.desktopApi.updateLibraryFolder(folderPath, nextFolderPath, kind);
    }
    throw new Error('Folder paths can only be edited from the LoomTV host desktop app.');
  },

  async getMediaServerPort(): Promise<number> {
    if (window.desktopApi) {
      const base = await window.desktopApi.getServerBase();
      const parsed = new URL(base);
      return Number(parsed.port || DEFAULT_MEDIA_PORT);
    }
    const response = await fetchJson('/api/media-server-port', portResultSchema);
    return response.port;
  },

  async checkFFmpeg(): Promise<FFmpegStatus> {
    if (window.desktopApi) return window.desktopApi.checkFFmpeg();
    return fetchJson('/api/renderer/ffmpeg', ffmpegStatusSchema);
  },

  async getSettings(): Promise<SettingsPayload> {
    if (window.desktopApi) return window.desktopApi.getSettings();
    return fetchJson('/api/renderer/settings', settingsPayloadSchema);
  },

  async listStremioPlugins(): Promise<StremioPluginSummary[]> {
    if (window.desktopApi?.listStremioPlugins) return unwrapStremioPluginResult(await window.desktopApi.listStremioPlugins());
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async listAvailableStremioPlugins(): Promise<StremioPluginSummary[]> {
    if (window.desktopApi?.listAvailableStremioPlugins) return unwrapStremioPluginResult(await window.desktopApi.listAvailableStremioPlugins());
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async listOfficialStremioAddons(): Promise<OfficialStremioAddon[]> {
    if (window.desktopApi?.listOfficialStremioAddons) return unwrapStremioPluginResult(await window.desktopApi.listOfficialStremioAddons());
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async reviewOfficialStremioAddon(officialId: OfficialStremioAddon['id']): Promise<StremioPluginReview> {
    if (window.desktopApi?.reviewOfficialStremioAddon) return unwrapStremioPluginResult(await window.desktopApi.reviewOfficialStremioAddon(officialId));
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async reviewStremioManifestUrl(manifestUrl: string): Promise<StremioPluginReview> {
    if (window.desktopApi?.reviewStremioManifestUrl) return unwrapStremioPluginResult(await window.desktopApi.reviewStremioManifestUrl(manifestUrl));
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async approveStremioAddon(addonId: string, reviewToken: string): Promise<StremioPluginSummary> {
    if (window.desktopApi?.approveStremioAddon) return unwrapStremioPluginResult(await window.desktopApi.approveStremioAddon(addonId, reviewToken));
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async disableStremioAddon(addonId: string): Promise<StremioPluginSummary> {
    if (window.desktopApi?.disableStremioAddon) return unwrapStremioPluginResult(await window.desktopApi.disableStremioAddon(addonId));
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async removeStremioAddon(addonId: string): Promise<boolean> {
    if (window.desktopApi?.removeStremioAddon) return unwrapStremioPluginResult(await window.desktopApi.removeStremioAddon(addonId));
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async listStremioProfileAccess(profileId: string): Promise<string[]> {
    if (window.desktopApi?.listStremioProfileAccess) return unwrapStremioPluginResult(await window.desktopApi.listStremioProfileAccess(profileId));
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async setStremioProfileAccess(profileId: string, addonId: string, enabled: boolean): Promise<boolean> {
    if (window.desktopApi?.setStremioProfileAccess) return unwrapStremioPluginResult(await window.desktopApi.setStremioProfileAccess(profileId, addonId, enabled));
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async getStremioCatalog(addonId: string, request: StremioPluginCatalogRequest): Promise<StremioPluginCatalogResult> {
    if (window.desktopApi?.getStremioCatalog) return unwrapStremioPluginResult(await window.desktopApi.getStremioCatalog(addonId, request));
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async getStremioMeta(addonId: string, request: StremioPluginMetaRequest): Promise<StremioPluginMetaResult> {
    if (window.desktopApi?.getStremioMeta) return unwrapStremioPluginResult(await window.desktopApi.getStremioMeta(addonId, request));
    throw new Error('Stremio add-ons are currently available only in the LoomTV desktop app.');
  },

  async getStremioMetaByItem(request: StremioPluginMetaRequest): Promise<StremioPluginMetaResult> {
    if (window.desktopApi?.getStremioMetaByItem) return unwrapStremioPluginResult(await window.desktopApi.getStremioMetaByItem(request));
    throw new Error('Stremio metadata is currently available only in the LoomTV desktop app.');
  },

  async getStremioAddonConfiguration(addonId: string): Promise<StremioPluginConfigurationState> {
    if (window.desktopApi?.getStremioAddonConfiguration) return unwrapStremioPluginResult(await window.desktopApi.getStremioAddonConfiguration(addonId));
    throw new Error('Stremio add-on configuration is currently available only in the LoomTV desktop app.');
  },

  async saveStremioAddonConfiguration(addonId: string, values: Record<string, unknown>): Promise<StremioPluginConfigurationState> {
    if (window.desktopApi?.saveStremioAddonConfiguration) return unwrapStremioPluginResult(await window.desktopApi.saveStremioAddonConfiguration(addonId, values));
    throw new Error('Stremio add-on configuration is currently available only in the LoomTV desktop app.');
  },

  async listStremioPluginAudit(addonId: string, limit?: number): Promise<readonly StremioPluginAuditEntry[]> {
    if (window.desktopApi?.listStremioPluginAudit) return unwrapStremioPluginResult(await window.desktopApi.listStremioPluginAudit(addonId, limit));
    throw new Error('Stremio add-on history is currently available only in the LoomTV desktop app.');
  },

  async saveSettings(settings: SettingsPayload): Promise<boolean> {
    if (window.desktopApi) return window.desktopApi.saveSettings(settings);
    const response = await fetchJson('/api/renderer/settings', okResultSchema, {
      method: 'POST',
      body: JSON.stringify(settings),
    });
    return response.ok;
  },

  async testMetadataKeys(keys: MetadataApiKeys): Promise<MetadataKeyTestResult[]> {
    if (window.desktopApi?.testMetadataKeys) return window.desktopApi.testMetadataKeys(keys);
    return fetchJson('/api/metadata/test-keys', metadataKeyTestResultsSchema, {
      method: 'POST',
      body: JSON.stringify({ keys }),
    });
  },

  // Browser-rendered host sessions use the same authenticated loopback profile
  // endpoints as the Electron renderer instead of falling into an empty gate.
  async listProfiles(): Promise<ProfileSummary[]> {
    if (isRemoteDesktopMode()) {
      const payload = await remoteJson('/api/v2/profiles', desktopProfilesPayloadSchema);
      return payload.profiles || [];
    }
    if (window.desktopApi?.listProfiles) return window.desktopApi.listProfiles();
    const payload = await fetchJson('/api/v2/profiles', desktopProfilesPayloadSchema);
    return payload.profiles || [];
  },

  async chooseProfileAvatar(): Promise<string | null> {
    if (window.desktopApi?.chooseProfileAvatar) return window.desktopApi.chooseProfileAvatar();
    throw new Error('Profile images can only be selected from the LoomTV desktop app.');
  },

  async getActiveProfileState(): Promise<ActiveProfileState> {
    if (isRemoteDesktopMode()) {
      return refreshRemoteActiveProfileState();
    }
    if (window.desktopApi?.getActiveProfileState) return window.desktopApi.getActiveProfileState();
    return fetchJson('/api/v2/profiles/active', desktopActiveProfileSchema);
  },

  async createProfile(input: ProfileCreateInput): Promise<ProfileSummary[]> {
    if (isRemoteDesktopMode()) {
      const payload = await remoteJson('/api/v2/profiles', profileCreateResponseSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return payload.profiles || [payload.profile];
    }
    if (window.desktopApi?.createProfile) return window.desktopApi.createProfile(input);
    throw new Error('Profiles can only be managed from the LoomTV desktop app.');
  },

  async updateProfile(profileId: string, patch: ProfileUpdateInput): Promise<ProfileSummary[]> {
    if (window.desktopApi?.updateProfile) return window.desktopApi.updateProfile(profileId, patch);
    throw new Error('Profiles can only be managed from the LoomTV desktop app.');
  },

  async deleteProfile(profileId: string): Promise<ProfileSummary[]> {
    if (window.desktopApi?.deleteProfile) return window.desktopApi.deleteProfile(profileId);
    throw new Error('Profiles can only be managed from the LoomTV desktop app.');
  },
  async exportProfile(profileId: string): Promise<ProfileTransferResult> {
    return window.desktopApi?.exportProfile?.(profileId) || { ok: false, error: 'Profile export is unavailable.' };
  },
  async importProfile(): Promise<ProfileTransferResult> {
    return window.desktopApi?.importProfile?.() || { ok: false, error: 'Profile import is unavailable.' };
  },

  async selectProfile(profileId: string, pin?: string): Promise<ProfileSummary> {
    if (isRemoteDesktopMode()) {
      const payload = await remoteJson('/api/v2/profiles/select', desktopProfileSelectionSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, pin }),
      });
      updateRemoteDesktopSession({ selectedProfileId: payload.profile.id, selectionRevision: payload.active.selectionRevision });
      return payload.profile;
    }
    if (window.desktopApi?.selectProfile) return window.desktopApi.selectProfile(profileId, pin);
    const payload = await fetchJson('/api/v2/profiles/select', desktopProfileSelectionSchema, {
      method: 'POST',
      body: JSON.stringify({ profileId, pin }),
    });
    return payload.profile;
  },

  async selectGuestProfile(): Promise<ProfileSummary> {
    if (isRemoteDesktopMode()) return this.selectProfile('guest');
    if (window.desktopApi?.selectGuestProfile) return window.desktopApi.selectGuestProfile();
    throw new Error('Guest is available only in the LoomTV desktop app.');
  },

  async lockProfile(): Promise<ActiveProfileState> {
    if (isRemoteDesktopMode()) {
      const state = await remoteJson('/api/v2/profiles/lock', desktopActiveProfileSchema, { method: 'POST' });
      updateRemoteDesktopSession({ selectedProfileId: null, selectionRevision: state.selectionRevision });
      return state;
    }
    if (window.desktopApi?.lockProfile) return window.desktopApi.lockProfile();
    return fetchJson('/api/v2/profiles/lock', desktopActiveProfileSchema, { method: 'POST' });
  },

  async reorderProfiles(profileIds: string[]): Promise<ProfileSummary[]> {
    if (window.desktopApi?.reorderProfiles) return window.desktopApi.reorderProfiles(profileIds);
    throw new Error('Profiles can only be managed from the LoomTV desktop app.');
  },

  async changeProfilePin(profileId: string, pin: string | null): Promise<ProfileSummary> {
    if (window.desktopApi?.changeProfilePin) return window.desktopApi.changeProfilePin(profileId, pin);
    throw new Error('Profile PINs can only be managed from the LoomTV desktop app.');
  },

  async resetOwnerProfile(confirmation: string): Promise<ProfileSummary> {
    if (window.desktopApi?.resetOwnerProfile) return window.desktopApi.resetOwnerProfile(confirmation);
    throw new Error('The Owner can only be reset from the LoomTV desktop app.');
  },

  async setAutomaticProfileSignIn(enabled: boolean): Promise<ActiveProfileState> {
    if (isRemoteDesktopMode()) return remoteJson('/api/v2/profiles/auto-sign-in', desktopActiveProfileSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (window.desktopApi?.setAutomaticProfileSignIn) return window.desktopApi.setAutomaticProfileSignIn(enabled);
    return fetchJson('/api/v2/profiles/auto-sign-in', desktopActiveProfileSchema, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  },

  async getProfilePreferences(): Promise<ProfilePreferences> {
    if (isRemoteDesktopMode()) return remoteJson('/api/v2/profile-preferences', desktopProfilePreferencesSchema);
    if (window.desktopApi?.getProfilePreferences) return window.desktopApi.getProfilePreferences();
    return fetchJson('/api/v2/profile-preferences', desktopProfilePreferencesSchema);
  },

  async saveProfilePreferences(patch: ProfilePreferences, expectedProfileId?: string): Promise<ProfilePreferences> {
    if (isRemoteDesktopMode()) return remoteJson('/api/v2/profile-preferences', desktopProfilePreferencesSchema, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...patch, selectionRevision: getRemoteDesktopSession()?.selectionRevision }),
    });
    if (window.desktopApi?.saveProfilePreferences) return window.desktopApi.saveProfilePreferences(patch, expectedProfileId);
    return fetchJson('/api/v2/profile-preferences', desktopProfilePreferencesSchema, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async getProfileRestrictions(profileId: string): Promise<ProfileRestrictions> {
    if (window.desktopApi?.getProfileRestrictions) return window.desktopApi.getProfileRestrictions(profileId);
    return { country: 'US', maximumAge: null, allowUnrated: false, allowedFolders: [], revision: 0 };
  },

  async saveProfileRestrictions(profileId: string, restrictions: Omit<ProfileRestrictions, 'revision'>): Promise<ProfileRestrictions> {
    if (window.desktopApi?.saveProfileRestrictions) return window.desktopApi.saveProfileRestrictions(profileId, restrictions);
    return { ...restrictions, revision: 0 };
  },

  async getProfileLists(kind?: ProfileListKind): Promise<ProfileListEntry[]> {
    if (isRemoteDesktopMode()) return remoteJson(`/api/v2/profile-lists${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`, desktopProfileListSchema);
    if (window.desktopApi?.getProfileLists) return window.desktopApi.getProfileLists(kind);
    return fetchJson(`/api/v2/profile-lists${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`, desktopProfileListSchema);
  },

  async setProfileListEntry(mediaId: string, kind: ProfileListKind, present: boolean, expectedProfileId?: string): Promise<ProfileListEntry[]> {
    if (isRemoteDesktopMode()) return remoteJson('/api/v2/profile-lists', desktopProfileListSchema, {
      method: present ? 'PUT' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId, kind, selectionRevision: getRemoteDesktopSession()?.selectionRevision }),
    });
    if (window.desktopApi?.setProfileListEntry) return window.desktopApi.setProfileListEntry(mediaId, kind, present, expectedProfileId);
    return fetchJson('/api/v2/profile-lists', desktopProfileListSchema, {
      method: present ? 'PUT' : 'DELETE',
      body: JSON.stringify({ mediaId, kind }),
    });
  },

  onProfilesChanged(callback: (event: ProfilesChangedEvent) => void): () => void {
    return window.desktopApi?.onProfilesChanged?.(callback) || (() => undefined);
  },

  onActiveProfileChanged(callback: (state: ActiveProfileState) => void): () => void {
    return window.desktopApi?.onActiveProfileChanged?.(callback) || (() => undefined);
  },

  async getProgress(filePath?: string): Promise<Record<string, StoredProgress> | StoredProgress | null> {
    if (isRemoteDesktopMode()) {
      const all = await remoteJson('/api/v2/progress', desktopProgressMapSchema);
      return filePath ? all[remoteResourceId(filePath)] || null : remoteProgressByStreamUrl(all);
    }
    if (window.desktopApi?.getProgress) return window.desktopApi.getProgress(filePath);
    const all = await fetchJson('/api/v2/progress', desktopProgressMapSchema);
    return filePath ? all[remoteResourceId(filePath)] || null : all;
  },

  async saveProgress(filePath: string, position: number, duration: number, expectedProfileId?: string): Promise<StoredProgress> {
    if (isRemoteDesktopMode()) return remoteJson('/api/v2/progress', desktopStoredProgressSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: remoteResourceId(filePath),
        position,
        duration,
        selectionRevision: getRemoteDesktopSession()?.selectionRevision,
      }),
    });
    if (window.desktopApi?.saveProgress) return window.desktopApi.saveProgress(filePath, position, duration, expectedProfileId);
    return fetchJson('/api/v2/progress', desktopStoredProgressSchema, {
      method: 'POST',
      body: JSON.stringify({ mediaId: remoteResourceId(filePath), position, duration }),
    });
  },

  async importProgress(progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>, expectedProfileId?: string): Promise<boolean> {
    if (isRemoteDesktopMode()) return true;
    if (window.desktopApi?.importProgress) return window.desktopApi.importProgress(progress, expectedProfileId);
    // Browser /app/ sessions already read the host database directly. The
    // legacy import route is intentionally Electron IPC-only.
    if (isBrowserLocalApp()) return true;
    const response = await fetchJson('/api/progress/import', okResultSchema, {
      method: 'POST',
      body: JSON.stringify({ progress }),
    });
    return response.ok;
  },

  async getPlaybackTrackPreferences(scope?: string): Promise<PlaybackTrackPreferences | Record<string, PlaybackTrackPreferences>> {
    if (isRemoteDesktopMode()) {
      const query = scope ? `?scope=${encodeURIComponent(scope)}` : '';
      return remoteJson(`/api/v2/playback-track-preferences${query}`, playbackTrackPreferencesResultSchema);
    }
    if (window.desktopApi?.getPlaybackTrackPreferences) return window.desktopApi.getPlaybackTrackPreferences(scope);
    const query = scope ? `?scope=${encodeURIComponent(scope)}` : '';
    return fetchJson(`/api/v2/playback-track-preferences${query}`, playbackTrackPreferencesResultSchema);
  },

  async savePlaybackTrackPreferences(scope: string, preferences: PlaybackTrackPreferences, expectedProfileId?: string): Promise<PlaybackTrackPreferences> {
    if (isRemoteDesktopMode()) return remoteJson('/api/v2/playback-track-preferences', playbackTrackPreferencesSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, preferences, selectionRevision: getRemoteDesktopSession()?.selectionRevision }),
    });
    if (window.desktopApi?.savePlaybackTrackPreferences) return window.desktopApi.savePlaybackTrackPreferences(scope, preferences, expectedProfileId);
    return fetchJson('/api/v2/playback-track-preferences', playbackTrackPreferencesSchema, {
      method: 'POST',
      body: JSON.stringify({ scope, preferences }),
    });
  },

  async getMediaSegments(request: MediaSegmentRequest): Promise<MediaSegmentResponse> {
    if (isRemoteDesktopMode()) {
      const params = new URLSearchParams({ mediaId: request.mediaId });
      if (typeof request.season === 'number') params.set('season', String(request.season));
      if (typeof request.episode === 'number') params.set('episode', String(request.episode));
      return remoteJson(`/api/v2/playback/segments?${params.toString()}`, mediaSegmentResponseSchema);
    }
    if (window.desktopApi?.getMediaSegments) return window.desktopApi.getMediaSegments(request);
    const params = new URLSearchParams({ mediaId: request.mediaId });
    if (typeof request.season === 'number') params.set('season', String(request.season));
    if (typeof request.episode === 'number') params.set('episode', String(request.episode));
    return fetchJson(`/api/playback/segments?${params.toString()}`, mediaSegmentResponseSchema);
  },

  async saveManualMediaSegment(input: ManualMediaSegmentInput): Promise<MediaSegmentResponse> {
    if (!window.desktopApi?.saveManualMediaSegment) throw new Error('Manual markers are available in the desktop app.');
    return window.desktopApi.saveManualMediaSegment(input);
  },

  async deleteManualMediaSegment(input: MediaSegmentRequest & { candidateId?: string; type: MediaSegmentType }): Promise<MediaSegmentResponse> {
    if (!window.desktopApi?.deleteManualMediaSegment) throw new Error('Manual markers are available in the desktop app.');
    return window.desktopApi.deleteManualMediaSegment(input);
  },

  async undoManualMediaSegment(input: MediaSegmentRequest & { candidateId?: string; type: MediaSegmentType }): Promise<MediaSegmentResponse> {
    if (!window.desktopApi?.undoManualMediaSegment) throw new Error('Manual markers are available in the desktop app.');
    return window.desktopApi.undoManualMediaSegment(input);
  },

  async getManagedMediaSegments(request?: Partial<MediaSegmentRequest>): Promise<ManagedMediaSegment[]> {
    if (!window.desktopApi?.getManagedMediaSegments) return [];
    return window.desktopApi.getManagedMediaSegments(request);
  },

  async updateManagedMediaSegment(candidateId: string, patch: { status?: ManagedMediaSegment['status']; type?: MediaSegmentType }): Promise<boolean> {
    if (!window.desktopApi?.updateManagedMediaSegment) return false;
    return window.desktopApi.updateManagedMediaSegment(candidateId, patch);
  },

  async eraseManagedMediaSegments(request: MediaSegmentRequest): Promise<{ removed: number }> {
    if (!window.desktopApi?.eraseManagedMediaSegments) return { removed: 0 };
    return window.desktopApi.eraseManagedMediaSegments(request);
  },

  async setPlaybackActivity(key: string, active: boolean, label?: string): Promise<boolean> {
    if (!window.desktopApi?.setPlaybackActivity) return false;
    return window.desktopApi.setPlaybackActivity(key, active, label);
  },

  async getLocalSegmentAnalysisStatus(): Promise<LocalSegmentAnalysisStatus> {
    if (!window.desktopApi?.getLocalSegmentAnalysisStatus) return { enabled: false, available: false, helperPath: null, state: 'unavailable' };
    return window.desktopApi.getLocalSegmentAnalysisStatus();
  },

  async analyzeLocalSegmentSeason(mediaId: string, season: number): Promise<MediaSegmentResponse> {
    if (!window.desktopApi?.analyzeLocalSegmentSeason) throw new Error('Local analysis is available in the desktop app.');
    return window.desktopApi.analyzeLocalSegmentSeason(mediaId, season);
  },

  async runLocalSegmentAnalysis(scope?: SkipAnalysisRunScope): Promise<{ queued: number }> {
    if (!window.desktopApi?.runLocalSegmentAnalysis) throw new Error('Local analysis is available in the desktop app.');
    return window.desktopApi.runLocalSegmentAnalysis(scope);
  },

  async cancelLocalSegmentAnalysis(request?: { jobKey?: string; kind?: 'manual' }): Promise<{ cancelled: number }> {
    if (!window.desktopApi?.cancelLocalSegmentAnalysis) return { cancelled: 0 };
    return window.desktopApi.cancelLocalSegmentAnalysis(request);
  },

  async pauseLocalSegmentAnalysis(): Promise<boolean> {
    return window.desktopApi?.pauseLocalSegmentAnalysis?.() ?? false;
  },

  async resumeLocalSegmentAnalysis(): Promise<boolean> {
    return window.desktopApi?.resumeLocalSegmentAnalysis?.() ?? false;
  },

  async cleanupLocalSegmentAnalysis(): Promise<{ queued: number }> {
    if (!window.desktopApi?.cleanupLocalSegmentAnalysis) return { queued: 0 };
    return window.desktopApi.cleanupLocalSegmentAnalysis();
  },

  async rebuildLocalSegmentAnalysis(): Promise<{ removed: number; queued: number }> {
    if (!window.desktopApi?.rebuildLocalSegmentAnalysis) return { removed: 0, queued: 0 };
    return window.desktopApi.rebuildLocalSegmentAnalysis();
  },

  async getCustomArtwork(mediaId: string): Promise<Record<string, string>> {
    if (window.desktopApi?.getCustomArtwork) return window.desktopApi.getCustomArtwork(mediaId);
    return fetchJson(`/api/renderer/artwork?mediaId=${encodeURIComponent(mediaId)}`, stringRecordSchema);
  },

  async saveCustomArtwork(mediaId: string, target: string, dataUrl: string): Promise<Record<string, string>> {
    if (window.desktopApi?.saveCustomArtwork) return window.desktopApi.saveCustomArtwork(mediaId, target, dataUrl);
    return fetchJson('/api/renderer/artwork', stringRecordSchema, {
      method: 'POST',
      body: JSON.stringify({ mediaId, target, dataUrl }),
    });
  },

  async refreshOfficialArtwork(mediaId: string, target: OfficialArtworkRefreshTarget = 'all'): Promise<OfficialArtworkResult> {
    if (window.desktopApi?.refreshOfficialArtwork) return window.desktopApi.refreshOfficialArtwork(mediaId, target);
    return fetchJson('/api/artwork/refresh-official', officialArtworkResultSchema, {
      method: 'POST',
      body: JSON.stringify({ mediaId, target }),
    });
  },

  async getStreamingProviders(mediaId: string): Promise<StreamingProvider[]> {
    if (window.desktopApi?.getStreamingProviders) return window.desktopApi.getStreamingProviders(mediaId);
    return fetchJson('/api/metadata/streaming-providers', z.array(lanStreamingProviderSchema), {
      method: 'POST',
      body: JSON.stringify({ mediaId }),
    });
  },

  async refreshIncompleteMetadata(mediaId: string): Promise<boolean> {
    if (window.desktopApi?.refreshIncompleteMetadata) return window.desktopApi.refreshIncompleteMetadata(mediaId);
    return fetchJson('/api/renderer/metadata/refresh-incomplete', z.boolean(), {
      method: 'POST',
      body: JSON.stringify({ mediaId }),
    });
  },

  async requestMetadataProvider(request: import('@/shared/desktopProtocol').MetadataProviderRequest): Promise<unknown> {
    if (window.desktopApi?.requestMetadataProvider) return window.desktopApi.requestMetadataProvider(request);
    return fetchJson('/api/renderer/metadata/provider', z.unknown(), {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  async getPlaybackLogo(mediaId: string): Promise<PlaybackLogoResult> {
    if (window.desktopApi?.getPlaybackLogo) return window.desktopApi.getPlaybackLogo(mediaId);
    return fetchJson('/api/artwork/playback-logo', playbackLogoResultSchema, {
      method: 'POST',
      body: JSON.stringify({ mediaId }),
    });
  },

  async getOfficialMetadataCandidates(mediaId: string): Promise<OfficialMetadataCandidate[]> {
    if (window.desktopApi?.getOfficialMetadataCandidates) return window.desktopApi.getOfficialMetadataCandidates(mediaId);
    return fetchJson('/api/renderer/artwork/official-candidates', z.array(officialMetadataCandidateSchema), {
      method: 'POST',
      body: JSON.stringify({ mediaId }),
    });
  },

  async applyOfficialMetadata(mediaId: string, candidate: OfficialMetadataCandidate, target: OfficialMetadataApplyTarget = 'all'): Promise<OfficialArtworkResult> {
    if (window.desktopApi?.applyOfficialMetadata) return window.desktopApi.applyOfficialMetadata(mediaId, candidate, target);
    return fetchJson('/api/renderer/artwork/apply-official', officialArtworkResultSchema, {
      method: 'POST',
      body: JSON.stringify({ mediaId, candidate, target }),
    });
  },

  async importCustomArtwork(entries: Record<string, Record<string, string>>): Promise<boolean> {
    if (window.desktopApi?.importCustomArtwork) return window.desktopApi.importCustomArtwork(entries);
    const response = await fetchJson('/api/artwork/import', okResultSchema, {
      method: 'POST',
      body: JSON.stringify({ entries }),
    });
    return response.ok;
  },

  async backupDatabase(): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (window.desktopApi?.backupDatabase) return window.desktopApi.backupDatabase();
    return fetchJson('/api/database/backup', backupResultSchema, { method: 'POST' });
  },

  async clearAppData(): Promise<LibraryIndexPayload> {
    if (window.desktopApi?.clearAppData) return window.desktopApi.clearAppData();
    return fetchJson('/api/database/clear', desktopLibraryIndexSchema, { method: 'POST' });
  },

  openExternal(url: string): void {
    if (window.desktopApi?.openExternal) {
      void window.desktopApi.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  },

  async openFolderPath(filePath: string): Promise<void> {
    if (window.desktopApi?.openFolderPath) {
      await window.desktopApi.openFolderPath(filePath);
    }
  },

  async getUpdateState(): Promise<UpdateState> {
    if (window.desktopApi?.getUpdateState) return window.desktopApi.getUpdateState();
    return {
      status: 'disabled',
      currentVersion: APP_VERSION,
      platform: 'browser' as NodeJS.Platform,
      arch: 'unknown',
      supported: false,
      message: 'Automatic updates are only available in the desktop app.',
    };
  },

  async checkForUpdates(): Promise<UpdateState> {
    if (window.desktopApi?.checkForUpdates) return window.desktopApi.checkForUpdates();
    try {
      const response = await fetch('https://api.github.com/repos/mallenkb/LoomTV/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) throw new Error(`Update check returned ${response.status}`);
      const release = await readJsonResponse(response, githubReleaseSchema, 'GitHub release');
      const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
      return {
        status: 'available',
        currentVersion: APP_VERSION,
        platform: 'browser' as NodeJS.Platform,
        arch: 'unknown',
        supported: false,
        latestVersion,
        releaseUrl: release.html_url,
        checkedAt: new Date().toISOString(),
        message: latestVersion
          ? `Latest release is LoomTV ${latestVersion}.`
          : 'Checked for updates.',
      };
    } catch (error) {
      return {
        status: 'error',
        currentVersion: APP_VERSION,
        platform: 'browser' as NodeJS.Platform,
        arch: 'unknown',
        supported: false,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
    }
  },

  async installUpdate(): Promise<UpdateState> {
    if (window.desktopApi?.installUpdate) return window.desktopApi.installUpdate();
    return this.getUpdateState();
  },

  onUpdateState(callback: (state: UpdateState) => void): () => void {
    if (window.desktopApi?.onUpdateState) return window.desktopApi.onUpdateState(callback);
    return () => undefined;
  },

  async playMedia(filePath: string): Promise<boolean> {
    if (window.desktopApi) return window.desktopApi.playMedia(filePath);
    const response = await fetchJson('/api/play-media', okResultSchema, {
      method: 'POST',
      body: JSON.stringify({ filePath }),
    });
    return response.ok;
  },

  mpv: {
    async availability(): Promise<MpvAvailability> {
      if (isRemoteDesktopMode() || !window.desktopApi?.mpv) {
        return { available: false, reason: 'mpv playback is available for local files in the desktop app.' };
      }
      return window.desktopApi.mpv.availability();
    },

    async chooseExecutable(): Promise<MpvAvailability> {
      if (isRemoteDesktopMode() || !window.desktopApi?.mpv) {
        return { available: false, reason: 'mpv configuration is available in the local desktop app.' };
      }
      return window.desktopApi.mpv.chooseExecutable();
    },

    async resetExecutable(): Promise<MpvAvailability> {
      if (isRemoteDesktopMode() || !window.desktopApi?.mpv) {
        return { available: false, reason: 'mpv configuration is available in the local desktop app.' };
      }
      return window.desktopApi.mpv.resetExecutable();
    },

    async refreshAvailability(): Promise<MpvAvailability> {
      if (isRemoteDesktopMode() || !window.desktopApi?.mpv) {
        return { available: false, reason: 'mpv playback is available for local files in the desktop app.' };
      }
      return window.desktopApi.mpv.refreshAvailability();
    },

    async start(filePath: string, options?: MpvStartOptions): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
      if (isRemoteDesktopMode() || !window.desktopApi?.mpv) {
        return { ok: false, error: 'mpv playback is unavailable for this media source.' };
      }
      return window.desktopApi.mpv.start(filePath, options);
    },

    async command(sessionId: string, command: MpvCommand): Promise<boolean> {
      return window.desktopApi?.mpv?.command(sessionId, command) ?? false;
    },

    async stop(sessionId: string): Promise<boolean> {
      return window.desktopApi?.mpv?.stop(sessionId) ?? false;
    },

    onState(callback: (state: MpvPlaybackState) => void): () => void {
      return window.desktopApi?.mpv?.onState(callback) || (() => undefined);
    },
  },

  libvlc: {
    async availability(): Promise<LibVlcAvailability> {
      if (isRemoteDesktopMode() || !window.desktopApi?.libvlc) {
        return {
          available: false,
          enabled: false,
          surface: 'unavailable',
          reason: 'The LibVLC bridge is not available for this desktop session.',
        };
      }
      return window.desktopApi.libvlc.availability();
    },

    async refreshAvailability(): Promise<LibVlcAvailability> {
      if (isRemoteDesktopMode() || !window.desktopApi?.libvlc) {
        return {
          available: false,
          enabled: false,
          surface: 'unavailable',
          reason: 'The LibVLC bridge is not available for this desktop session.',
        };
      }
      return window.desktopApi.libvlc.refreshAvailability();
    },

    async start(filePath: string, options?: PlaybackStartOptions): Promise<LibVlcStartResult> {
      if (isRemoteDesktopMode() || !window.desktopApi?.libvlc) {
        return { ok: false, surface: 'unavailable', error: 'LibVLC playback is unavailable for this media source.' };
      }
      return window.desktopApi.libvlc.start(filePath, options);
    },

    async command(sessionId: string, command: LibVlcCommand): Promise<boolean> {
      return window.desktopApi?.libvlc?.command(sessionId, command) ?? false;
    },

    async stop(sessionId: string): Promise<boolean> {
      return window.desktopApi?.libvlc?.stop(sessionId) ?? false;
    },

    async syncSurface(): Promise<boolean> {
      return window.desktopApi?.libvlc?.syncSurface() ?? false;
    },

    async setFullscreenTransition(transitioning: boolean, waitForFinalViewport = true): Promise<boolean> {
      return window.desktopApi?.libvlc?.setFullscreenTransition(transitioning, waitForFinalViewport) ?? false;
    },

    async setViewport(viewport: PlaybackViewport): Promise<boolean> {
      return window.desktopApi?.libvlc?.setViewport(viewport) ?? false;
    },

    onState(callback: (state: LibVlcPlaybackState) => void): () => void {
      return window.desktopApi?.libvlc?.onState(callback) || (() => undefined);
    },
  },

  media: {
    async probe(filePath: string): Promise<ApiResult<unknown>> {
      if (isRemoteDesktopMode() && /^https?:\/\//i.test(filePath)) {
        return { ok: false, error: 'Media probing is handled by the paired host.' };
      }
      if (window.desktopApi?.media) return window.desktopApi.media.probe(filePath);
      return fetchJson('/api/renderer/media/probe', unknownApiResultSchema, {
        method: 'POST',
        body: JSON.stringify({ filePath }),
      });
    },

    async canDirectPlay(filePath: string, backend: 'html5' | 'hls' = 'html5'): Promise<ApiResult<boolean>> {
      if (isRemoteDesktopMode() && /^https?:\/\//i.test(filePath)) return { ok: true, data: backend === 'html5' };
      if (window.desktopApi?.media) return window.desktopApi.media.canDirectPlay(filePath, backend);
      const probeResult = await this.probe(filePath);
      return probeResult.ok ? { ok: true, data: backend === 'html5' } : { ok: false, error: probeResult.error };
    },

    async getPlaybackPlan(filePath: string, capabilities?: PlaybackCapabilities): Promise<PlaybackPlanResponse | null> {
      return remotePlaybackPlan(filePath, capabilities);
    },

    async startTranscode(filePath: string, options?: TranscodeOptions): Promise<ApiResult<TranscodeSession>> {
      if (isRemoteDesktopMode()) {
        await refreshRemoteActiveProfileState();
        const result = await remoteJson('/api/v2/start-hls', apiResultSchema(transcodeSessionSchema), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mediaId: remoteResourceId(filePath),
            options,
            selectionRevision: getRemoteDesktopSession()?.selectionRevision,
          }),
        });
        if (result.ok && result.data?.playlistUrl) {
          return { ...result, data: { ...result.data, playlistUrl: remoteMediaSource(result.data.playlistUrl) } };
        }
        return result;
      }
      if (window.desktopApi?.media) return window.desktopApi.media.startTranscode(filePath, options);
      return fetchJson('/api/renderer/media/start-transcode', apiResultSchema(transcodeSessionSchema), {
        method: 'POST',
        body: JSON.stringify({ filePath, options }),
      });
    },

    async stopTranscode(sessionId: string): Promise<ApiResult<boolean>> {
      if (isRemoteDesktopMode()) return { ok: true, data: true };
      if (window.desktopApi?.media) return window.desktopApi.media.stopTranscode(sessionId);
      return fetchJson('/api/renderer/media/stop-transcode', apiResultSchema(z.boolean()), {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      });
    },
  },
};
