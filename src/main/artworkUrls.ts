import { LOCAL_ACCESS_QUERY_PARAM, addLocalAccessToken } from './serverSecurity';
import { getMediaServerPort } from './mediaServer';
import { isLoopbackHost } from './networkInfo';
import { durableArtworkSource, isInlineArtworkSource } from './artworkSources';
import { customArtworkReference, parseCustomArtworkReference } from './artworkCache';
import { getCustomArtwork } from './database';
import type { MediaItem } from './metadata/types';

export interface ArtworkUrlsDeps {
  localAccessToken: string;
  buildSignedLanUrl: (base: string, pathname: string, params: URLSearchParams, ttlSeconds?: number) => string;
}

export function createArtworkUrls(deps: ArtworkUrlsDeps) {
  const { localAccessToken, buildSignedLanUrl } = deps;

  function getLocalImageUrl(filePath: string): string {
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), localAccessToken);
    return `http://127.0.0.1:${getMediaServerPort()}/api/local-image?${params.toString()}`;
  }

  function getLocalThumbnailUrl(filePath: string, time = '00:03:00'): string {
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath, t: time }), localAccessToken);
    return `http://127.0.0.1:${getMediaServerPort()}/api/thumbnail?${params.toString()}`;
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

  function artworkDeliveryUrl(source?: string | null): string {
    if (isInlineArtworkSource(source)) return String(source).trim();

    const durableSource = durableArtworkSource(source);
    if (!durableSource) return '';

    const customArtwork = parseCustomArtworkReference(durableSource);
    if (customArtwork) {
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

    return durableSource;
  }

  function signedArtworkUrlForRemote(base: string, pathname: string, params: URLSearchParams): string {
    return buildSignedLanUrl(base, pathname, params);
  }

  function rewriteLocalServerUrlSigned(source: string, base: string): string {
    try {
      const parsed = new URL(source);
      const params = new URLSearchParams(parsed.search);
      params.delete('token');
      return signedArtworkUrlForRemote(base, parsed.pathname, params);
    } catch {
      return source;
    }
  }

  function remoteArtworkDeliveryUrl(source: string, base: string, _token: string): string {
    if (!source) return '';
    if (isLocalMediaServerArtworkUrl(source)) return rewriteLocalServerUrlSigned(source, base);
    if (isExternalArtworkUrl(source)) {
      return signedArtworkUrlForRemote(base, '/api/cached-artwork', new URLSearchParams({ source }));
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

  function signedSubtitleUrlForRemote(base: string, source: string): string {
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
      return buildSignedLanUrl(base, parsed.pathname, params);
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

  function subtitleRecordsForLocalNetwork(subtitles: MediaItem['subtitles'] | undefined, base: string): MediaItem['subtitles'] {
    return subtitles?.map((subtitle) => ({
      ...subtitle,
      url: signedSubtitleUrlForRemote(base, subtitle.url),
    }));
  }

  function orderedArtworkCandidates(...urls: Array<string | null | undefined>): string[] {
    return Array.from(new Set(urls.filter((url): url is string => Boolean(url?.trim()))));
  }

  return {
    getLocalImageUrl,
    getLocalThumbnailUrl,
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
