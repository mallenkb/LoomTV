const EXTERNAL_PLAYBACK_PROTOCOL = 'external:';
const EXTERNAL_PLAYBACK_HOST = 'stream';

export type ExternalPlaybackReference = {
  url: string;
};

function encodeUrl(url: string): string {
  return encodeURIComponent(url);
}

function decodeUrl(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return '';
  }
}

export function buildExternalPlaybackReference(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('Stream URL is required.');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Stream URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Stream URL must use http or https.');
  }
  return `${EXTERNAL_PLAYBACK_PROTOCOL}//${EXTERNAL_PLAYBACK_HOST}/${encodeUrl(trimmed)}`;
}

export function parseExternalPlaybackReference(value: string): ExternalPlaybackReference | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== EXTERNAL_PLAYBACK_PROTOCOL || parsed.hostname !== EXTERNAL_PLAYBACK_HOST) return null;
    const encoded = parsed.pathname.slice(1);
    if (!encoded) return null;
    const url = decodeUrl(encoded);
    if (!url) return null;
    const urlParsed = new URL(url);
    if (urlParsed.protocol !== 'https:' && urlParsed.protocol !== 'http:') return null;
    return { url };
  } catch {
    return null;
  }
}

/** Video-site pages that may be framed. Matching is exact; no other host is framed. */
const TRUSTED_VIDEO_PAGE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be',
  'vimeo.com', 'www.vimeo.com', 'player.vimeo.com',
]);

/** True only for an HTTPS page on an exact YouTube or Vimeo host. */
export function isTrustedVideoPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && TRUSTED_VIDEO_PAGE_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ''));
  } catch {
    return false;
  }
}
