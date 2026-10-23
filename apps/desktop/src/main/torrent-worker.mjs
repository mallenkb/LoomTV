import http from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// Loaded only in an Electron utility process after an explicit source selection.
const parent = process.parentPort;
const CACHE_LIMIT = 16 * 1024 ** 3;
let started = false;
let client;
let server;
let failed = false;
let lastParentMessage = Date.now();
let directory;
const sockets = new Set();
const fail = () => {
  if (failed) return;
  failed = true;
  try { parent.postMessage({ type: 'error' }); } catch { /* The parent may have exited. */ }
  for (const socket of sockets) socket.destroy();
  server?.close();
  client?.destroy(() => {
    if (directory) void rm(directory, { recursive: true, force: true }).finally(() => process.exit(1));
    else process.exit(1);
  });
  setTimeout(() => process.exit(1), 1000).unref();
};

// Piece indexes are the only disk filenames. Provider paths never reach the filesystem.
class BoundedPieceStore {
  constructor(length, options) {
    if (!Number.isSafeInteger(length) || length < 1 || length > 16 * 1024 ** 2) throw new Error('Unsupported torrent piece size.');
    if (!Number.isSafeInteger(options.length) || options.length <= 0 || Math.ceil(options.length / length) > 1_000_000) throw new Error('Torrent metadata exceeds the supported size.');
    this.chunkLength = length;
    this.root = options.cacheRoot;
    this.length = options.length;
    this.sizes = new Map();
    this.bytes = 0;
    this.closed = false;
  }
  filename(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(this.length / this.chunkLength)) throw new Error('Invalid piece index.');
    return path.join(this.root, String(index));
  }
  put(index, bytes, callback) {
    try {
      const name = this.filename(index);
      if (this.closed || bytes.length > this.chunkLength) throw new Error('Invalid piece.');
      const additional = bytes.length - (this.sizes.get(index) || 0);
      if (this.bytes + additional > CACHE_LIMIT) { fail(); throw new Error('Torrent cache limit reached.'); }
      this.bytes += additional;
      this.sizes.set(index, bytes.length);
      void writeFile(name, bytes, { mode: 0o600 }).then(() => callback(null), error => { callback(error); fail(); });
    } catch (error) { queueMicrotask(() => callback(error)); }
  }
  get(index, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    try {
      if (this.closed) throw new Error('Torrent cache closed.');
      if (!this.sizes.has(index)) throw new Error('Piece not cached.');
      void readFile(this.filename(index)).then(bytes => {
        const offset = options?.offset || 0;
        callback(null, bytes.subarray(offset, options?.length === undefined ? undefined : offset + options.length));
      }, callback);
    } catch (error) { queueMicrotask(() => callback(error)); }
  }
  close(callback) { this.closed = true; queueMicrotask(() => callback?.(null)); }
  destroy(callback) { this.closed = true; void rm(this.root, { recursive: true, force: true }).then(() => callback?.(null), callback); }
}

setInterval(() => { if (Date.now() - lastParentMessage > 35_000) fail(); }, 10_000).unref();
process.once('SIGTERM', fail);
parent.on('message', ({ data }) => {
  lastParentMessage = Date.now();
  if (started || data?.type !== 'start') return;
  started = true;
  void (async () => {
  try {
    const { infoHash, trackers, token, cachePath } = data;
    directory = cachePath;
    if (!/^[a-f0-9]{40}$/.test(infoHash) || !/^[a-f0-9]{64}$/.test(token) || !Array.isArray(trackers) || trackers.length > 16) throw new Error('Invalid engine request.');
    const { default: WebTorrent } = await import('webtorrent');
    client = new WebTorrent({ maxConns: 40, lsd: false, natUpnp: false, natPmp: false, webSeeds: false, utp: false,
      uploadLimit: 1024 * 1024, seedOutgoingConnections: false,
      blocklist: [
        { start: '0.0.0.0', end: '0.255.255.255' }, { start: '10.0.0.0', end: '10.255.255.255' },
        { start: '100.64.0.0', end: '100.127.255.255' }, { start: '127.0.0.0', end: '127.255.255.255' },
        { start: '169.254.0.0', end: '169.254.255.255' }, { start: '172.16.0.0', end: '172.31.255.255' },
        { start: '192.168.0.0', end: '192.168.255.255' }, { start: '224.0.0.0', end: '255.255.255.255' },
      ],
    });
    client.on('error', fail);
    const torrent = client.add({ infoHash, announce: trackers, urlList: [] }, {
      deselect: true, store: BoundedPieceStore, storeOpts: { cacheRoot: cachePath }, storeCacheSlots: 0,
      destroyStoreOnDestroy: true, strategy: 'sequential',
    });
    torrent.on('error', fail);
    torrent.once('ready', () => {
      if (torrent.infoHash !== infoHash || torrent.files.length > 10000 || torrent.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.path), 0) > 1024 * 1024) { fail(); return; }
      let active = 0;
      server = http.createServer((req, res) => {
        void (async () => {
        const match = new RegExp(`^/${token}/(\\d{1,5})$`).exec(req.url || '');
        const file = match && torrent.files[Number(match[1])];
        if (!file || !['GET', 'HEAD'].includes(req.method) || file.length < 1 || !Number.isSafeInteger(file.length)) {
          res.writeHead(404); res.end(); return;
        }
        if (active >= 12) { res.writeHead(429); res.end(); return; }
        let start = 0;
        let end = file.length - 1;
        if (req.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!range || (!range[1] && !range[2])) { res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }); res.end(); return; }
          if (!range[1]) start = Math.max(0, file.length - Number(range[2]));
          else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0) {
            res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }); res.end(); return;
          }
        }
        res.writeHead(req.headers.range ? 206 : 200, {
          'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
          'Cache-Control': 'no-store', ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}),
        });
        if (req.method === 'HEAD') { res.end(); return; }
        active++;
        const stream = file.createReadStream({ start, end });
        const close = () => stream.destroy();
        res.once('close', close);
        res.setTimeout(60_000, () => res.destroy());
        try { await pipeline(stream, res); } catch { res.destroy(); }
        finally { active--; res.removeListener('close', close); stream.destroy(); }
        })().catch(() => res.destroy());
      });
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      server.on('error', fail);
      server.listen(0, '127.0.0.1', () => parent.postMessage({ type: 'ready', infoHash, port: server.address().port,
        files: torrent.files.map(file => ({ name: file.path, length: file.length })),
      }));
    });
  } catch { fail(); }
  })();
});
