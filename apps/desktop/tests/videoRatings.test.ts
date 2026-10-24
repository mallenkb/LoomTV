import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVideoRatings } from '../src/shared/videoRatings.ts';
import { fetchVideoProviderRatings } from '../src/main/metadata/providerRatings.ts';

test('quota failure keeps known scores and fills missing scores from the fallback', async () => {
  const result = await resolveVideoRatings({
    existing: { imdb: { value: 7.5, scale: 10 } },
    loadOMDb: async () => { throw new Error('Request limit reached'); },
    loadMDBList: async () => ({ imdb: { value: 7, scale: 10 }, rottenTomatoes: { value: 92, scale: 100 } }),
  });
  assert.equal(result.imdb?.value, 7.5);
  assert.equal(result.rottenTomatoes?.value, 92);
});

test('complete ratings do not make another provider request', async () => {
  const existing = {
    imdb: { value: 8, scale: 10 as const },
    rottenTomatoes: { value: 90, scale: 100 as const },
    metacritic: { value: 80, scale: 100 as const },
    popcornmeter: { value: 88, scale: 100 as const },
  };
  const unexpected = async () => { assert.fail('Unexpected provider request'); };
  assert.deepEqual(await resolveVideoRatings({ existing, loadOMDb: unexpected, loadMDBList: unexpected }), existing);
});

test('local rating enrichment rejects another IMDb identity or media type', async () => {
  for (const response of [
    { imdbID: 'tt9999999', Type: 'movie', imdbRating: '9.0' },
    { imdbID: 'tt1234567', Type: 'series', imdbRating: '9.0' },
  ]) {
    assert.deepEqual(await fetchVideoProviderRatings('tt1234567', 'movie', {
      omdbApiKey: 'fixture', fetchOMDb: async () => response,
    }), {});
  }
});
