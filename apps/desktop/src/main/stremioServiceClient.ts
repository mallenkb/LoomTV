import http, { type IncomingMessage } from 'node:http';
import type { StremioServiceStatus, StremioTorrentPreparation } from '../shared/stremioService.ts';
import { resolveSafeProviderAddress } from './safeFetch.ts';

export type StremioTorrentSource = { infoHash: string; fileIdx?: number; sources: readonly string[] };
export type StremioPlaybackTarget = { type: string; videoId: string };
const ORIGIN = 'http://127.0.0.1:11470';
const HASH = /^[a-f0-9]{40}$/;
const VIDEO = /\.(?:mkv|mp4|m4v|avi|mov|webm|ts|m2ts|mpg|mpeg|ogv)$/i;
// Stremio supplies default trackers when an add-on only supplies an info hash.
// Keep the fallback bounded and subject to the same destination checks below.
const DEFAULT_TRACKERS = [
  'tracker:udp://tracker.opentrackr.org:1337/announce',
  'tracker:udp://open.stealth.si:80/announce',
  'tracker:udp://tracker.torrent.eu.org:451/announce',
  'tracker:udp://open.demonii.com:1337/announce',
];

export function validateTorrentSource(source: StremioTorrentSource): void {
  if (!HASH.test(source.infoHash) || source.sources.length > 16
    || (source.fileIdx !== undefined && (!Number.isInteger(source.fileIdx) || source.fileIdx < 0 || source.fileIdx > 65535))) {
    throw new Error('The torrent reference is invalid.');
  }
}

/** Fixed loopback origin, no redirects, no provider headers and no arbitrary paths. */
async function request(path: string, options: {
  signal: AbortSignal; method?: 'GET' | 'HEAD' | 'POST'; body?: string; range?: string; timeout?: number;
}): Promise<IncomingMessage> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 11470, path, method: options.method || 'GET',
      signal: options.signal, agent: false,
      headers: {
        Accept: '*/*', 'Accept-Encoding': 'identity',
        ...(options.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(options.body) } : {}),
        ...(options.range ? { Range: options.range } : {}),
      },
    }, response => {
      clearTimeout(deadline);
      response.on('error', () => { /* Consumed by the relay or bounded JSON reader. */ });
      response.setTimeout(60_000, () => response.destroy(new Error('Stremio Service stopped sending data.')));
      if ((response.statusCode || 0) >= 300 && (response.statusCode || 0) < 400
        || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); reject(new Error('Stremio Service returned an unsupported response.')); return;
      }
      resolve(response);
    });
    const deadline = setTimeout(() => req.destroy(new Error('Stremio Service timed out. Check peer availability and try another source.')), options.timeout || 60_000);
    deadline.unref();
    req.on('error', error => {
      clearTimeout(deadline);
      reject(options.signal.aborted ? new Error('Torrent loading was cancelled.')
        : 'code' in error && error.code === 'ECONNREFUSED'
          ? new Error('Start Stremio Service or Stremio Desktop on this computer, then try again.')
          : new Error('Stremio Service could not load this source. Check the service and peer availability.'));
    });
    req.end(options.body);
  });
}

async function json(path: string, signal: AbortSignal, body?: object, timeout = 60_000): Promise<Record<string, unknown>> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  const response = await request(path, { signal: combined, body: body && JSON.stringify(body), method: body ? 'POST' : 'GET', timeout });
  try {
    if (response.statusCode !== 200) throw new Error('Stremio Service rejected this request. Try another source or update the service.');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response) {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) throw new Error('Stremio Service returned too much metadata.');
      chunks.push(Buffer.from(chunk));
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Stremio Service returned invalid metadata.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Stremio Service returned invalid metadata.');
    return value as Record<string, unknown>;
  } finally { response.destroy(); }
}

export async function stremioServiceStatus(signal = AbortSignal.timeout(4000)): Promise<StremioServiceStatus> {
  try {
    const result = await json('/settings', signal, undefined, 4000);
    const values = result.values as Record<string, unknown> | undefined;
    const version = values?.serverVersion;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(version) || version.length > 64) {
      throw new Error('The local service does not expose the expected Stremio API.');
    }
    return { available: true, version, message: `Stremio Service ${version} is available.` };
  } catch (error) {
    return { available: false, message: error instanceof Error ? error.message : 'Stremio Service is unavailable.' };
  }
}

/** Uses Stremio's create API. No file URL, local path or arbitrary engine options are accepted. */
export async function prepareStremioTorrent(source: StremioTorrentSource, target: StremioPlaybackTarget | undefined, signal: AbortSignal, knownStatus?: StremioServiceStatus): Promise<StremioTorrentPreparation> {
  validateTorrentSource(source);
  const status = knownStatus ?? await stremioServiceStatus(signal);
  signal.throwIfAborted();
  if (!status.available || !status.version) throw new Error(status.message);
  const sources = await torrentDiscoverySources(source, signal);
  const result = await json(`/${source.infoHash}/create`, signal, { peerSearch: { min: 40, max: 200, sources } });
  return torrentPreparation(result, source, target, status.version);
}

export async function torrentDiscoverySources(source: StremioTorrentSource, signal: AbortSignal): Promise<string[]> {
  const sources = [`dht:${source.infoHash}`];
  const candidates = source.sources.some(value => value.startsWith('tracker:'))
    ? source.sources : [...source.sources, ...DEFAULT_TRACKERS];
  const accepted: (string | undefined)[] = new Array(candidates.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (next < candidates.length) {
      signal.throwIfAborted();
      const index = next++;
      const value = candidates[index];
      if (value === sources[0]) continue;
      if (!/^tracker:(?:https?|udp):\/\//i.test(value) || value.length > 2048) throw new Error('The torrent tracker is invalid.');
      const tracker = new URL(value.slice(8));
      const addressCheck = new URL(tracker.href.replace(/^(?:http|udp):/i, 'https:'));
      // Validate initial tracker destinations. The engine owns subsequent discovery.
      let abort: () => void = () => { /* Assigned before registering the listener. */ };
      try {
        await Promise.race([
          resolveSafeProviderAddress(addressCheck),
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error('Torrent loading was cancelled.'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } catch (error) {
        // One offline tracker must not prevent DHT or the other trackers from
        // discovering peers. An aborted selection must still stop immediately.
        if (signal.aborted) throw error;
        continue;
      } finally { signal.removeEventListener('abort', abort); }
      signal.throwIfAborted();
      accepted[index] = value;
    }
  }));
  return [...sources, ...accepted.filter((value): value is string => value !== undefined)];
}

/** Shared file selection rules for the managed engine and the optional service adapter. */
export function torrentPreparation(result: Record<string, unknown>, source: StremioTorrentSource, target: StremioPlaybackTarget | undefined, version: string): StremioTorrentPreparation {
  if (result.infoHash !== source.infoHash || !Array.isArray(result.files) || result.files.length > 10000) {
    throw new Error('The torrent engine returned an invalid torrent file list.');
  }
  // Keep original indexes even when filtering. Playback uses torrent order.
  const files = result.files.flatMap((raw: unknown, index: number) => {
    if (!raw || typeof raw !== 'object') throw new Error('The torrent engine returned an invalid file.');
    const file = raw as Record<string, unknown>;
    if (typeof file.name !== 'string' || file.name.length > 2048 || [...file.name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || typeof file.length !== 'number' || !Number.isSafeInteger(file.length) || file.length <= 0) return [];
    if (!VIDEO.test(file.name)) return [];
    return [{ index, name: file.name, size: file.length }];
  });
  if (!files.length) throw new Error('This torrent has no supported video files.');
  const explicit = files.find(file => file.index === source.fileIdx);
  const candidates = files.filter(file => !/(?:^|[\s._/\\-])(?:sample|trailer)(?:[\s._/\\-]|$)/i.test(file.name));
  let suggestedIndex = explicit?.index;
  let selectionReason: StremioTorrentPreparation['selectionReason'] = explicit ? 'provider' : 'choose';
  let notice = 'Choose the video that matches the requested title. Filenames cannot confirm its contents.';
  // Infer only the well-defined IMDb season/episode ID, never anime absolute IDs.
  const requested = target && /^tt\d+:([0-9]+):([0-9]+)$/.exec(target.videoId);
  const selectedEpisode = explicit && /\bS(\d{1,3})E(\d{1,4})\b/i.exec(explicit.name.replace(/[._]/g, ' '));
  const conflict = requested && selectedEpisode
    && (Number(requested[1]) !== Number(selectedEpisode[1]) || Number(requested[2]) !== Number(selectedEpisode[2]));
  if (conflict) {
    suggestedIndex = undefined; selectionReason = 'choose';
    notice = 'The provider-selected filename appears to name a different episode. Choose the correct file before playing.';
  } else if (source.fileIdx !== undefined && !explicit) {
    notice = 'The provider file index does not identify a supported video. Choose the correct file.';
  } else if (explicit) {
    notice = 'The add-on selected this file. Check its name before playing; the name does not verify its contents.';
  } else if (candidates.length === 1 && target?.type === 'movie') {
    suggestedIndex = candidates[0].index; selectionReason = 'single-file';
    notice = 'One main video was found. Check its name before playing.';
  }
  return { files, suggestedIndex, selectionReason, notice, serviceVersion: version };
}

export function stremioTorrentMediaUrl(infoHash: string, index: number): string {
  if (!HASH.test(infoHash) || !Number.isInteger(index) || index < 0 || index > 65535) throw new Error('Invalid selected torrent file.');
  return `${ORIGIN}/${infoHash}/${index}`;
}

export async function openStremioTorrentMedia(url: string, options: { signal: AbortSignal; method?: 'GET' | 'HEAD'; range?: string }) {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN || parsed.username || parsed.password || parsed.search || parsed.hash
    || !/^\/[a-f0-9]{40}\/\d{1,5}$/.test(parsed.pathname)) throw new Error('Invalid Stremio media request.');
  const response = await request(parsed.pathname, options);
  return { url, response };
}
