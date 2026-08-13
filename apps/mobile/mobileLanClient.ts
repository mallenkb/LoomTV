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
  try { pathname = new URL(input).pathname; } catch { /* Keep the original input for relative URLs. */ }
  if (pathname.endsWith('/api/v2/client-config') || pathname.endsWith('/api/v2/pair/status')) {
    return MOBILE_LAN_TIMEOUT_MS.probe;
  }
  if (pathname.includes('/api/v2/library')) return MOBILE_LAN_TIMEOUT_MS.library;
  if (pathname.endsWith('/api/v2/start-hls')) return MOBILE_LAN_TIMEOUT_MS.streamPreparation;
  return MOBILE_LAN_TIMEOUT_MS.standard;
}

function bearerHeaders(token: string, headers: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'X-Loom-Profile-Api-Version': '1', ...headers };
}

export function createMobileLanClient(
  fetchImpl: FetchImplementation = fetch,
  timeoutFor: (input: string) => number = mobileLanTimeoutFor,
) {
  const activeRequests = new Set<AbortController>();
  const request: FetchImplementation = (input, init = {}) => {
    const operationController = new AbortController();
    const callerSignal = init.signal;
    const abortFromCaller = () => operationController.abort();
    if (callerSignal?.aborted) operationController.abort();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    activeRequests.add(operationController);
    return mobileFetch(
      input,
      { ...init, signal: operationController.signal },
      timeoutFor(input),
      fetchImpl,
    ).finally(() => {
      activeRequests.delete(operationController);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    });
  };
  return {
    cancelActiveRequests() {
      for (const controller of activeRequests) controller.abort();
    },
    getClientConfig(baseUrl: string, token: string) {
      return request(`${baseUrl}/api/v2/client-config`, { headers: bearerHeaders(token) });
    },
    getProfiles(baseUrl: string, token: string) {
      return request(`${baseUrl}/api/v2/profiles`, { headers: bearerHeaders(token) });
    },
    getActiveProfile(baseUrl: string, token: string) {
      return request(`${baseUrl}/api/v2/profiles/active`, { headers: bearerHeaders(token) });
    },
    selectProfile(baseUrl: string, token: string, body: LanProfileSelectionRequest) {
      return request(`${baseUrl}/api/v2/profiles/select`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
    },
    lockProfile(baseUrl: string, token: string) {
      return request(`${baseUrl}/api/v2/profiles/lock`, {
        method: 'POST',
        headers: bearerHeaders(token),
      });
    },
    setAutomaticSignIn(baseUrl: string, token: string, enabled: boolean) {
      return request(`${baseUrl}/api/v2/profiles/auto-sign-in`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ enabled }),
      });
    },
    getProfilePreferences(baseUrl: string, token: string) {
      return request(`${baseUrl}/api/v2/profile-preferences`, { headers: bearerHeaders(token) });
    },
    saveProfilePreferences(baseUrl: string, token: string, patch: LanProfilePreferences, selectionRevision?: number) {
      return request(`${baseUrl}/api/v2/profile-preferences`, {
        method: 'PATCH',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...patch, selectionRevision }),
      });
    },
    getProfileLists(baseUrl: string, token: string, kind?: LanProfileListKind) {
      const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
      return request(`${baseUrl}/api/v2/profile-lists${query}`, { headers: bearerHeaders(token) });
    },
    setProfileList(baseUrl: string, token: string, mediaId: string, kind: LanProfileListKind, present: boolean, selectionRevision?: number) {
      return request(`${baseUrl}/api/v2/profile-lists`, {
        method: present ? 'PUT' : 'DELETE',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId, kind, selectionRevision }),
      });
    },
    startHls(baseUrl: string, token: string, mediaId: string, options: StreamOptions, selectionRevision?: number, signal?: AbortSignal) {
      return request(`${baseUrl}/api/v2/start-hls`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId, options, selectionRevision }),
        signal,
      });
    },
    getPlaybackPlan(baseUrl: string, token: string, mediaId: string, capabilities: LanPlaybackCapabilities, selectionRevision?: number) {
      return request(`${baseUrl}/api/v2/playback-plan`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId, capabilities, selectionRevision }),
      });
    },
    getProgress(baseUrl: string, token: string) {
      return request(`${baseUrl}/api/v2/progress`, { headers: bearerHeaders(token) });
    },
    saveProgress(baseUrl: string, token: string, body: { mediaId: string; position: number; duration: number; selectionRevision?: number }) {
      return request(`${baseUrl}/api/v2/progress`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
    },
    refreshCredentials(baseUrl: string, refreshToken: string, deviceName?: string) {
      return request(`${baseUrl}/api/v2/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Loom-Profile-Api-Version': '1' },
        body: JSON.stringify({ refreshToken, deviceName }),
      });
    },
    getLibrary(baseUrl: string, token: string, etag?: string) {
      return request(`${baseUrl}/api/v2/library`, {
        headers: bearerHeaders(token, etag ? { 'If-None-Match': etag } : {}),
      });
    },
    getLibraryIndex(baseUrl: string, token: string, etag?: string) {
      return request(`${baseUrl}/api/v2/library/index`, {
        headers: bearerHeaders(token, etag ? { 'If-None-Match': etag } : {}),
      });
    },
    getLibraryItem(baseUrl: string, token: string, mediaId: string) {
      return request(`${baseUrl}/api/v2/library/items/${encodeURIComponent(mediaId)}`, {
        headers: bearerHeaders(token),
      });
    },
    pair(baseUrl: string, body: { code?: string; deviceName: string; approvalRequested?: boolean }) {
      return request(`${baseUrl}/api/v2/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Loom-Profile-Api-Version': '1' },
        body: JSON.stringify(body),
      });
    },
    pairingApprovalStatus(baseUrl: string, approvalRequest: Pick<LanPairApprovalRequest, 'requestId' | 'requestSecret'>) {
      return request(`${baseUrl}/api/v2/pair/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Loom-Profile-Api-Version': '1' },
        body: JSON.stringify(approvalRequest),
      });
    },
    getOfficialArtworkCandidates(baseUrl: string, token: string, mediaId: string, selectionRevision?: number) {
      return request(`${baseUrl}/api/v2/artwork/official-candidates`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId, selectionRevision }),
      });
    },
    applyOfficialArtwork(baseUrl: string, token: string, mediaId: string, candidate: OfficialMetadataCandidate, selectionRevision?: number) {
      return request(`${baseUrl}/api/v2/artwork/apply-official`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId, candidate, selectionRevision }),
      });
    },
    getTrackPreferences(baseUrl: string, token: string, scope: string) {
      return request(`${baseUrl}/api/v2/playback-track-preferences?scope=${encodeURIComponent(scope)}`, {
        headers: bearerHeaders(token),
      });
    },
    saveTrackPreferences(baseUrl: string, token: string, scope: string, preferences: PlaybackTrackPreferences, selectionRevision?: number) {
      return request(`${baseUrl}/api/v2/playback-track-preferences`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ scope, preferences, selectionRevision }),
      });
    },
    getPlaybackSegments(baseUrl: string, token: string, params: URLSearchParams, signal?: AbortSignal) {
      return request(`${baseUrl}/api/v2/playback/segments?${params.toString()}`, {
        headers: bearerHeaders(token),
        signal,
      });
    },
  };
}

export type MobileLanClient = ReturnType<typeof createMobileLanClient>;


export class MobileLanTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The desktop did not respond within ${timeoutMs}ms.`);
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
