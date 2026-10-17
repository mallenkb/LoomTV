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

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{6,}$/;

/** The video ID in a YouTube link, a bare ID, or '' when there is none. */
export function youtubeVideoId(value?: string): string {
  if (!value) return '';
  try {
    const rawValue = value.trim();
    if (YOUTUBE_VIDEO_ID.test(rawValue)) return rawValue;
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    const segments = url.pathname.split('/').filter(Boolean);
    let candidate = '';
    if (host === 'youtu.be') {
      candidate = segments[0] || '';
    } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') candidate = url.searchParams.get('v') || '';
      else if (['embed', 'shorts', 'live'].includes(segments[0] || '')) candidate = segments[1] || '';
    }
    return YOUTUBE_VIDEO_ID.test(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

/** Seconds from a YouTube `t` or `start` value such as `90`, `90s` or `1m30s`. */
function youtubeStartSeconds(url: URL): number {
  const value = (url.searchParams.get('t') || url.searchParams.get('start') || '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || !value) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

export function youtubeEmbedUrl(videoId: string, startSeconds = 0): string {
  const params = new URLSearchParams({ autoplay: '1', playsinline: '1', rel: '0', modestbranding: '1' });
  if (startSeconds > 0) params.set('start', String(Math.floor(startSeconds)));
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params}`;
}

/** Hosts the renderer may frame. The CSP frame-src and the frame guard use this list. */
export const VIDEO_EMBED_ORIGINS = ['https://www.youtube-nocookie.com', 'https://www.youtube.com', 'https://player.vimeo.com'] as const;

/**
 * The embeddable player URL for an accepted YouTube or Vimeo page, or null when
 * the link is not a single video (a channel, playlist or profile page). Watch
 * pages refuse to be framed, so only these embed URLs are ever loaded.
 */
export function videoPageEmbedUrl(value: string): string | null {
  if (!isTrustedVideoPageUrl(value)) return null;
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.endsWith('vimeo.com')) {
    const segments = url.pathname.split('/').filter(Boolean);
    const [id, hash] = host === 'player.vimeo.com'
      ? (segments[0] === 'video' ? [segments[1], url.searchParams.get('h') || ''] : [])
      : [segments[0], segments[1] || ''];
    if (!id || !/^\d+$/.test(id)) return null;
    const params = new URLSearchParams({ autoplay: '1' });
    if (hash && /^[A-Za-z0-9]+$/.test(hash)) params.set('h', hash);
    return `https://player.vimeo.com/video/${id}?${params}`;
  }
  const videoId = youtubeVideoId(value);
  return videoId ? youtubeEmbedUrl(videoId, youtubeStartSeconds(url)) : null;
}
