import fs from 'node:fs';
import { LOCAL_ACCESS_QUERY_PARAM, addLocalAccessToken } from './serverSecurity';
import { getMediaServerPort } from './mediaServer';
import { isLoopbackHost } from './networkInfo';
import { durableArtworkSource, isInlineArtworkSource } from './artworkSources';
import { customArtworkReference, parseCustomArtworkReference } from './artworkCache';
import { getCustomArtwork } from './database';
import { isImageFileName } from './fileClassification';
import type { MediaItem } from './metadata/types';
import type { LocalResourceKind } from './resourceRegistry';

const LAN_IMAGE_CACHE_QUERY_PARAM = 'loomtvImageCache';
type RemoteProfileIdentity = { deviceId: string; profileId: string; selectionRevision: number };

export interface ArtworkUrlsDeps {
  localAccessToken: string;
  buildSignedLanUrl: (
    base: string,
    pathname: string,
    params: URLSearchParams,
    ttlSeconds?: number,
    options?: { stable?: boolean },
  ) => string;
  registerRemoteResource: (kind: LocalResourceKind, value: string) => string;
}

export function createArtworkUrls(deps: ArtworkUrlsDeps) {
  const { localAccessToken, buildSignedLanUrl, registerRemoteResource } = deps;
  const bindProfile = (params: URLSearchParams, identity?: RemoteProfileIdentity): URLSearchParams => {
    if (identity) {
      params.set('deviceId', identity.deviceId);
      params.set('profileId', identity.profileId);
      params.set('selectionRevision', String(identity.selectionRevision));
    }
    return params;
  };

  function getLocalImageUrl(filePath: string): string {
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), localAccessToken);
    return `http://127.0.0.1:${getMediaServerPort()}/api/local-image?${params.toString()}`;
  }

  function getLocalThumbnailUrl(filePath: string, time = '00:03:00'): string {
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath, t: time }), localAccessToken);
    return `http://127.0.0.1:${getMediaServerPort()}/api/thumbnail?${params.toString()}`;
  }

  function getRemoteThumbnailUrl(filePath: string, base: string, time = '00:03:00', identity?: RemoteProfileIdentity): string {
    const resourceId = registerRemoteResource('media', filePath);
    return signedArtworkUrlForRemote(base, '/api/thumbnail', bindProfile(new URLSearchParams({ resourceId, t: time }), identity));
  }

  function getEmbeddedThumbnailUrl(filePath: string, streamIndex?: number): string {
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath, embedded: '1' }), localAccessToken);
    if (streamIndex !== undefined) params.set('stream', String(streamIndex));
    return `http://127.0.0.1:${getMediaServerPort()}/api/thumbnail?${params.toString()}`;
  }

  function isLocalMediaServerArtworkUrl(source: string): boolean {
    try {
      const parsed = new URL(source);
      return isLoopbackHost(parsed.hostname)
        && ['/api/thumbnail', '/api/local-image', '/api/cached-artwork', '/api/custom-artwork'].includes(parsed.pathname);
    } catch {
      return false;
    }
  }

  function isExternalArtworkUrl(source: string): boolean {
    try {
      const parsed = new URL(source);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isLoopbackHost(parsed.hostname);
    } catch {
      return false;
    }
  }

  function isLocalImageFilePath(source: string): boolean {
    return isImageFileName(source) && fs.existsSync(source);
  }

  function artworkDeliveryUrl(source?: string | null): string {
    if (isInlineArtworkSource(source)) return String(source).trim();

    const durableSource = durableArtworkSource(source);
    if (!durableSource) return '';

    const customArtwork = parseCustomArtworkReference(durableSource);
    if (customArtwork) {
      // A library item can retain a custom-artwork reference after its saved
      // crop has been removed. Do not send that dead URL to the renderer or a
      // paired device; returning an empty source lets the next real poster
      // candidate become the primary image immediately.
      const customDataUrl = getCustomArtwork(customArtwork.mediaId)[customArtwork.target] || '';
      if (!/^data:image\/[^;,]+;base64,[A-Za-z0-9+/=\r\n]+$/i.test(customDataUrl)) return '';
      const params = addLocalAccessToken(new URLSearchParams({
        mediaId: customArtwork.mediaId,
        target: customArtwork.target,
      }), localAccessToken);
      return `http://127.0.0.1:${getMediaServerPort()}/api/custom-artwork?${params.toString()}`;
    }

    if (isLocalMediaServerArtworkUrl(durableSource)) {
      const parsed = new URL(durableSource);
      parsed.searchParams.set(LOCAL_ACCESS_QUERY_PARAM, localAccessToken);
      return `http://127.0.0.1:${getMediaServerPort()}${parsed.pathname}${parsed.search}`;
    }

    if (isExternalArtworkUrl(durableSource)) {
      const params = addLocalAccessToken(new URLSearchParams({ source: durableSource }), localAccessToken);
      return `http://127.0.0.1:${getMediaServerPort()}/api/cached-artwork?${params.toString()}`;
    }

    if (isLocalImageFilePath(durableSource)) {
      return getLocalImageUrl(durableSource);
    }

    return durableSource;
  }

  function signedArtworkUrlForRemote(base: string, pathname: string, params: URLSearchParams): string {
    params.set(LAN_IMAGE_CACHE_QUERY_PARAM, '1');
    return buildSignedLanUrl(base, pathname, params, undefined, { stable: true });
  }

  function rewriteLocalServerUrlSigned(source: string, base: string, identity?: RemoteProfileIdentity): string {
    try {
      const parsed = new URL(source);
      const params = new URLSearchParams(parsed.search);
      params.delete('token');
      params.delete('sig');
      params.delete('exp');
      params.delete('nonce');
      // The loopback access token rotates every app launch; leaving it in the
      // signed URL leaks it to paired devices and changes every artwork URL
      // across restarts, invalidating their long-lived image caches.
      params.delete(LOCAL_ACCESS_QUERY_PARAM);

      // Renderer artwork URLs contain the underlying source/path because they
      // are only reachable over loopback. LAN artwork handlers intentionally
      // reject those raw values and resolve opaque resource IDs instead, so
      // translate them before signing the URL for a paired device.
      if (parsed.pathname === '/api/cached-artwork') {
        const externalSource = params.get('source') || '';
        if (externalSource) {
          params.delete('source');
          params.set('resourceId', registerRemoteResource('external-artwork', externalSource));
        }
      } else if (parsed.pathname === '/api/local-image') {
        const imagePath = params.get('path') || '';
        if (imagePath) {
          params.delete('path');
          params.set('resourceId', registerRemoteResource('image', imagePath));
        }
      } else if (parsed.pathname === '/api/thumbnail') {
        const mediaPath = params.get('path') || '';
        if (mediaPath) {
          params.delete('path');
          params.set('resourceId', registerRemoteResource('media', mediaPath));
        }
      }
      return signedArtworkUrlForRemote(base, parsed.pathname, bindProfile(params, identity));
    } catch {
      return source;
    }
  }

  function remoteArtworkDeliveryUrl(source: string, base: string, identity?: RemoteProfileIdentity): string {
    if (!source) return '';
    if (isLocalMediaServerArtworkUrl(source)) return rewriteLocalServerUrlSigned(source, base, identity);
    if (isExternalArtworkUrl(source)) {
      const resourceId = registerRemoteResource('external-artwork', source);
      return signedArtworkUrlForRemote(base, '/api/cached-artwork', bindProfile(new URLSearchParams({ resourceId }), identity));
    }
    if (isLocalImageFilePath(source)) {
      const resourceId = registerRemoteResource('image', source);
      return signedArtworkUrlForRemote(base, '/api/local-image', bindProfile(new URLSearchParams({ resourceId }), identity));
    }
    return source;
  }

  function artworkDeliveryUrls(sources?: string[]): string[] {
    return Array.from(new Set((sources || []).map(artworkDeliveryUrl).filter(Boolean)));
  }

  function customArtworkForRenderer(mediaId: string): Record<string, string> {
    const entries = Object.entries(getCustomArtwork(mediaId)).map(([target]) => [
      target,
      artworkDeliveryUrl(customArtworkReference(mediaId, target)),
    ]);
    return Object.fromEntries(entries);
  }

  function localSubtitleUrl(source: string): string {
    const trimmed = source.trim();
    if (!trimmed) return trimmed;

    try {
      const parsed = new URL(trimmed, `http://127.0.0.1:${getMediaServerPort()}`);
      if (parsed.pathname !== '/subtitle') return source;
      parsed.searchParams.set(LOCAL_ACCESS_QUERY_PARAM, localAccessToken);
      return /^https?:\/\//i.test(trimmed) ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
    } catch {
      return source;
    }
  }

  function signedSubtitleUrlForRemote(base: string, source: string, identity?: RemoteProfileIdentity): string {
    const trimmed = source.trim();
    if (!trimmed) return trimmed;

    try {
      const parsed = new URL(trimmed, base);
      if (parsed.pathname !== '/subtitle') return source;
      const params = new URLSearchParams(parsed.search);
      params.delete(LOCAL_ACCESS_QUERY_PARAM);
      params.delete('sig');
      params.delete('exp');
      params.delete('nonce');
      const filePath = params.get('path');
      if (filePath) {
        params.delete('path');
        params.set('resourceId', registerRemoteResource('subtitle', filePath));
      }
      return buildSignedLanUrl(base, parsed.pathname, bindProfile(params, identity));
    } catch {
      return source;
    }
  }

  function subtitleRecordsForRenderer(subtitles?: MediaItem['subtitles']): MediaItem['subtitles'] {
    return subtitles?.map((subtitle) => ({
      ...subtitle,
      url: localSubtitleUrl(subtitle.url),
    }));
  }

  function subtitleRecordsForLocalNetwork(subtitles: MediaItem['subtitles'] | undefined, base: string, identity?: RemoteProfileIdentity): MediaItem['subtitles'] {
    return subtitles?.map((subtitle) => ({
      ...subtitle,
      url: signedSubtitleUrlForRemote(base, subtitle.url, identity),
    }));
  }

  function orderedArtworkCandidates(...urls: Array<string | null | undefined>): string[] {
    return Array.from(new Set(urls.filter((url): url is string => Boolean(url?.trim()))));
  }

  return {
    getLocalImageUrl,
    getLocalThumbnailUrl,
    getRemoteThumbnailUrl,
    getEmbeddedThumbnailUrl,
    isLocalMediaServerArtworkUrl,
    isExternalArtworkUrl,
    artworkDeliveryUrl,
    rewriteLocalServerUrlSigned,
    remoteArtworkDeliveryUrl,
    artworkDeliveryUrls,
    customArtworkForRenderer,
    localSubtitleUrl,
    signedSubtitleUrlForRemote,
    subtitleRecordsForRenderer,
    subtitleRecordsForLocalNetwork,
    orderedArtworkCandidates,
  };
}
