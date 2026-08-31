const IPTV_PLAYBACK_PROTOCOL = 'iptv:';
const IPTV_PLAYBACK_HOST = 'channel';

export type IptvPlaybackReference = {
  sourceId: string;
  channelId: string;
  format: 'hls' | 'direct';
};

/**
 * Renderer-safe reference for a stored IPTV channel. The main process resolves
 * it back to the exact stream URL in the database before playback starts.
 */
export function buildIptvPlaybackReference(sourceId: string, channelId: string, streamUrl = ''): string {
  const reference = new URL(
    `${IPTV_PLAYBACK_PROTOCOL}//${IPTV_PLAYBACK_HOST}/${encodeURIComponent(sourceId)}/${encodeURIComponent(channelId)}`,
  );
  if (/\.(?:mp4|m4v|mov|webm|mpd)(?:$|[?#])/i.test(streamUrl)) reference.searchParams.set('format', 'direct');
  return reference.toString();
}

export function parseIptvPlaybackReference(value: string): IptvPlaybackReference | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== IPTV_PLAYBACK_PROTOCOL || parsed.hostname !== IPTV_PLAYBACK_HOST) return null;
    const segments = parsed.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
    return {
      sourceId: segments[0],
      channelId: segments[1],
      format: parsed.searchParams.get('format') === 'direct' ? 'direct' : 'hls',
    };
  } catch {
    return null;
  }
}

export function isIptvPlaybackReference(value: string): boolean {
  return parseIptvPlaybackReference(value) !== null;
}
