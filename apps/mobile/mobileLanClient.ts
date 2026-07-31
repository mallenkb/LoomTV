import type { OfficialMetadataCandidate, PlaybackTrackPreferences, StreamOptions } from './mobileDomain';
import type {
  LanProfileListKind,
  LanProfilePreferences,
  LanProfileSelectionRequest,
} from '@loom-media-server/lan-protocol';
import { secureLanUrl } from './mobileSecureTransport';

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

function bearerHeaders(token: string, headers: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'X-Loom-Profile-Api-Version': '1', ...headers };
}

export function createMobileLanClient(
  fetchImpl: FetchImplementation = (input, init) => fetch(secureLanUrl(input), init),
) {
  return {
    getClientConfig(baseUrl: string, token: string) {
      return fetchImpl(`${baseUrl}/api/v2/client-config`, { headers: bearerHeaders(token) });
    },
    getProfiles(baseUrl: string, token: string) {
      return fetchImpl(`${baseUrl}/api/v2/profiles`, { headers: bearerHeaders(token) });
    },
    getActiveProfile(baseUrl: string, token: string) {
      return fetchImpl(`${baseUrl}/api/v2/profiles/active`, { headers: bearerHeaders(token) });
    },
    selectProfile(baseUrl: string, token: string, body: LanProfileSelectionRequest) {
      return fetchImpl(`${baseUrl}/api/v2/profiles/select`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
    },
    lockProfile(baseUrl: string, token: string) {
      return fetchImpl(`${baseUrl}/api/v2/profiles/lock`, {
        method: 'POST',
        headers: bearerHeaders(token),
      });
    },
    setAutomaticSignIn(baseUrl: string, token: string, enabled: boolean) {
      return fetchImpl(`${baseUrl}/api/v2/profiles/auto-sign-in`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ enabled }),
      });
    },
    getProfilePreferences(baseUrl: string, token: string) {
      return fetchImpl(`${baseUrl}/api/v2/profile-preferences`, { headers: bearerHeaders(token) });
    },
    saveProfilePreferences(baseUrl: string, token: string, patch: LanProfilePreferences, selectionRevision?: number) {
      return fetchImpl(`${baseUrl}/api/v2/profile-preferences`, {
        method: 'PATCH',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...patch, selectionRevision }),
      });
    },
    getProfileLists(baseUrl: string, token: string, kind?: LanProfileListKind) {
      const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
      return fetchImpl(`${baseUrl}/api/v2/profile-lists${query}`, { headers: bearerHeaders(token) });
    },
    setProfileList(baseUrl: string, token: string, mediaId: string, kind: LanProfileListKind, present: boolean, selectionRevision?: number) {
      return fetchImpl(`${baseUrl}/api/v2/profile-lists`, {
        method: present ? 'PUT' : 'DELETE',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId, kind, selectionRevision }),
      });
    },
    startHls(baseUrl: string, token: string, mediaId: string, options: StreamOptions, selectionRevision?: number) {
      return fetchImpl(`${baseUrl}/api/v2/start-hls`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mediaId, options, selectionRevision }),
      });
    },
    getProgress(baseUrl: string, token: string) {
      return fetchImpl(`${baseUrl}/api/v2/progress`, { headers: bearerHeaders(token) });
    },
    saveProgress(baseUrl: string, token: string, body: { mediaId: string; position: number; duration: number; selectionRevision?: number }) {
      return fetchImpl(`${baseUrl}/api/v2/progress`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
    },
    refreshCredentials(baseUrl: string, refreshToken: string, deviceName?: string) {
      return fetchImpl(`${baseUrl}/api/v2/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Loom-Profile-Api-Version': '1' },
        body: JSON.stringify({ refreshToken, deviceName }),
      });
    },
    getLibrary(baseUrl: string, token: string, etag?: string) {
      return fetchImpl(`${baseUrl}/api/v2/library`, {
        headers: bearerHeaders(token, etag ? { 'If-None-Match': etag } : {}),
      });
    },
    pair(baseUrl: string, body: { code: string; deviceName: string }) {
      return fetchImpl(`${baseUrl}/api/v2/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Loom-Profile-Api-Version': '1' },
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
    saveTrackPreferences(baseUrl: string, token: string, scope: string, preferences: PlaybackTrackPreferences, selectionRevision?: number) {
      return fetchImpl(`${baseUrl}/api/v2/playback-track-preferences`, {
        method: 'POST',
        headers: bearerHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ scope, preferences, selectionRevision }),
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
