import type { OfficialMetadataCandidate, PlaybackTrackPreferences, StreamOptions } from './mobileDomain.ts';
import type {
  LanPlaybackCapabilities,
  LanPairApprovalRequest,
  LanProfileListKind,
  LanProfilePreferences,
  LanProfileSelectionRequest,
} from '@loom-media-server/lan-protocol';

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

type JsonRecord = Record<string, unknown>;
type CanonicalPayload = JsonRecord & {
  ok?: boolean;
  data?: unknown;
  error?: unknown;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

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

async function canonicalPayload(response: Response): Promise<CanonicalPayload> {
  const text = await response.text();
  if (!text.trim()) return { ok: response.ok };
  try {
    const payload: unknown = JSON.parse(text);
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as CanonicalPayload
      : { ok: response.ok, data: payload };
  } catch {
    return { ok: false, error: { code: 'invalid_json', message: 'The server returned invalid JSON.' } };
  }
}

async function legacyResponse(response: Response, map: (data: unknown) => unknown = (data) => data): Promise<Response> {
  const payload = await canonicalPayload(response);
  if (!response.ok || payload.ok === false) {
    const error = asRecord(payload.error);
    const retryAfterMs = finiteNumberOrUndefined(error.retryAfterMs);
    return jsonResponse({
      error: typeof error.code === 'string' ? error.code : 'request_failed',
      status: typeof error.code === 'string' ? error.code : 'request_failed',
      message: typeof error.message === 'string' ? error.message : 'The server rejected the request.',
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    }, response.status, response);
  }
  return jsonResponse(map(payload.data), response.status, response);
}

function legacyProfile(profile: unknown): JsonRecord {
  const value = asRecord(profile);
  const kind = String(value.kind || 'adult');
  const lastUsedAt = finiteNumberOrUndefined(value.lastUsedAt);
  return {
    id: String(value.id || ''), name: String(value.name || ''),
    avatarKey: String(value.avatarKey || 'glyph-01'), colorKey: String(value.colorKey || 'ember'),
    type: kind === 'child' ? 'kid' : kind === 'guest' ? 'guest' : 'standard',
    hasPin: value.hasPin === true, isGuest: kind === 'guest', sortOrder: finiteNumber(value.sortOrder),
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
  };
}

function legacySelection(selection: unknown): JsonRecord {
  const value = asRecord(selection);
  return {
    profileId: typeof value.profileId === 'string' ? value.profileId : null,
    selectionRequired: typeof value.profileId !== 'string',
    selectionRevision: finiteNumber(value.selectionRevision),
    automaticSignIn: value.automaticSignIn === true,
  };
}

function legacyPreferences(preferences: unknown): LanProfilePreferences {
  const value = asRecord(preferences);
  const themeMode = typeof value.themeMode === 'string'
    ? value.themeMode as LanProfilePreferences['appThemeMode']
    : undefined;
  const themeColor = typeof value.themeColor === 'string'
    ? value.themeColor as LanProfilePreferences['appThemeColor']
    : undefined;
  const sidebarNavOrder = Array.isArray(value.sidebarNavOrder)
    ? value.sidebarNavOrder.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const skipBackSeconds = finiteNumberOrUndefined(value.skipBackSeconds);
  const skipForwardSeconds = finiteNumberOrUndefined(value.skipForwardSeconds);
  return {
    ...(themeMode ? { appThemeMode: themeMode } : {}),
    ...(themeColor ? { appThemeColor: themeColor } : {}),
    ...(typeof value.showProviderRatingBadges === 'boolean' ? { showProviderRatingBadges: value.showProviderRatingBadges } : {}),
    ...(sidebarNavOrder ? { sidebarNavOrder } : {}),
    ...(typeof value.autoplayNextEnabled === 'boolean' ? { autoplayNextEnabled: value.autoplayNextEnabled } : {}),
    ...(skipBackSeconds !== undefined ? { playbackSkipBackSeconds: skipBackSeconds } : {}),
    ...(skipForwardSeconds !== undefined ? { playbackSkipForwardSeconds: skipForwardSeconds } : {}),
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

function legacyMedia(item: unknown, episodes: unknown[] = []): JsonRecord {
  const value = asRecord(item);
  const artwork = asRecord(value.artwork);
  const type = value.animeLikely === true ? 'anime' : value.kind === 'series' || value.kind === 'episode' ? 'tv' : 'movie';
  const lastPlayed = finiteNumber(value.lastPlayedAt) || undefined;
  return {
    id: String(value.id || ''), type, title: String(value.title || 'Untitled'), filePath: String(value.id || ''),
    year: finiteNumberOrUndefined(value.year),
    poster: String(artwork.poster || ''), backdrop: String(artwork.backdrop || ''), logo: String(artwork.logo || ''),
    summary: String(value.summary || ''), rating: finiteNumber(value.rating),
    genres: Array.isArray(value.genres) ? value.genres.filter((genre): genre is string => typeof genre === 'string') : [],
    providerIds: asRecord(value.providerIds), available: value.available === true,
    lastPlayed,
    episodeFiles: episodes.map((episode) => {
      const value = asRecord(episode);
      const episodeArtwork = asRecord(value.artwork);
      return {
        mediaId: value.id, season: finiteNumber(value.seasonNumber, 1), episode: finiteNumber(value.episodeNumber),
        filePath: String(value.id), title: String(value.title || `Episode ${value.episodeNumber || ''}`),
        still: String(episodeArtwork.still || ''),
      };
    }),
  };
}

function legacyLibrary(items: unknown[]) {
  const normalizedItems = asRecords(items);
  const episodesBySeries = new Map<string, JsonRecord[]>();
  for (const item of normalizedItems) {
    if (item.kind !== 'episode' || typeof item.seriesId !== 'string') continue;
    const episodes = episodesBySeries.get(item.seriesId) || [];
    episodes.push(item);
    episodesBySeries.set(item.seriesId, episodes);
  }
  const movies = normalizedItems.filter((item) => item.kind === 'movie' || item.kind === 'video').map((item) => legacyMedia(item));
  const series = normalizedItems.filter((item) => item.kind === 'series').map((item) => legacyMedia(item, episodesBySeries.get(String(item.id)) || []));
  return { movies, tvShows: series.filter((item) => item.type === 'tv'), animeShows: series.filter((item) => item.type === 'anime'), others: [] };
}

function catalogRevision(items: unknown[]): number {
  return Math.max(0, ...asRecords(items).map((item) => finiteNumber(item.updatedAt || item.createdAt)));
}

function compactIndex(items: unknown[], revision = catalogRevision(items)) {
  const library = legacyLibrary(items);
  const card = (item: JsonRecord): JsonRecord => {
    const episodeFiles = asRecords(item.episodeFiles);
    return {
    id: item.id, type: item.type, title: item.title, year: item.year, poster: item.poster || '', backdrop: item.backdrop || '',
    logo: item.logo || undefined, summary: item.summary || '', rating: item.rating || 0, genres: item.genres || [], lastPlayed: item.lastPlayed,
    playbackReferences: episodeFiles.length
      ? episodeFiles.map((episode) => ({ progressKey: episode.mediaId || episode.filePath, season: episode.season, episode: episode.episode }))
      : [{ progressKey: item.id }],
    };
  };
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
    (data) => legacySelection(asRecord(data).selection),
  );
  const selectedProfileId = async (baseUrl: string, token: string) => {
    const response = await getSelection(baseUrl, token);
    const selection = await response.json();
    return typeof selection.profileId === 'string' ? selection.profileId : '';
  };
  const getCanonicalItems = async (baseUrl: string, token: string, etag?: string, mediaId?: string) => {
    const query = mediaId ? `?mediaId=${encodeURIComponent(mediaId)}` : '';
    const catalogResponse = await request(`${baseUrl}/api/v1/library/catalog${query}`, {
      headers: deviceHeaders(token, etag && !mediaId ? { 'If-None-Match': etag } : {}),
    });
    if (catalogResponse.status === 304) return { response: catalogResponse, payload: {}, items: [], revision: 0 };
    if (catalogResponse.status !== 404) {
      const payload = await canonicalPayload(catalogResponse);
      const data = asRecord(payload.data);
      return { response: catalogResponse, payload, items: asRecords(data.items), revision: finiteNumber(data.revision) };
    }
    // Older servers predate the bounded detail/conditional catalog endpoint.
    const [response, seriesResponse] = await Promise.all([
      request(`${baseUrl}/api/v1/library`, { headers: deviceHeaders(token) }),
      request(`${baseUrl}/api/v1/library/series`, { headers: deviceHeaders(token) }),
    ]);
    const [payload, seriesPayload] = await Promise.all([canonicalPayload(response), canonicalPayload(seriesResponse)]);
    if (!response.ok || payload.ok === false) return { response, payload, items: [], revision: 0 };
    if (!seriesResponse.ok || seriesPayload.ok === false) return { response: seriesResponse, payload: seriesPayload, items: [], revision: 0 };
    const baseItems = asRecords(asRecord(payload.data).items);
    const seriesItems = asRecords(asRecord(seriesPayload.data).series).map((series) => {
      const id = String(series.id || `series:${encodeURIComponent(String(series.title || 'untitled').toLowerCase())}`);
      const episodes = asRecords(series.seasons).flatMap((season) => asRecords(season.episodes).map((episode) => ({ ...episode, seriesId: id })));
      return {
        ...series, id, kind: 'series', available: true,
        episodes,
      };
    });
    const episodeIds = new Set(seriesItems.flatMap((series) => asRecords(series.episodes).map((episode) => episode.id)));
    const items = [
      ...baseItems.filter((item) => item.kind !== 'episode' || !episodeIds.has(item.id)),
      ...seriesItems,
      ...seriesItems.flatMap((series) => asRecords(series.episodes)),
    ];
    return { response, payload, items, revision: catalogRevision(items) };
  };

  return {
    // The canonical API has no artwork mutation routes yet.
    supportsArtworkEditing: false,
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
        (data) => ({ profiles: asRecords(asRecord(data).profiles).map(legacyProfile) }));
    },
    getActiveProfile(baseUrl: string, token: string) { return getSelection(baseUrl, token); },
    async selectProfile(baseUrl: string, token: string, body: LanProfileSelectionRequest) {
      const selected = await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(body.profileId)}/select`, {
        method: 'POST', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ pin: body.pin }),
      });
      const selectedPayload = await canonicalPayload(selected);
      if (!selected.ok || selectedPayload.ok === false) return legacyResponse(jsonResponse(selectedPayload, selected.status, selected));
      const active = await getSelection(baseUrl, token);
      return jsonResponse({ profile: legacyProfile(asRecord(selectedPayload.data).profile), active: await active.json() }, 200, selected);
    },
    async lockProfile(baseUrl: string, token: string) {
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/selection/lock`, { method: 'POST', headers: deviceHeaders(token) }),
        (data) => legacySelection(asRecord(data).selection));
    },
    async setAutomaticSignIn(baseUrl: string, token: string, enabled: boolean) {
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/selection`, {
        method: 'PATCH', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ automaticSignIn: enabled }),
      }), (data) => legacySelection(asRecord(data).selection));
    },
    async getProfilePreferences(baseUrl: string, token: string) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/preferences`, { headers: deviceHeaders(token) }),
        (data) => legacyPreferences(asRecord(data).preferences));
    },
    async saveProfilePreferences(baseUrl: string, token: string, patch: LanProfilePreferences, _selectionRevision?: number) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/preferences`, {
        method: 'PATCH', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(canonicalPreferences(patch)),
      }), (data) => legacyPreferences(asRecord(data).preferences));
    },
    async getProfileLists(baseUrl: string, token: string, kind?: LanProfileListKind) {
      const profileId = await selectedProfileId(baseUrl, token);
      const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/lists${query}`, { headers: deviceHeaders(token) }),
        (data) => asRecord(data).entries || []);
    },
    async setProfileList(baseUrl: string, token: string, mediaId: string, kind: LanProfileListKind, present: boolean, _selectionRevision?: number) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(
        `${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/lists/${encodeURIComponent(kind)}/${encodeURIComponent(mediaId)}`,
        { method: present ? 'PUT' : 'DELETE', headers: deviceHeaders(token) },
      ), (data) => asRecord(data).entries || []);
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
      const planData = asRecord(planPayload.data);
      const relative = planData.directUrl || planData.transcodeUrl;
      if (typeof relative !== 'string' || !relative) return jsonResponse({ ok: false, error: 'playback_not_supported' }, 409, planResponse);
      const playbackUrl = new URL(relative, baseUrl).toString();
      if (planData.directUrl) return jsonResponse({ ok: true, data: { playlistUrl: playbackUrl } }, 200, planResponse);
      const started = await request(playbackUrl, { method: 'POST', headers: deviceHeaders(token), signal });
      const startedPayload = await canonicalPayload(started);
      if (!started.ok || startedPayload.ok === false) return legacyResponse(jsonResponse(startedPayload, started.status, started));
      const startedData = asRecord(startedPayload.data);
      const playlistUrl = typeof startedData.playlistUrl === 'string'
        ? startedData.playlistUrl
        : typeof startedPayload.playlistUrl === 'string' ? startedPayload.playlistUrl : '';
      if (!playlistUrl) return jsonResponse({ ok: false, error: 'playback_not_supported' }, 409, started);
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
        (data) => Object.fromEntries(Object.entries(asRecord(asRecord(data).progress)).map(([mediaId, value]) => {
          const item = asRecord(value);
          return [mediaId, {
            position: finiteNumber(item.positionSeconds || item.position), duration: finiteNumber(item.durationSeconds || item.duration),
            watched: item.watched === true, updatedAt: finiteNumber(item.updatedAt),
          }];
        })));
    },
    async saveProgress(baseUrl: string, token: string, body: { mediaId: string; position: number; duration: number; selectionRevision?: number }) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(`${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/progress/${encodeURIComponent(body.mediaId)}`, {
        method: 'PUT', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({
          positionSeconds: body.position, durationSeconds: body.duration, watched: body.duration > 0 && body.position / body.duration >= 0.9,
        }),
      }), (data) => asRecord(data).progress || {});
    },
    async refreshCredentials(baseUrl: string, refreshToken: string, _deviceName?: string) {
      const response = await request(`${baseUrl}/api/v1/auth/me`, { headers: deviceHeaders(refreshToken) });
      if (!response.ok) return legacyResponse(response);
      const now = Date.now();
      return jsonResponse({ accessToken: refreshToken, accessTokenExpiresAt: now + 24 * 60 * 60 * 1000,
        refreshToken, refreshTokenExpiresAt: now + 365 * 24 * 60 * 60 * 1000 }, 200, response);
    },
    async getLibrary(baseUrl: string, token: string, etag?: string) {
      const { response, payload, items } = await getCanonicalItems(baseUrl, token, etag);
      if (response.status === 304) return response;
      if (!response.ok || payload.ok === false) return legacyResponse(jsonResponse(payload, response.status, response));
      const headers = new Headers(response.headers);
      if (!headers.has('ETag')) headers.set('ETag', `W/"${catalogRevision(items)}"`);
      return new Response(JSON.stringify(legacyLibrary(items)), { status: 200, headers });
    },
    async getLibraryIndex(baseUrl: string, token: string, etag?: string) {
      const { response, payload, items, revision } = await getCanonicalItems(baseUrl, token, etag);
      if (response.status === 304) return response;
      if (!response.ok || payload.ok === false) return legacyResponse(jsonResponse(payload, response.status, response));
      const index = compactIndex(items, revision);
      const headers = new Headers(response.headers);
      if (!headers.has('ETag')) headers.set('ETag', `W/"${index.revision}"`);
      return new Response(JSON.stringify(index), { status: 200, headers });
    },
    async getLibraryItem(baseUrl: string, token: string, mediaId: string) {
      const { response, payload, items, revision } = await getCanonicalItems(baseUrl, token, undefined, mediaId);
      if (!response.ok || payload.ok === false) return legacyResponse(jsonResponse(payload, response.status, response));
      const library = legacyLibrary(items);
      const item = [...library.movies, ...library.tvShows, ...library.animeShows, ...library.others].find((candidate) => candidate.id === mediaId);
      if (!item) return jsonResponse({ error: 'media_not_found', message: 'Media item was not found.' }, 404, response);
      return jsonResponse({ catalogVersion: 1, revision, item }, 200, response);
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
      const pairingData = asRecord(payload.data);
      if (pairingData.status !== 'approved') return jsonResponse(pairingData, pairingData.status === 'pending' ? 202 : 200, response);
      const credentialData = asRecord(pairingData.credential);
      const credential = `${credentialData.id}.${credentialData.secret}`;
      const discovery = await canonicalPayload(await request(`${baseUrl}/api/v1/discovery`));
      const discoveryData = asRecord(discovery.data);
      const fingerprint = String(pairingData.certificateFingerprint || discoveryData.certificateFingerprint || '').replaceAll(':', '').toLowerCase();
      const expiresAt = finiteNumber(pairingData.credentialExpiresAt, Date.now() + 365 * 24 * 60 * 60 * 1000);
      return jsonResponse({
        deviceId: pairingData.deviceId, accessToken: credential, accessTokenExpiresAt: expiresAt,
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
      ), (data) => asRecord(data).preferences || {});
    },
    async saveTrackPreferences(baseUrl: string, token: string, scope: string, preferences: PlaybackTrackPreferences, _selectionRevision?: number) {
      const profileId = await selectedProfileId(baseUrl, token);
      return legacyResponse(await request(
        `${baseUrl}/api/v1/profiles/${encodeURIComponent(profileId)}/track-preferences/${encodeURIComponent(scope)}`,
        { method: 'PUT', headers: deviceHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(preferences) },
      ), (data) => asRecord(data).preferences || {});
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
