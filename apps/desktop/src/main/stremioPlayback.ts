import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { addonPlaybackReference, parseAddonPlaybackReference } from '../shared/addonPlaybackReference.ts';
import { rewriteAddonHlsPlaylist, type AddonResourceKind } from './addonHlsPlaylist.ts';
import { openSafeMediaStream } from './safeMediaStream.ts';
import { openStremioTorrentMedia, prepareStremioTorrent, stremioTorrentMediaUrl, validateTorrentSource, type StremioTorrentSource, type StremioPlaybackTarget } from './stremioServiceClient.ts';
import type { ManagedTorrent } from './torrentEngine.ts';
import type { StremioTorrentPreparation } from '../shared/stremioService.ts';

type Identity = { profileId: string; selectionRevision: number };
type Source = Identity & {
  addonId: string;
  revision: string;
  url: string;
  sourceKind: string;
  requestHeaders?: Readonly<Record<string, string>>;
  target?: StremioPlaybackTarget;
  torrent?: StremioTorrentSource;
  torrentFile?: { infoHash: string; index: number };
  fileName?: string;
};
type Grant = Source & { expiresAt: number };
type Resource = { url: string; kind: AddonResourceKind };
type Session = {
  id: string;
  sourceToken: string;
  consumer: 'native' | 'browser';
  grant: Grant;
  expiresAt: number;
  idleUntil: number;
  resources: Map<string, Resource>;
  resourceKeys: Map<string, string>;
  requests: Set<AbortController>;
  revoked: Set<() => void>;
  bytes: number;
  starts: number;
  windowStart: number;
};

type TorrentLease = ManagedTorrent & { retain: () => TorrentLease };

/** Independent users can release the same worker without interrupting one another. */
function shareTorrent(engine: ManagedTorrent): TorrentLease {
  let references = 0;
  let failed = false;
  const failures = new Set<() => void>();
  engine.onFailure(() => { failed = true; for (const callback of [...failures]) callback(); });
  const retain = (): TorrentLease => {
    references++;
    let released = false;
    const listeners = new Set<() => void>();
    return { ...engine, retain: () => {
      if (released) throw new Error('This torrent source was closed.');
      return retain();
    }, onFailure: callback => {
      if (failed || released) { callback(); return; }
      listeners.add(callback); failures.add(callback);
    }, release: () => {
      if (released) return;
      released = true;
      for (const callback of listeners) failures.delete(callback);
      if (--references === 0) engine.release();
    } };
  };
  return retain();
}

export type AddonPlaybackLease = {
  url: string;
  contentType: string;
  release: () => void;
  onRevoke: (callback: () => void) => void;
};

const SOURCE_TTL = 6 * 60 * 60 * 1000;
const IDLE_TTL = 30 * 60 * 1000;
const MAX_PLAYLIST_BYTES = 1024 * 1024;
const MAX_SESSION_BYTES = 256 * 1024 ** 3;
const stale = () => new Error('This addon source expired or its access changed. Reload the source list.');

function mediaSignature(bytes: Buffer): boolean {
  const ascii = bytes.subarray(0, 12).toString('latin1');
  return /^(?:OggS|fLaC|FLV|RIFF|ID3|WEBVTT)/.test(ascii)
    || ['ftyp', 'styp', 'moov', 'moof', 'mdat', 'free', 'wide'].includes(ascii.slice(4, 8))
    || bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    || (bytes[0] === 0x47 && bytes[188] === 0x47)
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    || (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && [0xba, 0xb3].includes(bytes[3]));
}

/** Host-owned grants and sessions shared by native players and browser playback. */
export function createStremioPlayback(deps: {
  identity: () => Identity;
  revision: (profileId: string, addonId: string) => string;
  port: () => number;
  now?: () => number;
  prepareManagedTorrent?: (source: StremioTorrentSource, target: StremioPlaybackTarget | undefined, signal: AbortSignal) => Promise<ManagedTorrent>;
  onRevoked?: (reference: string) => void;
}) {
  const now = deps.now || Date.now;
  const grants = new Map<string, Grant>();
  const sessions = new Map<string, Session>();
  const preparations = new Map<string, { result: StremioTorrentPreparation; expiresAt: number; engine?: ManagedTorrent }>();
  const preparing = new Map<string, AbortController>();
  const engines = new Map<string, { engine: TorrentLease; expiresAt: number }>();
  let sweep: ReturnType<typeof setInterval> | undefined;

  const authorize = (grant: Source) => {
    const current = deps.identity();
    if (current.profileId !== grant.profileId || current.selectionRevision !== grant.selectionRevision
      || deps.revision(grant.profileId, grant.addonId) !== grant.revision) throw stale();
  };
  const dispose = (session: Session, revoked = false, notify = true) => {
    if (!sessions.delete(session.id)) return;
    for (const request of session.requests) request.abort();
    session.requests.clear();
    session.resources.clear();
    session.resourceKeys.clear();
    if (engines.has(session.sourceToken) && ![...sessions.values()].some(item => item.sourceToken === session.sourceToken)) {
      if (revoked) {
        engines.get(session.sourceToken)?.engine.release();
        engines.delete(session.sourceToken);
        grants.delete(session.sourceToken);
      } else {
        // A probe, decoder fallback, or retry releases its own relay lease.
        // It does not close the user's source. Allow the next decoder to
        // reopen the same grant; explicit close still releases immediately.
        const owned = engines.get(session.sourceToken);
        if (owned) owned.expiresAt = now() + 30_000;
      }
    }
    const callbacks = [...session.revoked];
    session.revoked.clear();
    if (sessions.size === 0 && preparations.size === 0 && engines.size === 0 && preparing.size === 0 && sweep) { clearInterval(sweep); sweep = undefined; }
    if (revoked && notify) {
      try { deps.onRevoked?.(addonPlaybackReference(session.sourceToken)); } catch { /* Window teardown must not interrupt revocation. */ }
    }
    if (revoked) for (const callback of callbacks) {
      try { callback(); } catch { /* A disposed engine cannot keep a revoked grant alive. */ }
    }
  };
  const revokeSource = (token: string) => {
    grants.delete(token);
    engines.get(token)?.engine.release();
    engines.delete(token);
    for (const session of sessions.values()) if (session.sourceToken === token) dispose(session, true);
  };
  const validateSession = (session: Session) => {
    if (!sessions.has(session.id) || session.expiresAt <= now() || session.idleUntil <= now()) throw stale();
    authorize(session.grant);
  };
  const revalidate = () => {
    const validity = new Map<string, boolean>();
    for (const [token, grant] of grants) {
      const key = JSON.stringify([grant.profileId, grant.selectionRevision, grant.addonId, grant.revision]);
      if (!validity.has(key)) {
        try { authorize(grant); validity.set(key, true); } catch { validity.set(key, false); }
      }
      if (!validity.get(key) || grant.expiresAt <= now()) grants.delete(token);
    }
    for (const session of sessions.values()) {
      try { validateSession(session); } catch { dispose(session, true); }
    }
    for (const [token, controller] of preparing) if (!grants.has(token)) controller.abort();
    for (const [token, preparation] of preparations) if (!grants.has(token) || preparation.expiresAt <= now()) {
      preparation.engine?.release(); preparations.delete(token);
    }
    for (const [token, owned] of engines) if (!grants.has(token) || owned.expiresAt <= now()) revokeSource(token);
    if (!sessions.size && !preparations.size && !engines.size && !preparing.size && sweep) { clearInterval(sweep); sweep = undefined; }
  };
  const resourcePath = (session: Session, url: string, kind: AddonResourceKind): string => {
    if (url.length > 8192) throw new Error('The addon resource URL is too long.');
    const key = `${kind}:${url}`;
    let token = session.resourceKeys.get(key);
    if (!token) {
      if (session.resources.size >= 8192) throw new Error('The addon playlist has too many resources.');
      token = randomBytes(18).toString('base64url');
      session.resources.set(token, { url, kind });
      session.resourceKeys.set(key, token);
    }
    return `/addon-media/${session.id}/${token}.${kind === 'playlist' ? 'm3u8' : kind === 'key' ? 'key' : 'media'}`;
  };
  const issue = (source: Source, managed = false): string => {
    authorize(source);
    const url = new URL(source.url);
    if (source.torrent) validateTorrentSource(source.torrent);
    else if (source.torrentFile) {
      if (!managed && source.url !== stremioTorrentMediaUrl(source.torrentFile.infoHash, source.torrentFile.index)) throw stale();
    } else if (url.protocol !== 'https:' || url.username || url.password || url.hash || source.url.length > 8192) throw stale();
    for (const [token, grant] of grants) if (grant.expiresAt <= now()) grants.delete(token);
    while (grants.size >= 4000) {
      const oldest = grants.keys().next().value;
      if (!oldest) break;
      grants.delete(oldest);
    }
    const token = randomUUID();
    grants.set(token, { ...source, requestHeaders: source.requestHeaders && { ...source.requestHeaders }, expiresAt: now() + SOURCE_TTL });
    return addonPlaybackReference(token);
  };
  const open = (reference: string, consumer: 'native' | 'browser' = 'native'): AddonPlaybackLease => {
    const token = parseAddonPlaybackReference(reference);
    const grant = token ? grants.get(token) : undefined;
    if (!token || !grant || grant.expiresAt <= now()) throw stale();
    authorize(grant);
    if (grant.torrent) throw new Error('Choose a torrent file before starting playback.');
    if (grant.torrentFile && consumer === 'browser') throw new Error('Torrent playback currently requires the native VLC or mpv player.');
    const port = deps.port();
    if (!Number.isInteger(port) || port <= 0) throw new Error('The local media server is unavailable.');
    revalidate();
    const existing = consumer === 'browser' ? [...sessions.values()].find(item => item.sourceToken === token && item.consumer === consumer) : undefined;
    if (!existing && sessions.size >= 4) throw new Error('Too many addon playback sessions are active. Close another player.');
    const session: Session = existing || {
      id: randomUUID(), sourceToken: token, consumer, grant, expiresAt: now() + SOURCE_TTL,
      idleUntil: now() + IDLE_TTL, resources: new Map(), resourceKeys: new Map(),
      requests: new Set(), revoked: new Set(), bytes: 0, starts: 0, windowStart: now(),
    };
    session.idleUntil = now() + IDLE_TTL;
    const owned = engines.get(token);
    if (owned) owned.expiresAt = Infinity;
    sessions.set(session.id, session);
    const root = resourcePath(session, grant.url, grant.sourceKind === 'hls' ? 'playlist' : 'auto');
    if (!sweep) { sweep = setInterval(revalidate, 10_000); sweep.unref(); }
    return {
      url: `http://127.0.0.1:${port}${root}`,
      contentType: grant.sourceKind === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      release: () => dispose(session),
      onRevoke: callback => { if (sessions.has(session.id)) session.revoked.add(callback); else callback(); },
    };
  };

  // Browser engines choose their HLS loader before fetching the local URL.
  // Resolve extensionless playlists in the host so this choice needs no provider URL.
  const openBrowser = async (reference: string): Promise<AddonPlaybackLease> => {
    const token = parseAddonPlaybackReference(reference);
    const grant = token ? grants.get(token) : undefined;
    if (!grant || grant.expiresAt <= now()) throw stale();
    authorize(grant);
    if (grant.torrent || grant.torrentFile) throw new Error('Torrent playback currently requires the native VLC or mpv player.');
    if (grant.sourceKind !== 'hls' && grant.sourceKind !== 'verified-media') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      timeout.unref();
      let response: IncomingMessage | undefined;
      try {
        response = (await openSafeMediaStream(grant.url, { signal: controller.signal, headers: grant.requestHeaders })).response;
        if ([401, 403, 410].includes(response.statusCode || 0) && token) {
          revokeSource(token);
          throw stale();
        }
        if (response.statusCode !== 200) throw new Error('The addon media request failed.');
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response) {
          const bytes = Buffer.from(chunk);
          chunks.push(bytes); length += bytes.length;
          if (length >= 512) break;
        }
        const prefix = Buffer.concat(chunks);
        if (prefix.toString('utf8', 0, 256).replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) grant.sourceKind = 'hls';
        else if (mediaSignature(prefix)) grant.sourceKind = 'verified-media';
        else throw new Error('The addon did not return a supported media container.');
      } finally { clearTimeout(timeout); response?.destroy(); controller.abort(); }
    }
    return open(reference, 'browser');
  };

  const serve = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const match = /^\/addon-media\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{24})\.(?:media|m3u8|key)$/.exec(url.pathname);
    const session = match ? sessions.get(match[1]) : undefined;
    const resource = session && match ? session.resources.get(match[2]) : undefined;
    if (!session || !resource || !['GET', 'HEAD'].includes(req.method || '') || url.search) {
      res.writeHead(404); res.end(); return;
    }
    try { validateSession(session); } catch {
      dispose(session, true); res.writeHead(403); res.end('Addon playback access expired.'); return;
    }
    if (now() - session.windowStart >= 60_000) { session.windowStart = now(); session.starts = 0; }
    if (session.requests.size >= 12 || ++session.starts > 1200) {
      res.writeHead(429, { 'Retry-After': '1' }); res.end(); return;
    }
    const range = req.headers.range;
    if (range && (range.length > 100 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) {
      res.writeHead(416); res.end(); return;
    }
    session.idleUntil = now() + IDLE_TTL;
    const controller = new AbortController();
    session.requests.add(controller);
    const abort = () => controller.abort();
    res.once('close', abort);
    let upstream: IncomingMessage | undefined;
    try {
      // Probe an unknown top-level format from its start before honoring an
      // arbitrary seek range. HLS is always fetched in full and bounded.
      let requestedRange = resource.kind === 'auto' || resource.kind === 'playlist' || resource.kind === 'key' ? undefined : range;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const opened = session.grant.torrentFile ? await (engines.get(session.sourceToken)?.engine.open || openStremioTorrentMedia)(resource.url, {
          signal: controller.signal, method: req.method === 'HEAD' ? 'HEAD' : 'GET', range: requestedRange,
        }) : await openSafeMediaStream(resource.url, {
          signal: controller.signal, method: req.method === 'HEAD' ? 'HEAD' : 'GET', range: requestedRange,
          headers: new URL(resource.url).origin === new URL(session.grant.url).origin ? session.grant.requestHeaders : undefined,
        });
        upstream = opened.response;
        validateSession(session);
        const status = upstream.statusCode || 502;
        if ([401, 403, 410].includes(status)) {
          revokeSource(session.sourceToken);
          if (!res.destroyed && !res.writableEnded) { res.writeHead(410, { 'Cache-Control': 'no-store' }); res.end('Reload the addon source list.'); }
          return;
        }
        if (status !== 200 && status !== 206) {
          res.writeHead(status === 416 ? 416 : 502, { 'Cache-Control': 'no-store' });
          res.end('The addon media request failed.'); return;
        }
        const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
        const contentType = String(upstream.headers['content-type'] || 'application/octet-stream');
        headers['Content-Type'] = contentType;
        for (const name of ['content-length', 'content-range', 'accept-ranges'] as const) {
          const value = upstream.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        if (req.method === 'HEAD') { res.writeHead(status, headers); res.end(); return; }
        const iterator = upstream[Symbol.asyncIterator]();
        const prefix: Buffer[] = [];
        let prefixSize = 0;
        while (prefixSize < 512) {
          const next = await iterator.next();
          if (next.done) break;
          const bytes = Buffer.from(next.value);
          prefix.push(bytes); prefixSize += bytes.length;
        }
        const start = Buffer.concat(prefix);
        const hls = start.subarray(0, 256).toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
        if (resource.kind === 'playlist' || hls) {
          if (session.grant.torrentFile) throw new Error('The selected torrent file is not a supported video.');
          if (!hls || !['playlist', 'auto'].includes(resource.kind) || status !== 200) throw new Error('Unsupported playlist response.');
          resource.kind = 'playlist';
          const chunks = [start];
          let length = start.length;
          while (true) {
            if (length > MAX_PLAYLIST_BYTES) throw new Error('The addon playlist is too large.');
            const next = await iterator.next();
            if (next.done) break;
            const chunk = Buffer.from(next.value); length += chunk.length; chunks.push(chunk);
          }
          const rewritten = Buffer.from(rewriteAddonHlsPlaylist(Buffer.concat(chunks).toString('utf8'), opened.url,
            (childUrl, kind) => resourcePath(session, childUrl, kind)));
          validateSession(session);
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': rewritten.length, 'Cache-Control': 'no-store' });
          res.end(rewritten); return;
        }
        if (resource.kind === 'auto') {
          if (!mediaSignature(start)) throw new Error('The addon did not return a supported media container.');
          resource.kind = 'media';
          if (range) { upstream.destroy(); requestedRange = range; continue; }
        }
        if (/text\/html|(?:application|text)\/(?:.*\+)?(?:xml|json)|mpegurl/i.test(contentType)) throw new Error('Unsupported media response.');
        if (resource.kind === 'key') {
          const chunks = [start];
          let length = start.length;
          while (true) {
            if (length > 16) throw new Error('The HLS key is invalid.');
            const next = await iterator.next(); if (next.done) break;
            const chunk = Buffer.from(next.value); length += chunk.length; chunks.push(chunk);
          }
          if (length !== 16) throw new Error('The HLS key is invalid.');
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 16, 'Cache-Control': 'no-store' });
          res.end(Buffer.concat(chunks)); return;
        }
        validateSession(session);
        res.writeHead(status, headers);
        const activeSession = session;
        async function* bytes() {
          for (const chunk of prefix) {
            activeSession.bytes += chunk.length;
            if (activeSession.bytes > MAX_SESSION_BYTES) throw new Error('The addon session exceeded its transfer limit.');
            yield chunk;
          }
          while (true) {
            controller.signal.throwIfAborted();
            const next = await iterator.next(); if (next.done) return;
            const chunk = Buffer.from(next.value);
            activeSession.bytes += chunk.length;
            if (activeSession.bytes > MAX_SESSION_BYTES) throw new Error('The addon session exceeded its transfer limit.');
            activeSession.idleUntil = now() + IDLE_TTL;
            yield chunk;
          }
        }
        await pipeline(Readable.from(bytes(), { objectMode: false }), res, { signal: controller.signal });
        return;
      }
      throw new Error('The addon media format could not be resolved.');
    } catch {
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy();
        else { res.writeHead(502, { 'Cache-Control': 'no-store' }); res.end('The addon stream could not be loaded.'); }
      }
    } finally {
      upstream?.destroy();
      controller.abort();
      session.requests.delete(controller);
      res.removeListener('close', abort);
    }
  };

  return {
    issue, open, openBrowser, serve, revalidate,
    magnetLink(reference: string, required = true): string {
      const token = parseAddonPlaybackReference(reference);
      const grant = token ? grants.get(token) : undefined;
      if (!grant || grant.expiresAt <= now()) throw stale();
      authorize(grant);
      const hash = grant.torrent?.infoHash || grant.torrentFile?.infoHash;
      if (!hash) {
        if (required) throw new Error('This source is not a torrent.');
        return '';
      }
      return `magnet:?xt=urn:btih:${hash}`;
    },
    async exportSource(reference: string, title: string, download: boolean): Promise<{ lease: AddonPlaybackLease; filename: string }> {
      const token = parseAddonPlaybackReference(reference);
      const grant = token ? grants.get(token) : undefined;
      if (!grant || grant.expiresAt <= now()) throw stale();
      authorize(grant);
      if (grant.torrent) throw new Error('Choose a torrent file first.');
      const owned = token ? engines.get(token) : undefined;
      const exportReference = issue(grant, Boolean(owned));
      const exportToken = parseAddonPlaybackReference(exportReference);
      if (!exportToken) throw stale();
      if (owned) {
        const engine = owned.engine.retain();
        engines.set(exportToken, { engine, expiresAt: now() + 5 * 60_000 });
        engine.onFailure(() => revokeSource(exportToken));
      }
      let lease: AddonPlaybackLease;
      try { lease = download && !grant.torrentFile ? await openBrowser(exportReference) : open(exportReference); }
      catch (error) { revokeSource(exportToken); throw error; }
      if (download && lease.contentType === 'application/vnd.apple.mpegurl') {
        lease.release();
        throw new Error('This source is an HLS playlist. Choose a direct video or torrent to download.');
      }
      const basename = grant.fileName?.split(/[\\/]/).pop();
      const extension = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|mpg|mpeg|ogv)$/i.exec(new URL(grant.url).pathname)?.[0] || '.mp4';
      // Filenames may come from add-on metadata. Replace control characters
      // as well as platform-reserved punctuation before returning a download.
      // eslint-disable-next-line no-control-regex -- Control characters must be removed from provider filenames.
      const filename = (basename || `${title}${extension}`).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 200);
      return { lease, filename };
    },
    async prepareTorrent(reference: string, signal: AbortSignal): Promise<StremioTorrentPreparation> {
      revalidate();
      const token = parseAddonPlaybackReference(reference);
      const grant = token ? grants.get(token) : undefined;
      if (!token || !grant?.torrent || grant.expiresAt <= now()) throw stale();
      authorize(grant);
      if (preparing.size >= 4 || preparations.size >= 64) throw new Error('Too many torrent selections are open. Close one and try again.');
      preparing.get(token)?.abort();
      preparations.get(token)?.engine?.release();
      preparations.delete(token);
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(90_000)]);
      preparing.set(token, controller);
      if (!sweep) { sweep = setInterval(revalidate, 10_000); sweep.unref(); }
      let engine: ManagedTorrent | undefined;
      try {
        engine = await deps.prepareManagedTorrent?.(grant.torrent, grant.target, combined);
        const result = engine?.result || await prepareStremioTorrent(grant.torrent, grant.target, combined);
        combined.throwIfAborted(); authorize(grant);
        if (grants.get(token) !== grant) throw stale();
        preparations.set(token, { result, engine, expiresAt: now() + 5 * 60_000 });
        engine?.onFailure(() => { if (preparations.get(token)?.engine === engine) preparations.delete(token); });
        return result;
      } catch (error) { engine?.release(); throw error; } finally { if (preparing.get(token) === controller) preparing.delete(token); }
    },
    selectTorrent(reference: string, index: number): string {
      revalidate();
      const token = parseAddonPlaybackReference(reference);
      const grant = token ? grants.get(token) : undefined;
      const prepared = token ? preparations.get(token) : undefined;
      if (!token || !grant?.torrent || !prepared || grant.expiresAt <= now()) throw stale();
      authorize(grant);
      if (!prepared.result.files.some(file => file.index === index)) throw new Error('Choose a video from the torrent file list.');
      const torrentFile = { infoHash: grant.torrent.infoHash, index };
      const selected = issue({
        profileId: grant.profileId, selectionRevision: grant.selectionRevision, addonId: grant.addonId,
        revision: grant.revision, target: grant.target, torrentFile, sourceKind: 'stremio-torrent',
        fileName: prepared.result.files.find(file => file.index === index)?.name,
        url: prepared.engine?.mediaUrl(index) || stremioTorrentMediaUrl(torrentFile.infoHash, index),
      }, Boolean(prepared.engine));
      if (prepared.engine) {
        const selectedToken = parseAddonPlaybackReference(selected);
        if (!selectedToken) { prepared.engine.release(); throw stale(); }
        const engine = shareTorrent(prepared.engine);
        engines.set(selectedToken, { engine, expiresAt: now() + 5 * 60_000 });
        engine.onFailure(() => revokeSource(selectedToken));
      }
      preparations.delete(token);
      return selected;
    },
    validate(reference: string): boolean {
      const token = parseAddonPlaybackReference(reference);
      const grant = token ? grants.get(token) : undefined;
      if (!grant || grant.expiresAt <= now()) return false;
      try { authorize(grant); return true; } catch { return false; }
    },
    close(reference: string): void {
      const token = parseAddonPlaybackReference(reference);
      if (!token) return;
      preparing.get(token)?.abort();
      preparations.get(token)?.engine?.release();
      preparations.delete(token);
      for (const session of sessions.values()) if (session.sourceToken === token) dispose(session, true, false);
      if (engines.has(token)) {
        engines.get(token)?.engine.release(); engines.delete(token); grants.delete(token);
      }
    },
    dispose(): void {
      for (const controller of preparing.values()) controller.abort();
      for (const preparation of preparations.values()) preparation.engine?.release();
      for (const owned of engines.values()) owned.engine.release();
      engines.clear();
      preparations.clear();
      for (const session of sessions.values()) dispose(session, true);
      grants.clear();
      if (sweep) { clearInterval(sweep); sweep = undefined; }
    },
  };
}
