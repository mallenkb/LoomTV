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
  OfficialArtworkResult,
  OfficialArtworkRefreshTarget,
  OfficialMetadataApplyTarget,
  OfficialMetadataCandidate,
  PlaybackLogoResult,
  PlaybackMode,
  PlaybackTrackPreferences,
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
} from '../shared/desktopProtocol.ts';
import {
  clearRemoteDesktopSession,
  getRemoteDesktopSession,
  isRemoteDesktopMode,
  remoteProfileSessionPatch,
  remoteResourceId,
  saveRemoteDesktopSession,
  setDesktopLibraryMode,
  updateRemoteDesktopSession,
} from './remoteDesktop';
export type {
  ActiveProfileState,
  ApiResult,
  LibraryFolderKind,
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
  MpvAvailability,
  MpvCommand,
  MpvPlaybackState,
  MpvStartOptions,
  OfficialArtworkResult,
  OfficialArtworkRefreshTarget,
  OfficialMetadataApplyTarget,
  OfficialMetadataCandidate,
  PlaybackLogoResult,
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
  SubtitleStyleOptions,
  TranscodeOptions,
  TranscodeSession,
  UpdateState,
} from '../shared/desktopProtocol.ts';
export type { MpvPlaybackTrack } from '../shared/desktopProtocol.ts';
export type { SkipAnalysisSettings } from '../shared/desktopProtocol.ts';
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION = typeof __APP_VERSION__ === 'string' && __APP_VERSION__
  ? __APP_VERSION__
  : packageJson.version || 'dev';

export type DesktopBridgeApi = {
      getLibrary: () => Promise<LibraryPayload>;
      scanLibrary: (options?: { force?: boolean; mode?: LibraryScanMode }) => Promise<LibraryPayload>;
      onLibraryScanProgress?: (callback: (library: LibraryPayload, progress: LibraryScanProgress) => void) => () => void;
      addLibraryFolder: (kind?: LibraryFolderKind) => Promise<LibraryPayload | null>;
      removeLibraryFolder: (folderPath: string) => Promise<LibraryPayload>;
      playMedia: (filePath: string) => Promise<boolean>;
      getStreamUrl: (filePath: string, options?: StreamUrlOptions) => Promise<StreamUrlResult>;
      getSubtitleUrl?: (filePath: string, streamOrdinal?: number) => Promise<{ url: string }>;
      getThumbnail: (filePath: string, time?: string) => Promise<{ url: string }>;
      getFileInfo: (filePath: string) => Promise<{ size: number; path: string; exists: boolean }>;
      getServerBase: () => Promise<string>;
      checkFFmpeg: () => Promise<FFmpegStatus>;
      getSettings: () => Promise<SettingsPayload>;
      saveSettings: (settings: SettingsPayload) => Promise<boolean>;
      testMetadataKeys?: (keys: MetadataApiKeys) => Promise<MetadataKeyTestResult[]>;
      getLocalNetworkStatus?: () => Promise<LocalNetworkStatus>;
      discoverLocalNetworkPeers?: (timeoutMs?: number) => Promise<LocalNetworkPeer[]>;
      connectRemoteLibrary?: (baseUrl: string, code: string, certFingerprint?: string) => Promise<RemoteLibraryConnection>;
      remoteLibraryRequest?: (pathname: string, request?: RemoteLibraryRequest) => Promise<RemoteLibraryResponse>;
      getRemoteLibrarySession?: () => Promise<RemoteLibrarySessionState>;
      disconnectRemoteLibrary?: (revoke?: boolean) => Promise<boolean>;
      revokePairedDevice?: (deviceId: string) => Promise<LocalNetworkPairedDevice[]>;
      setLocalNetworkDeviceName?: (name: string) => Promise<string>;
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
      importCustomArtwork?: (entries: Record<string, Record<string, string>>) => Promise<boolean>;
      backupDatabase?: () => Promise<{ ok: boolean; path?: string; error?: string }>;
      clearAppData?: () => Promise<LibraryPayload>;
      openExternal?: (url: string) => Promise<void>;
      openFolderPath?: (filePath: string) => Promise<boolean>;
      getUpdateState?: () => Promise<UpdateState>;
      checkForUpdates?: () => Promise<UpdateState>;
      installUpdate?: () => Promise<UpdateState>;
      onUpdateState?: (callback: (state: UpdateState) => void) => () => void;
      mpv?: {
        availability: () => Promise<MpvAvailability>;
        start: (filePath: string, options?: MpvStartOptions) => Promise<{ ok: boolean; sessionId?: string; error?: string }>;
        command: (sessionId: string, command: MpvCommand) => Promise<boolean>;
        stop: (sessionId: string) => Promise<boolean>;
        onState: (callback: (state: MpvPlaybackState) => void) => () => void;
      };
      media?: {
        probe: (filePath: string) => Promise<ApiResult<unknown>>;
        canDirectPlay: (filePath: string, backend?: 'html5' | 'hls') => Promise<ApiResult<boolean>>;
        startTranscode: (filePath: string, options?: TranscodeOptions) => Promise<ApiResult<TranscodeSession>>;
        stopTranscode: (sessionId: string) => Promise<ApiResult<boolean>>;
      };
};

declare global {
  interface Window {
    desktopApi?: DesktopBridgeApi;
  }
}

const DEFAULT_MEDIA_PORT = 3847;
const LOCAL_ACCESS_QUERY_PARAM = 'loomtvToken';
const LOCAL_ACCESS_HEADER = 'x-loomtv-token';
let resolvedServerBase: string | null = null;
let resolvedLocalAccessToken: string | null = null;

async function discoverServerBase(): Promise<string> {
  if (resolvedServerBase) return resolvedServerBase;

  const candidatePorts = Array.from({ length: 8 }, (_, index) => DEFAULT_MEDIA_PORT + index);
  for (const port of candidatePorts) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`);
      if (response.ok) {
        let localAccessToken: string | null = null;
        if (!window.desktopApi) {
          // Browser-only development sessions obtain renderer authority from
          // an origin-checked endpoint. Generic health discovery never returns
          // credentials to originless localhost callers.
          const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/renderer/session`, {
            method: 'POST',
          });
          if (!sessionResponse.ok) continue;
          const session = await sessionResponse.json().catch(() => null) as { localAccessToken?: string } | null;
          if (typeof session?.localAccessToken !== 'string') continue;
          localAccessToken = session.localAccessToken;
        }
        resolvedServerBase = `http://127.0.0.1:${port}`;
        resolvedLocalAccessToken = localAccessToken;
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

async function fetchJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const request = async () => {
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

  let response = await request();
  if (!window.desktopApi && response.status === 401) {
    resolvedServerBase = null;
    resolvedLocalAccessToken = null;
    response = await request();
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
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
  const credentials = await response.json() as Pick<RemoteLibraryConnection,
    'deviceToken' | 'accessTokenExpiresAt' | 'refreshToken' | 'refreshTokenExpiresAt'> & { accessToken?: string };
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

async function remoteJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await remoteRequest(pathname, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `The host returned ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

function remoteProgressByStreamUrl(progress: Record<string, StoredProgress>): Record<string, StoredProgress> {
  const library = getRemoteDesktopSession()?.library;
  if (!library) return progress;
  const mapped: Record<string, StoredProgress> = {};
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
  };
}

async function refreshRemoteActiveProfileState(): Promise<ActiveProfileState> {
  const response = await remoteRequest('/api/v2/profiles/active');
  if (response.status === 409) {
    return { profileId: null, selectionRequired: true, selectionRevision: 0, automaticSignIn: false };
  }
  if (!response.ok) throw new Error('Could not read the active profile from the host.');
  const state = await response.json() as ActiveProfileState;
  updateRemoteDesktopSession(remoteProfileSessionPatch(state));
  return state;
}

export const desktopApi = {
  async getLibrary(): Promise<LibraryPayload> {
    if (isRemoteDesktopMode()) {
      const response = await remoteRequest('/api/v2/library');
      if (!response.ok) {
        if (response.status === 409) throw new Error('Select a profile from the host first.');
        throw new Error(response.status === 401 ? 'Pairing was revoked on the host.' : 'Could not load the shared library.');
      }
      const library = remoteLibrarySources(await response.json() as LibraryPayload);
      const session = getRemoteDesktopSession();
      if (session) updateRemoteDesktopSession({ library, libraryEtag: response.headers.get('ETag') || session.libraryEtag });
      return library;
    }
    if (window.desktopApi) return window.desktopApi.getLibrary();
    return fetchJson<LibraryPayload>('/api/renderer/library');
  },

  async getStreamUrl(filePath: string, options: StreamUrlOptions = {}): Promise<StreamUrlResult> {
    if (isRemoteDesktopMode() && /^https?:\/\//i.test(filePath)) {
      let fileName = 'Remote stream';
      try { fileName = new URL(filePath).pathname.split('/').pop() || fileName; } catch { /* Keep fallback. */ }
      return {
        url: remoteMediaSource(filePath),
        contentType: 'video/mp4',
        fileName,
        isTranscoded: false,
        isRemuxed: false,
        playbackMode: 'direct-stream',
        decisionReason: 'Signed stream supplied by the paired LoomTV host',
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
    if (options.subtitleFilePath) params.set('subtitleFile', options.subtitleFilePath);
    if (typeof options.secondarySubtitleTrackIndex === 'number') params.set('secondarySubtitle', String(options.secondarySubtitleTrackIndex));
    if (typeof options.secondarySubtitleStreamOrdinal === 'number') params.set('secondarySubtitleOrdinal', String(options.secondarySubtitleStreamOrdinal));
    if (options.secondarySubtitleCodec) params.set('secondarySubtitleCodec', options.secondarySubtitleCodec);
    if (options.secondarySubtitleFilePath) params.set('secondarySubtitleFile', options.secondarySubtitleFilePath);
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

  async getLocalNetworkStatus(): Promise<LocalNetworkStatus> {
    if (window.desktopApi?.getLocalNetworkStatus) return window.desktopApi.getLocalNetworkStatus();
    return fetchJson<LocalNetworkStatus>('/api/lan/status');
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

    throw new Error('Secure host pairing is available in the installed LoomTV desktop app.');
  },

  activateRemoteLibrary(connection: RemoteLibraryConnection): void {
    saveRemoteDesktopSession(connection);
    setDesktopLibraryMode('remote');
  },

  useThisComputerAsHost(): void {
    setDesktopLibraryMode('host');
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
        library: remoteLibrarySources(await response.json() as LibraryPayload),
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
      const credentials = await refreshResponse.json() as {
        accessToken: string;
        accessTokenExpiresAt: number;
        refreshToken: string;
        refreshTokenExpiresAt: number;
      };
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
    const library = await response.json() as LibraryPayload;
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

  async scanLibrary(mode: LibraryScanMode = 'quick'): Promise<LibraryPayload> {
    if (window.desktopApi) return window.desktopApi.scanLibrary({ force: mode === 'full', mode });
    // Folder scanning is owned by Electron. In a browser renderer, refresh the
    // shared desktop snapshot instead of calling the intentionally IPC-only
    // scan route.
    return this.getLibrary();
  },

  onLibraryScanProgress(callback: (library: LibraryPayload, progress: LibraryScanProgress) => void): () => void {
    return window.desktopApi?.onLibraryScanProgress?.(callback) || (() => undefined);
  },

  async addLibraryFolder(kind: LibraryFolderKind = 'movies'): Promise<LibraryPayload | null> {
    if (window.desktopApi) return window.desktopApi.addLibraryFolder(kind);
    return fetchJson<LibraryPayload | null>('/api/library/add-folder', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    });
  },

  async removeLibraryFolder(folderPath: string): Promise<LibraryPayload> {
    if (window.desktopApi) return window.desktopApi.removeLibraryFolder(folderPath);
    return fetchJson<LibraryPayload>('/api/library/remove-folder', {
      method: 'POST',
      body: JSON.stringify({ folderPath }),
    });
  },

  async getMediaServerPort(): Promise<number> {
    if (window.desktopApi) {
      const base = await window.desktopApi.getServerBase();
      const parsed = new URL(base);
      return Number(parsed.port || DEFAULT_MEDIA_PORT);
    }
    const response = await fetchJson<{ port: number }>('/api/media-server-port');
    return response.port;
  },

  async checkFFmpeg(): Promise<FFmpegStatus> {
    if (window.desktopApi) return window.desktopApi.checkFFmpeg();
    return fetchJson<FFmpegStatus>('/api/renderer/ffmpeg');
  },

  async getSettings(): Promise<SettingsPayload> {
    if (window.desktopApi) return window.desktopApi.getSettings();
    return fetchJson<SettingsPayload>('/api/renderer/settings');
  },

  async saveSettings(settings: SettingsPayload): Promise<boolean> {
    if (window.desktopApi) return window.desktopApi.saveSettings(settings);
    const response = await fetchJson<{ ok: boolean }>('/api/renderer/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
    return response.ok;
  },

  async testMetadataKeys(keys: MetadataApiKeys): Promise<MetadataKeyTestResult[]> {
    if (window.desktopApi?.testMetadataKeys) return window.desktopApi.testMetadataKeys(keys);
    return fetchJson<MetadataKeyTestResult[]>('/api/metadata/test-keys', {
      method: 'POST',
      body: JSON.stringify({ keys }),
    });
  },

  // Browser-rendered host sessions use the same authenticated loopback profile
  // endpoints as the Electron renderer instead of falling into an empty gate.
  async listProfiles(): Promise<ProfileSummary[]> {
    if (isRemoteDesktopMode()) {
      const payload = await remoteJson<{ profiles: ProfileSummary[] }>('/api/v2/profiles');
      return payload.profiles || [];
    }
    if (window.desktopApi?.listProfiles) return window.desktopApi.listProfiles();
    const payload = await fetchJson<{ profiles: ProfileSummary[] }>('/api/v2/profiles');
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
    return fetchJson<ActiveProfileState>('/api/v2/profiles/active');
  },

  async createProfile(input: ProfileCreateInput): Promise<ProfileSummary[]> {
    if (isRemoteDesktopMode()) {
      const payload = await remoteJson<{ profile: ProfileSummary; profiles: ProfileSummary[] }>('/api/v2/profiles', {
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
      const payload = await remoteJson<{ profile: ProfileSummary; active: ActiveProfileState }>('/api/v2/profiles/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, pin }),
      });
      updateRemoteDesktopSession({ selectedProfileId: payload.profile.id, selectionRevision: payload.active.selectionRevision });
      return payload.profile;
    }
    if (window.desktopApi?.selectProfile) return window.desktopApi.selectProfile(profileId, pin);
    const payload = await fetchJson<{ profile: ProfileSummary; active: ActiveProfileState }>('/api/v2/profiles/select', {
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
      const state = await remoteJson<ActiveProfileState>('/api/v2/profiles/lock', { method: 'POST' });
      updateRemoteDesktopSession({ selectedProfileId: null, selectionRevision: state.selectionRevision });
      return state;
    }
    if (window.desktopApi?.lockProfile) return window.desktopApi.lockProfile();
    return fetchJson<ActiveProfileState>('/api/v2/profiles/lock', { method: 'POST' });
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
    if (isRemoteDesktopMode()) return remoteJson<ActiveProfileState>('/api/v2/profiles/auto-sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (window.desktopApi?.setAutomaticProfileSignIn) return window.desktopApi.setAutomaticProfileSignIn(enabled);
    return fetchJson<ActiveProfileState>('/api/v2/profiles/auto-sign-in', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  },

  async getProfilePreferences(): Promise<ProfilePreferences> {
    if (isRemoteDesktopMode()) return remoteJson<ProfilePreferences>('/api/v2/profile-preferences');
    if (window.desktopApi?.getProfilePreferences) return window.desktopApi.getProfilePreferences();
    return fetchJson<ProfilePreferences>('/api/v2/profile-preferences');
  },

  async saveProfilePreferences(patch: ProfilePreferences, expectedProfileId?: string): Promise<ProfilePreferences> {
    if (isRemoteDesktopMode()) return remoteJson<ProfilePreferences>('/api/v2/profile-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...patch, selectionRevision: getRemoteDesktopSession()?.selectionRevision }),
    });
    if (window.desktopApi?.saveProfilePreferences) return window.desktopApi.saveProfilePreferences(patch, expectedProfileId);
    return fetchJson<ProfilePreferences>('/api/v2/profile-preferences', {
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
    if (isRemoteDesktopMode()) return remoteJson<ProfileListEntry[]>(`/api/v2/profile-lists${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);
    if (window.desktopApi?.getProfileLists) return window.desktopApi.getProfileLists(kind);
    return fetchJson<ProfileListEntry[]>(`/api/v2/profile-lists${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);
  },

  async setProfileListEntry(mediaId: string, kind: ProfileListKind, present: boolean, expectedProfileId?: string): Promise<ProfileListEntry[]> {
    if (isRemoteDesktopMode()) return remoteJson<ProfileListEntry[]>('/api/v2/profile-lists', {
      method: present ? 'PUT' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId, kind, selectionRevision: getRemoteDesktopSession()?.selectionRevision }),
    });
    if (window.desktopApi?.setProfileListEntry) return window.desktopApi.setProfileListEntry(mediaId, kind, present, expectedProfileId);
    return fetchJson<ProfileListEntry[]>('/api/v2/profile-lists', {
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
      const all = await remoteJson<Record<string, StoredProgress>>('/api/v2/progress');
      return filePath ? all[remoteResourceId(filePath)] || null : remoteProgressByStreamUrl(all);
    }
    if (window.desktopApi?.getProgress) return window.desktopApi.getProgress(filePath);
    const query = filePath ? `?filePath=${encodeURIComponent(filePath)}` : '';
    return fetchJson<Record<string, StoredProgress> | StoredProgress | null>(`/api/progress${query}`);
  },

  async saveProgress(filePath: string, position: number, duration: number, expectedProfileId?: string): Promise<StoredProgress> {
    if (isRemoteDesktopMode()) return remoteJson<StoredProgress>('/api/v2/progress', {
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
    return fetchJson<StoredProgress>('/api/progress', {
      method: 'POST',
      body: JSON.stringify({ filePath, position, duration }),
    });
  },

  async importProgress(progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>, expectedProfileId?: string): Promise<boolean> {
    if (isRemoteDesktopMode()) return true;
    if (window.desktopApi?.importProgress) return window.desktopApi.importProgress(progress, expectedProfileId);
    const response = await fetchJson<{ ok: boolean }>('/api/progress/import', {
      method: 'POST',
      body: JSON.stringify({ progress }),
    });
    return response.ok;
  },

  async getPlaybackTrackPreferences(scope?: string): Promise<PlaybackTrackPreferences | Record<string, PlaybackTrackPreferences>> {
    if (isRemoteDesktopMode()) {
      const query = scope ? `?scope=${encodeURIComponent(scope)}` : '';
      return remoteJson<PlaybackTrackPreferences | Record<string, PlaybackTrackPreferences>>(`/api/v2/playback-track-preferences${query}`);
    }
    if (window.desktopApi?.getPlaybackTrackPreferences) return window.desktopApi.getPlaybackTrackPreferences(scope);
    const query = scope ? `?scope=${encodeURIComponent(scope)}` : '';
    return fetchJson<PlaybackTrackPreferences | Record<string, PlaybackTrackPreferences>>(`/api/playback-track-preferences${query}`);
  },

  async savePlaybackTrackPreferences(scope: string, preferences: PlaybackTrackPreferences, expectedProfileId?: string): Promise<PlaybackTrackPreferences> {
    if (isRemoteDesktopMode()) return remoteJson<PlaybackTrackPreferences>('/api/v2/playback-track-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, preferences, selectionRevision: getRemoteDesktopSession()?.selectionRevision }),
    });
    if (window.desktopApi?.savePlaybackTrackPreferences) return window.desktopApi.savePlaybackTrackPreferences(scope, preferences, expectedProfileId);
    return fetchJson<PlaybackTrackPreferences>('/api/playback-track-preferences', {
      method: 'POST',
      body: JSON.stringify({ scope, preferences }),
    });
  },

  async getMediaSegments(request: MediaSegmentRequest): Promise<MediaSegmentResponse> {
    if (isRemoteDesktopMode()) {
      const params = new URLSearchParams({ mediaId: request.mediaId });
      if (typeof request.season === 'number') params.set('season', String(request.season));
      if (typeof request.episode === 'number') params.set('episode', String(request.episode));
      return remoteJson<MediaSegmentResponse>(`/api/v2/playback/segments?${params.toString()}`);
    }
    if (window.desktopApi?.getMediaSegments) return window.desktopApi.getMediaSegments(request);
    const params = new URLSearchParams({ mediaId: request.mediaId });
    if (typeof request.season === 'number') params.set('season', String(request.season));
    if (typeof request.episode === 'number') params.set('episode', String(request.episode));
    return fetchJson<MediaSegmentResponse>(`/api/playback/segments?${params.toString()}`);
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
    return fetchJson<Record<string, string>>(`/api/artwork?mediaId=${encodeURIComponent(mediaId)}`);
  },

  async saveCustomArtwork(mediaId: string, target: string, dataUrl: string): Promise<Record<string, string>> {
    if (window.desktopApi?.saveCustomArtwork) return window.desktopApi.saveCustomArtwork(mediaId, target, dataUrl);
    return fetchJson<Record<string, string>>('/api/artwork', {
      method: 'POST',
      body: JSON.stringify({ mediaId, target, dataUrl }),
    });
  },

  async refreshOfficialArtwork(mediaId: string, target: OfficialArtworkRefreshTarget = 'all'): Promise<OfficialArtworkResult> {
    if (window.desktopApi?.refreshOfficialArtwork) return window.desktopApi.refreshOfficialArtwork(mediaId, target);
    return fetchJson<OfficialArtworkResult>('/api/artwork/refresh-official', {
      method: 'POST',
      body: JSON.stringify({ mediaId, target }),
    });
  },

  async getPlaybackLogo(mediaId: string): Promise<PlaybackLogoResult> {
    if (window.desktopApi?.getPlaybackLogo) return window.desktopApi.getPlaybackLogo(mediaId);
    return fetchJson<PlaybackLogoResult>('/api/artwork/playback-logo', {
      method: 'POST',
      body: JSON.stringify({ mediaId }),
    });
  },

  async getOfficialMetadataCandidates(mediaId: string): Promise<OfficialMetadataCandidate[]> {
    if (window.desktopApi?.getOfficialMetadataCandidates) return window.desktopApi.getOfficialMetadataCandidates(mediaId);
    return fetchJson<OfficialMetadataCandidate[]>('/api/artwork/official-candidates', {
      method: 'POST',
      body: JSON.stringify({ mediaId }),
    });
  },

  async applyOfficialMetadata(mediaId: string, candidate: OfficialMetadataCandidate, target: OfficialMetadataApplyTarget = 'all'): Promise<OfficialArtworkResult> {
    if (window.desktopApi?.applyOfficialMetadata) return window.desktopApi.applyOfficialMetadata(mediaId, candidate, target);
    return fetchJson<OfficialArtworkResult>('/api/artwork/apply-official', {
      method: 'POST',
      body: JSON.stringify({ mediaId, candidate, target }),
    });
  },

  async importCustomArtwork(entries: Record<string, Record<string, string>>): Promise<boolean> {
    if (window.desktopApi?.importCustomArtwork) return window.desktopApi.importCustomArtwork(entries);
    const response = await fetchJson<{ ok: boolean }>('/api/artwork/import', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    });
    return response.ok;
  },

  async backupDatabase(): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (window.desktopApi?.backupDatabase) return window.desktopApi.backupDatabase();
    return fetchJson<{ ok: boolean; path?: string; error?: string }>('/api/database/backup', { method: 'POST' });
  },

  async clearAppData(): Promise<LibraryPayload> {
    if (window.desktopApi?.clearAppData) return window.desktopApi.clearAppData();
    return fetchJson<LibraryPayload>('/api/database/clear', { method: 'POST' });
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
      const release = await response.json() as { tag_name?: string; html_url?: string };
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
    const response = await fetchJson<{ ok: boolean }>('/api/play-media', {
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

  media: {
    async probe(filePath: string): Promise<ApiResult<unknown>> {
      if (isRemoteDesktopMode() && /^https?:\/\//i.test(filePath)) {
        return { ok: false, error: 'Media probing is handled by the paired host.' };
      }
      if (window.desktopApi?.media) return window.desktopApi.media.probe(filePath);
      return fetchJson<ApiResult<unknown>>('/api/renderer/media/probe', {
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

    async startTranscode(filePath: string, options?: TranscodeOptions): Promise<ApiResult<TranscodeSession>> {
      if (isRemoteDesktopMode()) {
        await refreshRemoteActiveProfileState();
        const result = await remoteJson<ApiResult<TranscodeSession>>('/api/v2/start-hls', {
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
      return fetchJson<ApiResult<TranscodeSession>>('/api/renderer/media/start-transcode', {
        method: 'POST',
        body: JSON.stringify({ filePath, options }),
      });
    },

    async stopTranscode(sessionId: string): Promise<ApiResult<boolean>> {
      if (isRemoteDesktopMode()) return { ok: true, data: true };
      if (window.desktopApi?.media) return window.desktopApi.media.stopTranscode(sessionId);
      return fetchJson<ApiResult<boolean>>('/api/renderer/media/stop-transcode', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      });
    },
  },
};
