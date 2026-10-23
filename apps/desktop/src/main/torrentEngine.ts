import { app, utilityProcess } from 'electron';
import http, { type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { torrentPreparation, torrentDiscoverySources, validateTorrentSource, stremioServiceStatus, prepareStremioTorrent, stremioTorrentMediaUrl, openStremioTorrentMedia, type StremioTorrentSource, type StremioPlaybackTarget } from './stremioServiceClient.ts';
import type { StremioTorrentPreparation } from '../shared/stremioService.ts';

export type ManagedTorrent = {
  result: StremioTorrentPreparation;
  mediaUrl: (index: number) => string;
  open: (url: string, options: { signal: AbortSignal; method?: 'GET' | 'HEAD'; range?: string }) => Promise<{ url: string; response: IncomingMessage }>;
  release: () => void;
  onFailure: (callback: () => void) => void;
};

/** One isolated engine per selection. The renderer never receives its port or token. */
export function createTorrentEngine() {
  const active = new Set<() => void>();
  let pending = 0;
  // Each source gets a private directory. Only abandoned day-old caches are swept.
  const root = path.join(app.getPath('temp'), 'loomtv-torrent-cache');
  let shutdown = new AbortController();
  return {
    status: async () => {
      const service = await stremioServiceStatus(AbortSignal.timeout(1500));
      if (service.available) return { ...service, message: 'The local Stremio service is available. Videos play in LoomTV.' };
      try {
        await access(path.join(__dirname, 'torrent-worker.mjs'));
        createRequire(__filename).resolve('webtorrent');
        return { available: true, version: '3.0.21', message: 'The built-in torrent engine is installed. A native player is required.' };
      } catch { return { available: false, message: 'The torrent engine is missing from this build. Rebuild or update LoomTV.' }; }
    },
    async prepare(source: StremioTorrentSource, target: StremioPlaybackTarget | undefined, signal: AbortSignal): Promise<ManagedTorrent> {
      signal = AbortSignal.any([signal, shutdown.signal]);
      signal.throwIfAborted();
      validateTorrentSource(source);
      if (active.size + pending >= 4) throw new Error('Close another torrent source before opening this one.');
      pending++;
      let directory: string | undefined;
      let stop: (() => void) | undefined;
      try {
        // Reuse the local Stremio streaming service when it is already running.
        // Its established swarm can serve a source that a fresh worker cannot
        // discover. Playback still uses Loom's grants, relay and native player.
        // The built-in engine remains available without a Stremio installation.
        const service = await stremioServiceStatus(AbortSignal.any([signal, AbortSignal.timeout(1500)]));
        signal.throwIfAborted();
        if (service.available) {
          try {
            const result = await prepareStremioTorrent(source, target, signal, service);
            signal.throwIfAborted();
            const lifetime = new AbortController();
            let released = false;
            const release = () => {
              if (released) return;
              released = true;
              lifetime.abort();
              active.delete(release);
              // This service is shared with Stremio. Close only our requests,
              // never remove its torrents or stop its process.
            };
            active.add(release);
            return {
              result,
              release,
              mediaUrl: index => {
                if (released || !result.files.some(file => file.index === index)) throw new Error('This torrent selection expired.');
                return stremioTorrentMediaUrl(source.infoHash, index);
              },
              open: (url, options) => {
                if (released || !result.files.some(file => stremioTorrentMediaUrl(source.infoHash, file.index) === url)) throw new Error('Invalid torrent media request.');
                return openStremioTorrentMedia(url, { ...options, signal: AbortSignal.any([options.signal, lifetime.signal]) });
              },
              onFailure: () => { /* Shared-service failures propagate through the relay request. */ },
            };
          } catch (error) {
            if (signal.aborted) throw error;
            // A stopped or incompatible service must not disable the built-in engine.
          }
        }
        const trackers = (await torrentDiscoverySources(source, signal)).filter(value => value.startsWith('tracker:')).map(value => value.slice(8));
        await mkdir(root, { recursive: true, mode: 0o700 });
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^source-[a-zA-Z0-9]+$/.test(entry.name)) continue;
          const candidate = path.join(root, entry.name);
          const metadata = await stat(candidate).catch(() => null);
          if (metadata && Date.now() - metadata.mtimeMs > 24 * 60 * 60_000) await rm(candidate, { recursive: true, force: true }).catch(() => { /* Retry at the next preparation. */ });
        }
        directory = await mkdtemp(path.join(root, 'source-'));
        signal.throwIfAborted();
        const cachePath = directory;
        const token = randomBytes(32).toString('hex');
        const child = utilityProcess.fork(path.join(__dirname, 'torrent-worker.mjs'), [], { stdio: 'ignore', serviceName: 'LoomTV torrent engine' });
        let released = false;
        let ready = false;
        let origin = '';
        let failure: (() => void) | undefined;
        const requests = new Set<IncomingMessage>();
        const release = () => {
          if (released) return;
          released = true;
          active.delete(release);
          signal.removeEventListener('abort', abort);
          clearTimeout(deadline);
          clearInterval(heartbeat);
          for (const response of requests) response.destroy();
          child.kill();
        };
        let rejectPreparation: (error: Error) => void = () => { /* Set before any asynchronous child event. */ };
        const abort = () => { release(); rejectPreparation(new Error('Torrent loading was cancelled.')); };
        const deadline = setTimeout(() => { release(); rejectPreparation(new Error('No torrent metadata arrived. Try a source with more peers.')); }, 85_000);
        deadline.unref();
        stop = release;
        const heartbeat = setInterval(() => { if (!released) child.postMessage({ type: 'heartbeat' }); }, 10_000);
        heartbeat.unref();
        active.add(release);
        signal.addEventListener('abort', abort, { once: true });
        child.once('spawn', () => { if (released) child.kill(); });
        child.once('exit', () => {
          const unexpected = !released;
          release();
          void rm(cachePath, { recursive: true, force: true, maxRetries: 3 }).catch(() => { /* Abandoned caches are swept during a later preparation. */ });
          rejectPreparation(new Error('The torrent engine stopped. Choose the source again.'));
          if (unexpected && ready) failure?.();
        });
        return await new Promise<ManagedTorrent>((resolve, reject) => {
          rejectPreparation = reject;
          child.on('message', (message: { type?: string; port?: number; files?: unknown; infoHash?: string }) => {
            if (released) return;
            if (message.type === 'error') {
              release(); reject(new Error('The torrent engine could not load this source or its cache is full. Try another source.'));
              if (ready) failure?.();
              return;
            }
            if (message.type !== 'ready' || ready) return;
            try {
              if (typeof message.port !== 'number' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) throw new Error('Invalid torrent engine port.');
              const result = torrentPreparation({ infoHash: message.infoHash, files: message.files }, source, target, '3.0.21');
              origin = `http://127.0.0.1:${message.port}`;
              ready = true;
              clearTimeout(deadline);
              signal.removeEventListener('abort', abort);
              const mediaUrl = (index: number) => {
                if (released || !result.files.some(file => file.index === index)) throw new Error('This torrent selection expired.');
                return `${origin}/${token}/${index}`;
              };
              resolve({ result, mediaUrl, release, onFailure: callback => { failure = callback; if (released) callback(); },
                open: async (url, options) => {
                  const parsed = new URL(url);
                  const index = Number(parsed.pathname.split('/')[2]);
                  if (url !== mediaUrl(index)) throw new Error('Invalid torrent media request.');
                  options.signal.throwIfAborted();
                  return new Promise((resolveOpen, rejectOpen) => {
                    const request = http.request(url, { method: options.method || 'GET', signal: options.signal, agent: false,
                      headers: options.range ? { Range: options.range } : {},
                    }, response => {
                      requests.add(response);
                      response.once('close', () => requests.delete(response));
                      response.on('error', () => { /* The relay consumes stream errors. */ });
                      resolveOpen({ url, response });
                    });
                    request.setTimeout(60_000, () => request.destroy(new Error('Torrent peers stopped sending data.')));
                    request.once('error', () => rejectOpen(new Error('The torrent stream stopped. Try another source.')));
                    request.end();
                  });
                },
              });
            } catch (error) { release(); reject(error); }
          });
          if (signal.aborted) { abort(); return; }
          child.postMessage({ type: 'start', infoHash: source.infoHash, trackers, cachePath, token });
        });
      } catch (error) {
        stop?.();
        if (directory) void rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => { /* Abandoned caches are swept during a later preparation. */ });
        throw error;
      } finally { pending--; }
    },
    dispose() { shutdown.abort(); shutdown = new AbortController(); for (const release of [...active]) release(); },
  };
}
