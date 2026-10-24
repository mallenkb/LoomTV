import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import http, { type RequestListener } from 'node:http';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import { stremioServiceStatus, prepareStremioTorrent, openStremioTorrentMedia } from '../src/main/stremioServiceClient.ts';
import { createStremioPlayback } from '../src/main/stremioPlayback.ts';

const HASH = 'a'.repeat(40);
const source = { infoHash: HASH, sources: [] };
const movie = { type: 'movie', videoId: 'tt1234567' };
const fixtureBytes = Buffer.alloc(4096, 0x31);
fixtureBytes.write('ftyp', 4, 'ascii');
const originalRequest = http.request.bind(http);

async function listen(t: TestContext, handler: RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { server, port: (server.address() as { port: number }).port };
}

/** Redirect only the adapter's fixed endpoint to a private test listener.
 * Never bind or contact the actual Stremio port, even if a real service exists.
 */
async function service(t: TestContext, handler: RequestListener) {
  const local = await listen(t, handler);
  t.mock.method(http, 'request', ((options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
    assert.equal(options.hostname, '127.0.0.1');
    assert.equal(options.port, 11470);
    assert.equal(options.agent, false);
    return originalRequest({ ...options, port: local.port }, callback);
  }) as typeof http.request);
  return local;
}

function json(res: http.ServerResponse, value: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

test('service detection, original file order and episode conflicts use the Stremio API', async t => {
  t.mock.method(dns, 'lookup', (async () => [{ address: '93.184.216.34', family: 4 }]) as typeof dns.lookup);
  const creates: unknown[] = [];
  await service(t, (req, res) => {
    if (req.url === '/settings') return json(res, { values: { serverVersion: '4.20.8' } });
    assert.equal(req.url, `/${HASH}/create`);
    assert.equal(req.method, 'POST');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      creates.push(JSON.parse(body));
      json(res, { infoHash: HASH, files: [
        { name: 'readme.txt', length: 20 },
        { name: 'Show.S01E02.mkv', length: 2000 },
        { name: 'Show.S01E01.mkv', length: 1000 },
      ] });
    });
  });
  assert.deepEqual(await stremioServiceStatus(), {
    available: true, version: '4.20.8', message: 'Stremio Service 4.20.8 is available.',
  });
  const result = await prepareStremioTorrent({ ...source, fileIdx: 1 }, { type: 'series', videoId: 'tt1234567:1:1' }, AbortSignal.timeout(2000));
  assert.deepEqual(result.files.map(file => file.index), [1, 2]);
  assert.equal(result.suggestedIndex, undefined);
  assert.match(result.notice, /different episode/);
  const explicit = await prepareStremioTorrent({ ...source, fileIdx: 2 }, { type: 'series', videoId: 'tt1234567:1:1' }, AbortSignal.timeout(2000));
  assert.equal(explicit.suggestedIndex, 2);
  assert.equal(explicit.selectionReason, 'provider');
  const ambiguous = await prepareStremioTorrent(source, { type: 'anime', videoId: 'kitsu:123:12' }, AbortSignal.timeout(2000));
  assert.equal(ambiguous.suggestedIndex, undefined);
  assert.deepEqual(creates[0], { peerSearch: { min: 40, max: 200, sources: [
    `dht:${HASH}`,
    'tracker:udp://tracker.opentrackr.org:1337/announce',
    'tracker:udp://open.stealth.si:80/announce',
    'tracker:udp://tracker.torrent.eu.org:451/announce',
    'tracker:udp://open.demonii.com:1337/announce',
  ] } });
});

test('a complete host session relays selected bytes and seeking, then revokes access', async t => {
  const requests: string[] = [];
  await service(t, (req, res) => {
    requests.push(req.url || '');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    if (req.url === '/settings') return json(res, { values: { serverVersion: '4.20.8' } });
    if (req.url === `/${HASH}/create`) return json(res, { infoHash: HASH, files: [
      { name: 'sample.mkv', length: 32 }, { name: 'Movie.mp4', length: fixtureBytes.length },
    ] });
    assert.equal(req.url, `/${HASH}/1`);
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : fixtureBytes.length - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${fixtureBytes.length}` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : fixtureBytes.subarray(start, end + 1));
  });
  let profileRevision = 1;
  let playback: ReturnType<typeof createStremioPlayback>;
  const relay = await listen(t, (req, res) => {
    void playback.serve(req, res, new URL(req.url || '/', 'http://127.0.0.1')).catch(error => res.destroy(error));
  });
  playback = createStremioPlayback({
    identity: () => ({ profileId: 'owner', selectionRevision: profileRevision }), revision: () => 'r1', port: () => relay.port,
  });
  t.after(() => playback.dispose());
  const reference = playback.issue({ profileId: 'owner', selectionRevision: 1, addonId: 'fixture', revision: 'r1',
    url: `torrent:${HASH}`, sourceKind: 'torrent', torrent: source, target: movie });
  const files = await playback.prepareTorrent(reference, AbortSignal.timeout(10_000));
  assert.equal(files.suggestedIndex, 1);
  assert.throws(() => playback.selectTorrent(reference, 20), /Choose a video/);
  const selected = playback.selectTorrent(reference, 1);
  assert.ok(!selected.includes(HASH));
  const lease = playback.open(selected);
  assert.ok(!lease.url.includes(HASH));
  await assert.rejects(playback.openBrowser(selected), /native/);
  for (const [start, end] of [[1024, 1279], [0, 511], [3072, 4095]]) {
    const result = await fetch(lease.url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(2000) });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get('content-range'), `bytes ${start}-${end}/${fixtureBytes.length}`);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), fixtureBytes.subarray(start, end + 1));
  }
  const head = await fetch(lease.url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
  assert.equal(Number(head.headers.get('content-length')), fixtureBytes.length);
  const malformedRange = await fetch(lease.url, { headers: { Range: 'bytes=0-1,2-3' }, signal: AbortSignal.timeout(2000) });
  assert.equal(malformedRange.status, 416);
  let revoked = false;
  lease.onRevoke(() => { revoked = true; });
  profileRevision += 1;
  playback.revalidate();
  assert.equal(revoked, true);
  assert.equal((await fetch(lease.url, { signal: AbortSignal.timeout(2000) })).status, 404);
  assert.equal(requests.some(path => /remove|settings\?/.test(path)), false);
});

test('profile revocation cancels pending metadata without removing shared torrents', async t => {
  let createStarted!: () => void;
  const created = new Promise<void>(resolve => { createStarted = resolve; });
  const paths: string[] = [];
  await service(t, (req, res) => {
    paths.push(req.url || '');
    if (req.url === '/settings') return json(res, { values: { serverVersion: '4.20.8' } });
    if (req.url === `/${HASH}/create`) { createStarted(); return; }
    res.writeHead(404); res.end();
  });
  let revision = 1;
  const playback = createStremioPlayback({ identity: () => ({ profileId: 'owner', selectionRevision: revision }), revision: () => 'r1', port: () => 9999 });
  t.after(() => playback.dispose());
  const reference = playback.issue({ profileId: 'owner', selectionRevision: 1, addonId: 'fixture', revision: 'r1',
    url: `torrent:${HASH}`, sourceKind: 'torrent', torrent: source, target: movie });
  const pending = playback.prepareTorrent(reference, AbortSignal.timeout(2000));
  const rejected = assert.rejects(pending, /cancel|abort|access/i);
  await created;
  revision += 1; playback.revalidate();
  await rejected;
  assert.equal(playback.validate(reference), false);
  assert.equal(paths.some(path => path.includes('remove')), false);
});

test('service metadata bounds, wrong hashes and redirects fail closed', async t => {
  let mode = 'invalid';
  const requests: string[] = [];
  await service(t, (req, res) => {
    requests.push(req.url || '');
    if (req.url === '/settings') {
      if (mode === 'invalid') return json(res, { values: { serverVersion: '<script>' } });
      return json(res, { values: { serverVersion: '4.20.8' } });
    }
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1/admin' }); res.end(); return; }
    if (mode === 'oversize') return json(res, { data: 'x'.repeat(2 * 1024 * 1024) });
    json(res, { infoHash: 'b'.repeat(40), files: [{ name: 'Movie.mp4', length: 12 }] });
  });
  assert.equal((await stremioServiceStatus()).available, false);
  mode = 'wrong-hash';
  await assert.rejects(prepareStremioTorrent(source, movie, AbortSignal.timeout(2000)), /invalid torrent file list/);
  mode = 'oversize';
  await assert.rejects(prepareStremioTorrent(source, movie, AbortSignal.timeout(2000)), /too much metadata/);
  mode = 'redirect';
  await assert.rejects(openStremioTorrentMedia(`http://127.0.0.1:11470/${HASH}/0`, { signal: AbortSignal.timeout(2000) }), /unsupported response/);
  const before = requests.length;
  for (const url of ['http://127.0.0.1:11470/settings', `http://example.com/${HASH}/0`, `http://127.0.0.1:11470/${HASH}/0?external=1`]) {
    await assert.rejects(openStremioTorrentMedia(url, { signal: AbortSignal.timeout(2000) }), /Invalid Stremio/);
  }
  assert.equal(requests.length, before);
});
