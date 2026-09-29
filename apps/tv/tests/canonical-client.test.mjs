import assert from 'node:assert/strict';
import test from 'node:test';
import { CanonicalTvClient, isTvAuthorizationFailure } from '../src/canonical-client.ts';

test('catalog merges canonical series once and derives availability from episodes', async (context) => {
  const episode = { id: 'episode-1', kind: 'episode', title: 'Pilot', available: false };
  const series = { id: 'series-1', kind: 'series', title: 'Show', available: true };
  context.mock.method(globalThis, 'fetch', async (url) => Response.json({ ok: true, data:
    url.endsWith('/series') ? { series: [{ ...series, seasons: [{ episodes: [episode] }] }] }
      : { items: [series, episode, { id: 'movie-1', kind: 'movie', title: 'Movie', available: true }] },
  }));
  const result = await new CanonicalTvClient('https://loomtv.local').library();
  assert.equal(result.items.length, 2);
  const shows = result.items.filter((item) => item.id === series.id);
  assert.equal(shows.length, 1);
  assert.equal(shows[0].available, false);
  assert.deepEqual(shows[0].episodes, [episode]);
});

test('TV progress writes canonical fields and only explicitly supplied watched state', async (context) => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return Response.json({ ok: true, data: {} });
  });
  const client = new CanonicalTvClient('https://loomtv.local');
  await client.selectProfile('profile-1');
  for (const watched of [undefined, true, false]) {
    await client.saveProgress('movie/1', 61.5, 120, watched);
    const request = requests.at(-1);
    assert.equal(request.url, 'https://loomtv.local/api/v1/profiles/profile-1/progress/movie%2F1');
    assert.equal(request.init.method, 'PUT');
    assert.deepEqual(JSON.parse(request.init.body), { position: 61.5, duration: 120, ...(watched !== undefined ? { watched } : {}) });
  }
});

test('TV client rejects cleartext server addresses', () => {
  assert.throws(() => new CanonicalTvClient('http://192.168.1.8:3848'), /HTTPS/);
});

test('TV client resolves capability URLs without exposing server paths', () => {
  const client = new CanonicalTvClient('https://loomtv.local:3848');
  assert.equal(client.absoluteUrl('/api/v1/media/id/direct?token=cap'), 'https://loomtv.local:3848/api/v1/media/id/direct?token=cap');
});

test('saved connection recovery distinguishes authorization loss from an outage', () => {
  assert.equal(isTvAuthorizationFailure({ status: 401 }), true);
  assert.equal(isTvAuthorizationFailure({ status: 403 }), true);
  assert.equal(isTvAuthorizationFailure({ status: 500 }), false);
  assert.equal(isTvAuthorizationFailure(new TypeError('Network request failed')), false);
});

test('TV discovery accepts the document a real Loom server sends', async (context) => {
  const { createCanonicalVideoServer } = await import('../../server/src/server.js');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-tv-discovery-'));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  const paths = { dataDir: path.join(base, 'data'), cacheDir: path.join(base, 'cache'), mediaDir: null };
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.cacheDir, { recursive: true });
  const server = createCanonicalVideoServer({
    host: '127.0.0.1', port: 0, paths, version: '9.9.9-test',
    bootstrapSecret: 'tv-discovery-bootstrap-secret-32-bytes',
  });
  const address = await server.start();
  context.after(() => server.stop());

  const client = new CanonicalTvClient('https://loomtv.local', null, `http://127.0.0.1:${address.port}`);
  const discovery = await client.discover();
  assert.equal(discovery.serverVersion, '9.9.9-test');
  assert.equal(typeof discovery.apiVersion, 'string');
});

test('TV discovery also accepts an envelope and rejects non-Loom answers', async (context) => {
  const responses = [
    Response.json({ ok: true, data: { apiVersion: '1', serverVersion: '2.0.4', certificateFingerprint: 'ab' } }),
    Response.json({ ok: false, error: { code: 'maintenance', message: 'Down for maintenance.' } }, { status: 503 }),
    Response.json({ hello: 'not loom' }),
    new Response('<html>router login</html>', { status: 200 }),
  ];
  context.mock.method(globalThis, 'fetch', async () => responses.shift());
  const client = new CanonicalTvClient('https://loomtv.local');
  assert.deepEqual(await client.discover(), { apiVersion: '1', serverVersion: '2.0.4', certificateFingerprint: 'ab' });
  await assert.rejects(client.discover(), { code: 'maintenance', status: 503, message: 'Down for maintenance.' });
  await assert.rejects(client.discover(), { code: 'invalid_discovery' });
  await assert.rejects(client.discover(), { code: 'invalid_discovery' });
});
