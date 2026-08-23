import type { OfficialMetadataCandidate, PlaybackTrackPreferences, StreamOptions } from './mobileDomain.ts';
import type {
  LanPlaybackCapabilities,
  LanPairApprovalRequest,
  LanProfileListKind,
  LanProfilePreferences,
  LanProfileSelectionRequest,
} from '@loom-media-server/lan-protocol';

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

export const MOBILE_LAN_TIMEOUT_MS = {
  probe: 4_000,
  standard: 12_000,
  library: 20_000,
  streamPreparation: 45_000,
} as const;

export function mobileLanTimeoutFor(input: string): number {
  let pathname = input;
  try { pathname = new URL(input).pathname; } catch { /* Relative URLs use the original input. */ }
  if (pathname.endsWith('/api/v1/discovery') || pathname.includes('/api/v1/pairing/requests/')) return MOBILE_LAN_TIMEOUT_MS.probe;
  if (pathname.includes('/api/v1/library')) return MOBILE_LAN_TIMEOUT_MS.library;
  if (pathname.includes('/playback-plan') || pathname.includes('/transcode')) return MOBILE_LAN_TIMEOUT_MS.streamPreparation;
  return MOBILE_LAN_TIMEOUT_MS.standard;
}

function deviceHeaders(token: string, headers: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `LoomDevice ${token}`, ...headers };
}

function jsonResponse(payload: unknown, status = 200, source?: Response): Response {
  const headers = new Headers(source?.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.delete('Content-Length');
  return new Response(JSON.stringify(payload), { status, headers });
}

async function canonicalPayload(response: Response): Promise<{ ok: boolean; data?: any; error?: any }> {
  const text = await response.text();
  if (!text.trim()) return { ok: response.ok };
  try {
    const payload = JSON.parse(text);
    return payload && typeof payload === 'object' ? payload : { ok: response.ok, data: payload };
  } catch {
    return { ok: false, error: { code: 'invalid_json', message: 'The server returned invalid JSON.' } };
  }
}

async function legacyResponse(response: Response, map: (data: any) => unknown = (data) => data): Promise<Response> {
  const payload = await canonicalPayload(response);
  if (!response.ok || payload.ok === false) {
    const error = payload.error && typeof payload.error === 'object' ? payload.error : {};
    return jsonResponse({
      error: typeof error.code === 'string' ? error.code : 'request_failed',
      status: typeof error.code === 'string' ? error.code : 'request_failed',
      message: typeof error.message === 'string' ? error.message : 'The server rejected the request.',
      ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
    }, response.status, response);
  }
  return jsonResponse(map(payload.data), response.status, response);
}

function legacyProfile(profile: any) {
  const kind = String(profile?.kind || 'adult');
  return {
    id: String(profile?.id || ''), name: String(profile?.name || ''),
    avatarKey: String(profile?.avatarKey || 'glyph-01'), colorKey: String(profile?.colorKey || 'ember'),
    type: kind === 'child' ? 'kid' : kind === 'guest' ? 'guest' : 'standard',
    hasPin: profile?.hasPin === true, isGuest: kind === 'guest', sortOrder: Number(profile?.sortOrder || 0),
    ...(Number.isFinite(profile?.lastUsedAt) ? { lastUsedAt: Number(profile.lastUsedAt) } : {}),
  };
}

function legacySelection(selection: any) {
  return {
    profileId: typeof selection?.profileId === 'string' ? selection.profileId : null,
    selectionRequired: typeof selection?.profileId !== 'string',
    selectionRevision: Number(selection?.selectionRevision || 0),
    automaticSignIn: selection?.automaticSignIn === true,
  };
}

function legacyPreferences(preferences: any): LanProfilePreferences {
  return {
    ...(preferences?.themeMode ? { appThemeMode: preferences.themeMode } : {}),
    ...(preferences?.themeColor ? { appThemeColor: preferences.themeColor } : {}),
    ...(preferences?.showProviderRatingBadges !== undefined ? { showProviderRatingBadges: preferences.showProviderRatingBadges } : {}),
    ...(preferences?.sidebarNavOrder ? { sidebarNavOrder: preferences.sidebarNavOrder } : {}),
    ...(preferences?.autoplayNextEnabled !== undefined ? { autoplayNextEnabled: preferences.autoplayNextEnabled } : {}),
    ...(preferences?.skipBackSeconds !== undefined ? { playbackSkipBackSeconds: preferences.skipBackSeconds } : {}),
    ...(preferences?.skipForwardSeconds !== undefined ? { playbackSkipForwardSeconds: preferences.skipForwardSeconds } : {}),
  };
}

function canonicalPreferences(preferences: LanProfilePreferences) {
  return {
    ...(preferences.appThemeMode ? { themeMode: preferences.appThemeMode } : {}),
    ...(preferences.appThemeColor ? { themeColor: preferences.appThemeColor } : {}),
    ...(preferences.showProviderRatingBadges !== undefined ? { showProviderRatingBadges: preferences.showProviderRatingBadges } : {}),
    ...(preferences.sidebarNavOrder ? { sidebarNavOrder: preferences.sidebarNavOrder } : {}),
    ...(preferences.autoplayNextEnabled !== undefined ? { autoplayNextEnabled: preferences.autoplayNextEnabled } : {}),
    ...(preferences.playbackSkipBackSeconds !== undefined ? { skipBackSeconds: preferences.playbackSkipBackSeconds } : {}),
    ...(preferences.playbackSkipForwardSeconds !== undefined ? { skipForwardSeconds: preferences.playbackSkipForwardSeconds } : {}),
  };
}

function legacyMedia(item: any, episodes: any[] = []) {
  const type = item?.animeLikely === true ? 'anime' : item?.kind === 'series' || item?.kind === 'episode' ? 'tv' : 'movie';
  return {
    id: String(item?.id || ''), type, title: String(item?.title || 'Untitled'), filePath: String(item?.id || ''),
    year: Number.isFinite(item?.year) ? Number(item.year) : undefined,
    poster: String(item?.artwork?.poster || ''), backdrop: String(item?.artwork?.backdrop || ''), logo: String(item?.artwork?.logo || ''),
    summary: String(item?.summary || ''), rating: Number(item?.rating || 0), genres: Array.isArray(item?.genres) ? item.genres : [],
    providerIds: item?.providerIds || {}, available: item?.available === true,
    lastPlayed: Number(item?.lastPlayedAt || 0) || undefined,
    episodeFiles: episodes.map((episode) => ({
      mediaId: episode.id, season: Number(episode.seasonNumber || 1), episode: Number(episode.episodeNumber || 0),
      filePath: String(episode.id), title: String(episode.title || `Episode ${episode.episodeNumber || ''}`),
      still: String(episode?.artwork?.still || ''),
    })),
  };
}

function legacyLibrary(items: any[]) {
  const episodesBySeries = new Map<string, any[]>();
  for (const item of items) {
    if (item?.kind !== 'episode' || typeof item.seriesId !== 'string') continue;
    const episodes = episodesBySeries.get(item.seriesId) || [];
    episodes.push(item);
    episodesBySeries.set(item.seriesId, episodes);
  }
  const movies = items.filter((item) => item?.kind === 'movie' || item?.kind === 'video').map((item) => legacyMedia(item));
  const series = items.filter((item) => item?.kind === 'series').map((item) => legacyMedia(item, episodesBySeries.get(item.id) || []));
  return { movies, tvShows: series.filter((item) => item.type === 'tv'), animeShows: series.filter((item) => item.type === 'anime'), others: [] };
}

function catalogRevision(items: any[]): number {
  return Math.max(0, ...items.map((item) => Number(item?.updatedAt || item?.createdAt || 0)));
}

function compactIndex(items: any[]) {
  const revision = catalogRevision(items);
  const library = legacyLibrary(items);
  const card = (item: any) => ({
    id: item.id, type: item.type, title: item.title, year: item.year, poster: item.poster || '', backdrop: item.backdrop || '',
    logo: item.logo || undefined, summary: item.summary || '', rating: item.rating || 0, genres: item.genres || [], lastPlayed: item.lastPlayed,
    playbackReferences: item.episodeFiles?.length
      ? item.episodeFiles.map((episode: any) => ({ progressKey: episode.mediaId || episode.filePath, season: episode.season, episode: episode.episode }))
      : [{ progressKey: item.id }],
  });
  return {
    catalogVersion: 1, revision, movies: library.movies.map(card), tvShows: library.tvShows.map(card),
    animeShows: library.animeShows.map(card), others: [],
  };
}

export function createMobileLanClient(fetchImpl: FetchImplementation = fetch, timeoutFor: (input: string) => number = mobileLanTimeoutFor) {
  const activeRequests = new Set<AbortController>();
  const request: FetchImplementation = (input, init = {}) => {
    const operationController = new AbortController();
    const callerSignal = init.signal;
    const abortFromCaller = () => operationController.abort();
    if (callerSignal?.aborted) operationController.abort();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    activeRequests.add(operationController);
    return mobileFetch(input, { ...init, signal: operationController.signal }, timeoutFor(input), fetchImpl).finally(() => {
      activeRequests.delete(operationController);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    });
  };

  const getSelection = async (baseUrl: string, token: string) => legacyResponse(
    await request(`${baseUrl}/api/v1/profiles/selection`, { headers: deviceHeaders(token) }),
    (data) => legacySelection(data?.selection),
  );
  const selectedProfileId = async (baseUrl: string, token: string) => {
    const response = await getSelection(baseUrl, token);
    const selection = await response.json();
    return typeof selection.profileId === 'string' ? selection.profileId : '';
  };
  const getCanonicalItems = async (baseUrl: string, token: string) => {
    const [response, seriesResponse] = await Promise.all([
      request(`${baseUrl}/api/v1/library`, { headers: deviceHeaders(token) }),
      request(`${baseUrl}/api/v1/library/series`, { headers: deviceHeaders(token) }),
    ]);
    const [payload, seriesPayload] = await Promise.all([canonicalPayload(response), canonicalPayload(seriesResponse)]);
    if (!response.ok || payload.ok === false) return { response, payload, items: [] };
    if (!seriesResponse.ok || seriesPayload.ok === false) return { response: seriesResponse, payload: seriesPayload, items: [] };
    const baseItems = Array.isArray(payload.data?.items) ? payload.data.items : [];
    const seriesItems = (Array.isArray(seriesPayload.data?.series) ? seriesPayload.data.series : []).map((series: any) => {
      const id = String(series.id || `series:${encodeURIComponent(String(series.title || 'untitled').toLowerCase())}`);
      return {
        ...series, id, kind: 'series', available: true,
        episodes: (series.seasons || []).flatMap((season: any) => (season.episodes || []).map((episode: any) => ({ ...episode, seriesId: id }))),
      };
    });
    const episodeIds = new Set(seriesItems.flatMap((series: any) => series.episodes.map((episode: any) => episode.id)));
    const items = [
      ...baseItems.filter((item: any) => item.kind !== 'episode' || !episodeIds.has(item.id)),
      ...seriesItems,
      ...seriesItems.flatMap((series: any) => series.episodes),
    ];
    return { response, payload, items };
  };

  return {
    cancelActiveRequests() { for (const controller of activeRequests) controller.abort(); },
    async getClientConfig(baseUrl: string, token: string) {
      const response = await request(`${baseUrl}/api/v1/discovery`, { headers: deviceHeaders(token) });
      const payload = await canonicalPayload(response);
      if (!response.ok || payload.ok === false) {
        return legacyResponse(jsonResponse(payload, response.status, response));
      }
      return jsonResponse({
        profileApiVersion: 1,
        capabilities: { profiles: true, profilePins: true, kidsRestrictions: true, profilePreferences: true, profileLists: true, playbackPlan: true },
      }, response.status, response);
    },
    async getProfiles(baseUrl: string, token: string) {
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles`, { headers: deviceHeaders(token) }),
        (data) => ({ profiles: (data?.profiles || []).map(legacyProfile) }));
    },
    getActiveProfile(baseUrl: string, token: string) { return getSelection(baseUrl, token); },
    async selectProfile(baseUrl: string, token: string, body: LanProfileSelectionRequest) {
      const selected = await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(body.profileId)}/select`, {
        method: 'POST', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ pin: body.pin }),
      });
      const selectedPayload = await canonicalPayload(selected);
      if (!selected.ok || selectedPayload.ok === false) return legacyResponse(jsonResponse(selectedPayload, selected.status, selected));
      const active = await getSelection(baseUrl, token);
      return jsonResponse({ profile: legacyProfile(selectedPayload.data?.profile), active: await active.json() }, 200, selected);
    },
    async lockProfile(baseUrl: string, token: string) {
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/selection/lock`, { method: 'POST', headers: deviceHeaders(token) }),
        (data) => legacySelection(data?.selection));
    },
    async setAutomaticSignIn(baseUrl: string, token: string, enabled: boolean) {
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/selection`, {
        method: 'PATCH', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ automaticSignIn: enabled }),
      }), (data) => legacySelection(data?.selection));
    },
    async getProfilePreferences(baseUrl: string, token: string) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/preferences`, { headers: deviceHeaders(token) }),
        (data) => legacyPreferences(data?.preferences));
    },
    async saveProfilePreferences(baseUrl: string, token: string, patch: LanProfilePreferences, _selectionRevision?: number) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/preferences`, {
        method: 'PATCH', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(canonicalPreferences(patch)),
      }), (data) => legacyPreferences(data?.preferences));
    },
    async getProfileLists(baseUrl: string, token: string, kind?: LanProfileListKind) {
      const profileId = await selectedProfileId(baseUrl, token);
      const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/lists${query}`, { headers: deviceHeaders(token) }),
        (data) => data?.entries || []);
    },
    async setProfileList(baseUrl: string, token: string, mediaId: string, kind: LanProfileListKind, present: boolean, _selectionRevision?: number) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(
        `${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/lists/${encodeURIComponent(kind)}/${encodeURIComponent(mediaId)}`,
        { method: present ? 'PUT' : 'DELETE', headers: deviceHeaders(token) },
      ), (data) => data?.entries || []);
    },
    async startHls(baseUrl: string, token: string, mediaId: string, options: StreamOptions, _selectionRevision?: number, signal?: AbortSignal) {
      const planResponse = await request(`${baseUrl}/api/v1/media/${encodeURIComponent(mediaId)}/playback-plan`, {
        method: 'POST', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          capabilities: {
            containers: options.forceTranscode ? ['mp4'] : ['mp4', 'mov', 'webm'], videoCodecs: ['h264', 'hevc'],
            audioCodecs: ['aac', 'mp3'], supportsHls: true, supportsHdr: options.toneMap !== true,
            supportsTextSubtitles: false, subtitleModes: ['burn-in'],
            ...(options.maxWidth ? { maxWidth: options.maxWidth } : {}), ...(options.maxHeight ? { maxHeight: options.maxHeight } : {}),
          },
          startSeconds: options.startSeconds || 0,
          ...(Number.isSafeInteger(options.audioTrackIndex) ? { audioTrackId: String(options.audioTrackIndex) } : {}),
          ...(Number.isSafeInteger(options.subtitleTrackIndex) ? { subtitleTrackId: String(options.subtitleTrackIndex) } : {}),
        }), signal,
      });
      const planPayload = await canonicalPayload(planResponse);
      if (!planResponse.ok || planPayload.ok === false) return legacyResponse(jsonResponse(planPayload, planResponse.status, planResponse));
      const relative = planPayload.data?.directUrl || planPayload.data?.transcodeUrl;
      if (typeof relative !== 'string' || !relative) return jsonResponse({ ok: false, error: 'playback_not_supported' }, 409, planResponse);
      const playbackUrl = new URL(relative, baseUrl).toString();
      if (planPayload.data?.directUrl) return jsonResponse({ ok: true, data: { playlistUrl: playbackUrl } }, 200, planResponse);
      const started = await request(playbackUrl, { method: 'POST', headers: deviceHeaders(token), signal });
      const startedPayload = await canonicalPayload(started);
      if (!started.ok || startedPayload.ok === false) return legacyResponse(jsonResponse(startedPayload, started.status, started));
      const playlistUrl = startedPayload.data?.playlistUrl || (startedPayload as any).playlistUrl;
      return jsonResponse({ ok: true, data: { playlistUrl: new URL(playlistUrl, baseUrl).toString() } }, 200, started);
    },
    async getPlaybackPlan(baseUrl: string, token: string, mediaId: string, capabilities: LanPlaybackCapabilities, _selectionRevision?: number) {
      return legacyResponse(await request(`${baseUrl}/api/v1/media/${encodeURIComponent(mediaId)}/playback-plan`, {
        method: 'POST', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ capabilities }),
      }), (data) => data);
    },
    async createOfflineDownload(baseUrl: string, token: string, mediaId: string) {
      return legacyResponse(await request(`${baseUrl}/api/v1/downloads`, {
        method: 'POST',
        headers: deviceHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId, allowRanges: true }),
      }), (data) => data);
    },
    async revokeOfflineDownload(baseUrl: string, token: string, downloadId: string) {
      return request(`${baseUrl}/api/v1/downloads/${encodeURIComponent(downloadId)}`, {
        method: 'DELETE',
        headers: deviceHeaders(token),
      });
    },
    async getProgress(baseUrl: string, token: string) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/progress`, { headers: deviceHeaders(token) }),
        (data) => Object.fromEntries(Object.entries(data?.progress || {}).map(([mediaId, item]: [string, any]) => [mediaId, {
          position: Number(item?.positionSeconds || item?.position || 0), duration: Number(item?.durationSeconds || item?.duration || 0),
          watched: item?.watched === true, updatedAt: Number(item?.updatedAt || 0),
        }])));
    },
    async saveProgress(baseUrl: string, token: string, body: { mediaId: string; position: number; duration: number; selectionRevision?: number }) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/progress/${encodeURIComponent(body.mediaId)}`, {
        method: 'PUT', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({
          positionSeconds: body.position, durationSeconds: body.duration, watched: body.duration > 0 && body.position / body.duration >= 0.9,
        }),
      }), (data) => data?.progress || {});
    },
    async refreshCredentials(baseUrl: string, refreshToken: string, _deviceName?: string) {
      const response = await request(`${baseUrl}/api/v1/auth/me`, { headers: deviceHeaders(refreshToken) });
      if (!response.ok) return legacyResponse(response);
      const now = Date.now();
      return jsonResponse({ accessToken: refreshToken, accessTokenExpiresAt: now + 24 * 60 * 60 * 1000,
        refreshToken, refreshTokenExpiresAt: now + 365 * 24 * 60 * 60 * 1000 }, 200, response);
    },
    async getLibrary(baseUrl: string, token: string, _etag?: string) {
      const { response, payload, items } = await getCanonicalItems(baseUrl, token);
      if (!response.ok || payload.ok === false) return legacyResponse(jsonResponse(payload, response.status, response));
      const headers = new Headers(response.headers);
      headers.set('ETag', `W/"${catalogRevision(items)}"`);
      return new Response(JSON.stringify(legacyLibrary(items)), { status: 200, headers });
    },
    async getLibraryIndex(baseUrl: string, token: string, _etag?: string) {
      const { response, payload, items } = await getCanonicalItems(baseUrl, token);
      if (!response.ok || payload.ok === false) return legacyResponse(jsonResponse(payload, response.status, response));
      const index = compactIndex(items);
      const headers = new Headers(response.headers);
      headers.set('ETag', `W/"${index.revision}"`);
      return new Response(JSON.stringify(index), { status: 200, headers });
    },
    async getLibraryItem(baseUrl: string, token: string, mediaId: string) {
      const { response, payload, items } = await getCanonicalItems(baseUrl, token);
      if (!response.ok || payload.ok === false) return legacyResponse(jsonResponse(payload, response.status, response));
      const library = legacyLibrary(items);
      const item = [...library.movies, ...library.tvShows, ...library.animeShows, ...library.others].find((candidate) => candidate.id === mediaId);
      if (!item) return jsonResponse({ error: 'media_not_found', message: 'Media item was not found.' }, 404, response);
      return jsonResponse({ catalogVersion: 1, revision: catalogRevision(items), item }, 200, response);
    },
    async pair(baseUrl: string, body: { code?: string; deviceName: string; approvalRequested?: boolean }) {
      return legacyResponse(await request(`${baseUrl}/api/v1/pairing/requests`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          name: body.deviceName, kind: 'mobile', permissions: ['library.read', 'stream', 'transcode', 'downloads'],
        }),
      }), (data) => data);
    },
    async pairingApprovalStatus(baseUrl: string, approvalRequest: Pick<LanPairApprovalRequest, 'requestId' | 'requestSecret'>) {
      const response = await request(`${baseUrl}/api/v1/pairing/requests/${encodeURIComponent(approvalRequest.requestId)}`, {
        headers: { Authorization: `LoomPairing ${approvalRequest.requestSecret}` },
      });
      const payload = await canonicalPayload(response);
      if (!response.ok || payload.ok === false) return legacyResponse(jsonResponse(payload, response.status, response));
      if (payload.data?.status !== 'approved') return jsonResponse(payload.data, payload.data?.status === 'pending' ? 202 : 200, response);
      const credential = `${payload.data.credential.id}.${payload.data.credential.secret}`;
      const discovery = await canonicalPayload(await request(`${baseUrl}/api/v1/discovery`));
      const fingerprint = String(payload.data.certificateFingerprint || discovery.data?.certificateFingerprint || '').replaceAll(':', '').toLowerCase();
      const expiresAt = Number(payload.data.credentialExpiresAt || Date.now() + 365 * 24 * 60 * 60 * 1000);
      return jsonResponse({
        deviceId: payload.data.deviceId, accessToken: credential, accessTokenExpiresAt: expiresAt,
        refreshToken: credential, refreshTokenExpiresAt: expiresAt, certFingerprint: fingerprint,
        hostDeviceId: fingerprint, hostDeviceName: 'LoomTV server', library: {}, libraryEtag: '',
      }, 200, response);
    },
    async getOfficialArtworkCandidates(_baseUrl: string, _token: string, _mediaId: string, _selectionRevision?: number) {
      return jsonResponse({ error: 'legacy_route_retired', message: 'Provider artwork editing is not available through the canonical video API.' }, 410);
    },
    async applyOfficialArtwork(_baseUrl: string, _token: string, _mediaId: string, _candidate: OfficialMetadataCandidate, _selectionRevision?: number) {
      return jsonResponse({ error: 'legacy_route_retired', message: 'Provider artwork editing is not available through the canonical video API.' }, 410);
    },
    async getTrackPreferences(baseUrl: string, token: string, scope: string) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(
        `${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/track-preferences/${encodeURIComponent(scope)}`,
        { headers: deviceHeaders(token) },
      ), (data) => data?.preferences || {});
    },
    async saveTrackPreferences(baseUrl: string, token: string, scope: string, preferences: PlaybackTrackPreferences, _selectionRevision?: number) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(
        `${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/track-preferences/${encodeURIComponent(scope)}`,
        { method: 'PUT', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(preferences) },
      ), (data) => data?.preferences || {});
    },
    async getPlaybackSegments(_baseUrl: string, _token: string, _params: URLSearchParams, _signal?: AbortSignal) {
      return jsonResponse({ error: 'legacy_route_retired', message: 'Playback segment metadata is not part of the canonical video API.' }, 410);
    },
  };
}

export type MobileLanClient = ReturnType<typeof createMobileLanClient>;

export class MobileLanTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`The server did not respond within ${timeoutMs}ms.`);
    this.name = 'MobileLanTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

async function mobileFetch(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] = {},
  timeoutMs: number = MOBILE_LAN_TIMEOUT_MS.standard,
  fetchImpl: FetchImplementation = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetchImpl(input as string, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new MobileLanTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}
