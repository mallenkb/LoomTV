import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { safeFetch } from '../safeFetch.ts';

const IPTV_PROXY_TOKEN_TTL_MS = 15 * 60 * 1000;
const IPTV_PROXY_PRUNE_INTERVAL_MS = 60 * 1000;
const IPTV_PROXY_MAX_RESOURCES = 20_000;
const IPTV_PROXY_MAX_BYTES = 64 * 1024 * 1024;
const IPTV_PROXY_TIMEOUT_MS = 30_000;

type ProxyResource = {
  url: string;
  expiresAt: number;
};

function isHlsPlaylist(url: string, contentType: string, body: Buffer): boolean {
  return /(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(contentType)
    || /\.m3u8?(?:$|[?#])/i.test(url)
    || body.subarray(0, 256).toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}
function resolvePlaylistResource(reference: string, playlistUrl: string): string | null {
  if (!reference || reference.startsWith('data:')) return null;
  let resolved: URL;
  try {
    resolved = new URL(reference, playlistUrl);
  } catch {
    return null;
  }
  if (resolved.protocol === 'http:') {
    throw new Error('The channel playlist contains an insecure media URL.');
  }
  return resolved.protocol === 'https:' ? resolved.toString() : null;
}

function rewriteHlsPlaylist(
  playlist: string,
  playlistUrl: string,
  localResourceUrl: (upstreamUrl: string) => string,
): string {
  return playlist.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) {
      const resolved = resolvePlaylistResource(trimmed, playlistUrl);
      return resolved ? localResourceUrl(resolved) : line;
    }
    return line.replace(/URI=(?:"([^"]+)"|([^,\s]+))/g, (match, quoted: string | undefined, bare: string | undefined) => {
      const resolved = resolvePlaylistResource(quoted || bare || '', playlistUrl);
      return resolved ? `URI="${localResourceUrl(resolved)}"` : match;
    });
  }).join('\n');
}

function forwardedCredentialQuery(reqUrl: URL): string {
  const localToken = reqUrl.searchParams.get('loomtvToken');
  return localToken ? `loomtvToken=${encodeURIComponent(localToken)}` : '';
}

function responseHeaders(response: Response, bodyLength: number, playlist: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'Content-Length': String(bodyLength),
  };
  const contentType = response.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;
  const contentRange = response.headers.get('content-range');
  if (contentRange && !playlist) headers['Content-Range'] = contentRange;
  const acceptRanges = response.headers.get('accept-ranges');
  if (acceptRanges && !playlist) headers['Accept-Ranges'] = acceptRanges;
  return headers;
}

export function createIptvStreamProxy(resolveChannelUrl: (sourceId: string, channelId: string) => string | null) {
  const resources = new Map<string, ProxyResource>();
  const tokensByUrl = new Map<string, string>();
  let lastPrunedAt = 0;

  const prune = (): void => {
    const now = Date.now();
    if (resources.size < IPTV_PROXY_MAX_RESOURCES && now - lastPrunedAt < IPTV_PROXY_PRUNE_INTERVAL_MS) return;
    lastPrunedAt = now;
    for (const [token, resource] of resources) {
      if (resource.expiresAt > now && resources.size <= IPTV_PROXY_MAX_RESOURCES) continue;
      resources.delete(token);
      if (tokensByUrl.get(resource.url) === token) tokensByUrl.delete(resource.url);
    }
  };

  const registerResource = (url: string): string => {
    prune();
    const existingToken = tokensByUrl.get(url);
    const existing = existingToken ? resources.get(existingToken) : null;
    if (existingToken && existing && existing.expiresAt > Date.now()) {
      existing.expiresAt = Date.now() + IPTV_PROXY_TOKEN_TTL_MS;
      return existingToken;
    }
    const token = randomBytes(24).toString('base64url');
    resources.set(token, { url, expiresAt: Date.now() + IPTV_PROXY_TOKEN_TTL_MS });
    tokensByUrl.set(url, token);
    return token;
  };

  const proxy = async (
    upstreamUrl: string,
    req: IncomingMessage,
    res: ServerResponse,
    reqUrl: URL,
  ): Promise<void> => {
    try {
      const range = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
      const response = await safeFetch(upstreamUrl, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: {
          Accept: '*/*',
          ...(range ? { Range: range } : {}),
        },
      }, {
        timeoutMs: IPTV_PROXY_TIMEOUT_MS,
        maxBytes: IPTV_PROXY_MAX_BYTES,
        maxRedirects: 4,
        retries: 1,
        operation: 'iptv.stream',
      });
      const body = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || '';
      const playlist = response.ok && isHlsPlaylist(upstreamUrl, contentType, body);
      if (!playlist) {
        res.writeHead(response.status, responseHeaders(response, body.byteLength, false));
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      const credentialQuery = forwardedCredentialQuery(reqUrl);
      const rewritten = rewriteHlsPlaylist(body.toString('utf8'), upstreamUrl, (resourceUrl) => {
        const token = registerResource(resourceUrl);
        return `/iptv/resource/${token}${credentialQuery ? `?${credentialQuery}` : ''}`;
      });
      const encoded = Buffer.from(rewritten, 'utf8');
      res.writeHead(response.status, {
        ...responseHeaders(response, encoded.byteLength, true),
        'Content-Type': 'application/vnd.apple.mpegurl',
      });
      res.end(req.method === 'HEAD' ? undefined : encoded);
    } catch {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('The live TV provider could not be reached.');
    }
  };

  return {
    async serveChannel(
      sourceId: string,
      channelId: string,
      req: IncomingMessage,
      res: ServerResponse,
      reqUrl: URL,
    ): Promise<void> {
      if (!sourceId || sourceId.length > 120 || !channelId || channelId.length > 120) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid live TV channel.');
        return;
      }
      const upstreamUrl = resolveChannelUrl(sourceId, channelId);
      if (!upstreamUrl) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('That live TV channel is no longer available.');
        return;
      }
      await proxy(upstreamUrl, req, res, reqUrl);
    },

    async serveResource(token: string, req: IncomingMessage, res: ServerResponse, reqUrl: URL): Promise<void> {
      prune();
      const resource = resources.get(token);
      if (!resource || resource.expiresAt <= Date.now()) {
        if (resource) {
          resources.delete(token);
          if (tokensByUrl.get(resource.url) === token) tokensByUrl.delete(resource.url);
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Live TV resource expired. Reload the channel.');
        return;
      }
      resource.expiresAt = Date.now() + IPTV_PROXY_TOKEN_TTL_MS;
      await proxy(resource.url, req, res, reqUrl);
    },
  };
}
