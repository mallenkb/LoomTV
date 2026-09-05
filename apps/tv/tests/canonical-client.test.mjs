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
