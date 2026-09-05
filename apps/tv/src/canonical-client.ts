export type Credential = { id: string; secret: string; scheme?: 'LoomDevice' | 'LoomInvitation' };
export type Profile = { id: string; name: string; kind: 'adult' | 'child' | 'guest'; hasPin: boolean };
export type ProfileListKind = 'watchlist' | 'favorite' | 'watched';
export type ProfileListEntry = {
  profileId?: string;
  mediaId: string;
  kind: ProfileListKind;
  createdAt?: number;
};
export type LibraryItem = {
  id: string;
  title: string;
  kind: 'movie' | 'series' | 'episode' | 'video';
  year?: number;
  summary?: string;
  available: boolean;
  seriesId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodes?: LibraryItem[];
};

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

function normalizedBaseUrl(value: string): string {
  const text = value.trim().replace(/\/+$/, '');
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (parsed.protocol !== 'https:') throw new Error('LoomTV TV requires an HTTPS server address.');
  return parsed.origin;
}

async function payload<T>(response: Response): Promise<T> {
  const document = await response.json() as Envelope<T>;
  if (!response.ok || !document.ok) {
    const failure = document as Extract<Envelope<T>, { ok: false }>;
    throw Object.assign(new Error(failure.error?.message || 'The server rejected the request.'), {
      code: failure.error?.code || 'request_failed', status: response.status,
    });
  }
  return document.data;
}

export function isTvAuthorizationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = Number((error as { status?: unknown }).status);
  return status === 401 || status === 403;
}

export class CanonicalTvClient {
  readonly baseUrl: string;
  private readonly transportBaseUrl: string;
  private credential: Credential | null;
  private activeProfileId = '';

  constructor(baseUrl: string, credential: Credential | null = null, transportBaseUrl?: string) {
    this.baseUrl = normalizedBaseUrl(baseUrl);
    this.transportBaseUrl = transportBaseUrl ? transportBaseUrl.replace(/\/+$/, '') : this.baseUrl;
    this.credential = credential;
  }

  setCredential(credential: Credential | null) { this.credential = credential; }

  private headers(json = false): Record<string, string> {
    return {
      ...(this.credential ? { Authorization: `${this.credential.scheme || 'LoomDevice'} ${this.credential.id}.${this.credential.secret}` } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private endpoint(path: string): string { return `${this.transportBaseUrl}${path}`; }

  async discover() {
    return payload<{ apiVersion: string; serverVersion: string; certificateFingerprint?: string }>(
      await fetch(this.endpoint('/api/v1/discovery')),
    );
  }

  async requestPairing(deviceName: string) {
    return payload<{ requestId: string; requestSecret: string; expiresAt: number }>(await fetch(this.endpoint('/api/v1/pairing/requests'), {
      method: 'POST', headers: this.headers(true), body: JSON.stringify({ deviceName, platform: 'android-tv' }),
    }));
  }

  async pairingStatus(requestId: string, requestSecret: string) {
    return payload<{ status: 'pending' | 'approved' | 'denied' | 'expired'; credential?: Credential }>(
      await fetch(this.endpoint(`/api/v1/pairing/requests/${encodeURIComponent(requestId)}`), {
        headers: { Authorization: `LoomPairing ${requestSecret}` },
      }),
    );
  }

  async acceptInvitation(invitationId: string, invitationSecret: string, deviceId: string) {
    return payload<{ credential: Credential }>(await fetch(this.endpoint(
      `/api/v1/invitations/${encodeURIComponent(invitationId)}/accept`,
    ), {
      method: 'POST',
      headers: { Authorization: `LoomInvite ${invitationSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    }));
  }

  async profiles() {
    return payload<{ profiles: Profile[] }>(await fetch(this.endpoint('/api/v1/profiles'), { headers: this.headers() }));
  }

  async selectProfile(profileId: string, pin?: string) {
    const selected = await payload<{ profile: Profile }>(await fetch(this.endpoint(`/api/v1/profiles/${encodeURIComponent(profileId)}/select`), {
      method: 'POST', headers: this.headers(true), body: JSON.stringify({ ...(pin ? { pin } : {}) }),
    }));
    this.activeProfileId = profileId;
    return selected;
  }

  async library() {
    const [library, series] = await Promise.all([
      fetch(this.endpoint('/api/v1/library'), { headers: this.headers() })
        .then((response) => payload<{ items: LibraryItem[] }>(response)),
      fetch(this.endpoint('/api/v1/library/series'), { headers: this.headers() })
        .then((response) => payload<{ series: Array<LibraryItem & { seasons: Array<{ episodes: LibraryItem[] }> }> }>(response)),
    ]);
    const seriesItems = series.series.map((entry) => ({
      ...entry,
      id: entry.id || `series:${encodeURIComponent(entry.title.toLowerCase())}`,
      kind: 'series' as const,
      available: entry.seasons.some((season) => season.episodes.some((episode) => episode.available)),
      episodes: entry.seasons.flatMap((season) => season.episodes),
    }));
    const episodeIds = new Set(seriesItems.flatMap((entry) => entry.episodes.map((episode) => episode.id)));
    const seriesIds = new Set(seriesItems.map((entry) => entry.id));
    return { items: [...library.items.filter((item) => !seriesIds.has(item.id)
      && (item.kind !== 'episode' || !episodeIds.has(item.id))), ...seriesItems] };
  }

  async progress(mediaId: string) {
    if (!this.activeProfileId) throw new Error('Choose a profile before loading progress.');
    return payload<{ progress: { positionSeconds?: number; position?: number; durationSeconds?: number; duration?: number; watched?: boolean } | null }>(
      await fetch(this.endpoint(`/api/v1/profiles/${encodeURIComponent(this.activeProfileId)}/progress/${encodeURIComponent(mediaId)}`), { headers: this.headers() }),
    );
  }

  async saveProgress(mediaId: string, positionSeconds: number, durationSeconds: number, watched = false) {
    if (!this.activeProfileId) throw new Error('Choose a profile before saving progress.');
    return payload<{ progress: unknown }>(await fetch(
      this.endpoint(`/api/v1/profiles/${encodeURIComponent(this.activeProfileId)}/progress/${encodeURIComponent(mediaId)}`),
      {
        method: 'PUT', headers: this.headers(true), body: JSON.stringify({ positionSeconds, durationSeconds, watched }),
      },
    ));
  }

  async listEntries(kind?: ProfileListKind) {
    if (!this.activeProfileId) throw new Error('Choose a profile before loading My List.');
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    return payload<{ entries: ProfileListEntry[] }>(await fetch(this.endpoint(
      `/api/v1/profiles/${encodeURIComponent(this.activeProfileId)}/lists${query}`,
    ), { headers: this.headers() }));
  }

  async setListEntry(mediaId: string, kind: ProfileListKind, present: boolean) {
    if (!this.activeProfileId) throw new Error('Choose a profile before changing a list.');
    return payload<{ entries: ProfileListEntry[] }>(await fetch(this.endpoint(
      `/api/v1/profiles/${encodeURIComponent(this.activeProfileId)}/lists/${encodeURIComponent(kind)}/${encodeURIComponent(mediaId)}`,
    ), { method: present ? 'PUT' : 'DELETE', headers: this.headers() }));
  }

  async planPlayback(mediaId: string, startSeconds = 0, tracks: { audioTrackId?: string | null; subtitleTrackId?: string | null } = {}) {
    return payload<{
      directUrl: string | null;
      directRenewUrl?: string;
      directSessionId?: string;
      directExpiresAt?: number;
      transcodeUrl: string | null;
      plan: { mode: 'direct' | 'remux' | 'transcode' };
      probe: { durationSeconds?: number; tracks: Array<{ id: string; kind: string; language?: string; title?: string }> };
    }>(await fetch(this.endpoint(`/api/v1/media/${encodeURIComponent(mediaId)}/playback-plan`), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        startSeconds,
        capabilities: {
          containers: ['mp4', 'webm', 'mkv', 'ts'],
          videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
          audioCodecs: ['aac', 'ac3', 'eac3', 'opus', 'mp3'],
          streamingProtocols: ['http', 'hls'],
          subtitleModes: ['burn-in'],
          maxWidth: 3840,
          maxHeight: 2160,
        },
        ...(tracks.audioTrackId !== undefined ? { audioTrackId: tracks.audioTrackId } : {}),
        ...(tracks.subtitleTrackId !== undefined ? { subtitleTrackId: tracks.subtitleTrackId } : {}),
      }),
    }));
  }

  async startTranscode(transcodeUrl: string) {
    const result = await payload<{ playlistUrl: string; sessionId: string; renewUrl: string; expiresAt: number }>(await fetch(this.absoluteUrl(transcodeUrl), {
      method: 'POST', headers: this.headers(),
    }));
    if (!result.playlistUrl) throw new Error('The server did not return a playback stream.');
    return { ...result, playlistUrl: this.absoluteUrl(result.playlistUrl) };
  }

  async renewPlayback(mediaId: string, action: 'direct' | 'hls', sessionId: string) {
    const result = await payload<{ directUrl?: string; playlistUrl?: string; expiresAt: number }>(await fetch(
      this.endpoint(`/api/v1/media/${encodeURIComponent(mediaId)}/playback-session/renew`),
      { method: 'POST', headers: this.headers(true), body: JSON.stringify({ action, sessionId }) },
    ));
    const relative = action === 'direct' ? result.directUrl : result.playlistUrl;
    if (!relative) throw new Error('The server did not renew the playback capability.');
    return { url: this.absoluteUrl(relative), expiresAt: result.expiresAt };
  }

  async stopPlayback(mediaId: string, sessionId?: string) {
    if (!sessionId) return;
    await fetch(this.endpoint(`/api/v1/media/${encodeURIComponent(mediaId)}/playback-session`), {
      method: 'DELETE', headers: this.headers(true), body: JSON.stringify({ sessionId }),
    });
  }

  async signOut() {
    await fetch(this.endpoint('/api/v1/auth/session'), { method: 'DELETE', headers: this.headers() });
    this.credential = null;
    this.activeProfileId = '';
  }

  absoluteUrl(value: string): string {
    const remote = new URL(value, this.baseUrl);
    if (remote.origin !== this.baseUrl) throw new Error('The server returned a playback URL for another origin.');
    return `${this.transportBaseUrl}${remote.pathname}${remote.search}${remote.hash}`;
  }
}
