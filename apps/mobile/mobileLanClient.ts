import type { OfficialMetadataCandidate, PlaybackTrackPreferences, StreamOptions } from './mobileDomain';

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

function bearerHeaders(token: string, headers: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...headers };
}

export function createMobileLanClient(fetchImpl: FetchImplementation = fetch) {
  return {
    getClientConfig(baseUrl: string, token: string) {
      return fetchImpl(`${baseUrl}/api/v2/client-config`, { headers: bearerHeaders(token) });
    },
    startHls(baseUrl: string, token: string, mediaId: string, options: StreamOptions) {
      return fetchImpl(`${baseUrl}/api/v2/start-hls`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId, options }),
      });
    },
    getProgress(baseUrl: string, token: string) {
      return fetchImpl(`${baseUrl}/api/v2/progress`, { headers: bearerHeaders(token) });
    },
    saveProgress(baseUrl: string, token: string, body: { mediaId: string; position: number; duration: number }) {
      return fetchImpl(`${baseUrl}/api/v2/progress`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
    },
    refreshCredentials(baseUrl: string, refreshToken: string) {
      return fetchImpl(`${baseUrl}/api/v2/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    },
    getLibrary(baseUrl: string, token: string, etag?: string) {
      return fetchImpl(`${baseUrl}/api/v2/library`, {
        headers: bearerHeaders(token, etag ? { 'If-None-Match': etag } : {}),
      });
    },
    pair(baseUrl: string, body: { code: string; deviceId?: string; deviceName: string }) {
      return fetchImpl(`${baseUrl}/api/v2/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
    getOfficialArtworkCandidates(baseUrl: string, token: string, mediaId: string) {
      return fetchImpl(`${baseUrl}/api/artwork/official-candidates`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId }),
      });
    },
    applyOfficialArtwork(baseUrl: string, token: string, mediaId: string, candidate: OfficialMetadataCandidate) {
      return fetchImpl(`${baseUrl}/api/artwork/apply-official`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId, candidate }),
      });
    },
    getTrackPreferences(baseUrl: string, token: string, scope: string) {
      return fetchImpl(`${baseUrl}/api/v2/playback-track-preferences?scope=${encodeURIComponent(scope)}`, {
        headers: bearerHeaders(token),
      });
    },
    saveTrackPreferences(baseUrl: string, token: string, scope: string, preferences: PlaybackTrackPreferences) {
      return fetchImpl(`${baseUrl}/api/v2/playback-track-preferences`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ scope, preferences }),
      });
    },
    getPlaybackSegments(baseUrl: string, token: string, params: URLSearchParams, signal?: AbortSignal) {
      return fetchImpl(`${baseUrl}/api/v2/playback/segments?${params.toString()}`, {
        headers: bearerHeaders(token),
        signal,
      });
    },
  };
}

export type MobileLanClient = ReturnType<typeof createMobileLanClient>;
