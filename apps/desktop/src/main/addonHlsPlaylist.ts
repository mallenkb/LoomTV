export type AddonResourceKind = 'auto' | 'playlist' | 'media' | 'key';

const PASSIVE_TAGS = new Set([
  'EXTM3U', 'EXTINF', 'EXT-X-VERSION', 'EXT-X-TARGETDURATION', 'EXT-X-MEDIA-SEQUENCE',
  'EXT-X-DISCONTINUITY-SEQUENCE', 'EXT-X-ENDLIST', 'EXT-X-PLAYLIST-TYPE', 'EXT-X-I-FRAMES-ONLY',
  'EXT-X-INDEPENDENT-SEGMENTS', 'EXT-X-START', 'EXT-X-BYTERANGE', 'EXT-X-DISCONTINUITY',
  'EXT-X-PROGRAM-DATE-TIME', 'EXT-X-GAP', 'EXT-X-BITRATE',
]);

function attributes(value: string): Map<string, string> {
  const result = new Map<string, string>();
  const attribute = /([A-Z0-9-]+)=("[^"\r\n]*"|[^,\s]+)(?:,|$)/gy;
  let offset = 0;
  while (offset < value.length) {
    attribute.lastIndex = offset;
    const match = attribute.exec(value);
    if (!match || result.has(match[1])) throw new Error('The HLS attribute list is invalid.');
    result.set(match[1], match[2]);
    offset = attribute.lastIndex;
  }
  return result;
}

/** All supported network references become host-owned child grants. */
export function rewriteAddonHlsPlaylist(
  body: string,
  finalUrl: string,
  issue: (url: string, kind: AddonResourceKind) => string,
): string {
  // eslint-disable-next-line no-control-regex -- Reject control bytes before parsing playlist lines.
  if (!body.replace(/^\uFEFF/, '').startsWith('#EXTM3U') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body)) {
    throw new Error('The provider returned an invalid HLS playlist.');
  }
  const lines = body.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length > 20_000) throw new Error('The HLS playlist is too large.');
  let nextIsPlaylist = false;
  const local = (reference: string, kind: AddonResourceKind) => {
    if (!reference || /[{}\s]/.test(reference)) throw new Error('The HLS resource reference is unsupported.');
    const url = new URL(reference, finalUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('The HLS playlist contains an unsupported resource address.');
    }
    return issue(url.toString(), kind);
  };
  const rewritten = lines.map(line => {
    const value = line.trim();
    if (!value) return '';
    if (!value.startsWith('#')) {
      const result = local(value, nextIsPlaylist ? 'playlist' : 'media');
      nextIsPlaylist = false;
      return result;
    }
    if (!value.startsWith('#EXT')) return value;
    const colon = value.indexOf(':');
    const tag = value.slice(1, colon < 0 ? undefined : colon);
    const payload = colon < 0 ? '' : value.slice(colon + 1);
    if (tag === 'EXT-X-STREAM-INF') {
      if (nextIsPlaylist) throw new Error('The HLS variant has no resource.');
      const attrs = attributes(payload);
      if ([...attrs.keys()].some(key => /URI|URL/.test(key))) throw new Error('Unsupported HLS reference.');
      nextIsPlaylist = true;
      return value;
    }
    if (['EXT-X-KEY', 'EXT-X-SESSION-KEY', 'EXT-X-MAP', 'EXT-X-MEDIA', 'EXT-X-I-FRAME-STREAM-INF'].includes(tag)) {
      const attrs = attributes(payload);
      const keyTag = tag === 'EXT-X-KEY' || tag === 'EXT-X-SESSION-KEY';
      if (keyTag && !['NONE', 'AES-128'].includes(attrs.get('METHOD') || '')) throw new Error('This HLS encryption method is unsupported.');
      if (keyTag && attrs.has('KEYFORMAT') && attrs.get('KEYFORMAT') !== '"identity"') throw new Error('DRM HLS keys are unsupported.');
      if ([...attrs.keys()].some(key => key !== 'URI' && /URI|URL/.test(key))) throw new Error('Unsupported HLS reference.');
      const uri = attrs.get('URI');
      if (uri) {
        if (!uri.startsWith('"') || !uri.endsWith('"')) throw new Error('The HLS resource URI must be quoted.');
        const kind = keyTag ? 'key' : tag === 'EXT-X-MAP' ? 'media' : 'playlist';
        attrs.set('URI', `"${local(uri.slice(1, -1), kind)}"`);
      } else if (tag !== 'EXT-X-MEDIA' && !(keyTag && attrs.get('METHOD') === 'NONE')) {
        throw new Error('The HLS tag is missing its resource.');
      }
      return `#${tag}:${[...attrs].map(([key, val]) => `${key}=${val}`).join(',')}`;
    }
    // Variable substitution, content steering, LL-HLS, external session data,
    // and future tags need explicit handling before any decoder sees them.
    if (!PASSIVE_TAGS.has(tag) || /(?:URI|URL)\s*=/i.test(payload)) throw new Error('This HLS playlist uses an unsupported feature.');
    return value;
  }).join('\n');
  if (nextIsPlaylist) throw new Error('The HLS variant has no resource.');
  return rewritten;
}
