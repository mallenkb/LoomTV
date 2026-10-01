import assert from 'node:assert/strict';
import test from 'node:test';
import type { MetadataProviderRequest } from '../src/shared/desktopProtocol.ts';
import { resolveOnlineSubtitleVideo } from '../src/lib/subtitleVideoResolver.ts';
import { subtitleSearchUrl } from '../src/lib/openSubtitlesV3.ts';

const anime = { title: 'VINLAND SAGA', year: 2019, type: 'anime' as const, providerIds: { malId: '37521' } };
const currentEpisode = { season: 2, episode: 1 };
const catalog = { metas: [
  { id: 'tt10233448', type: 'series', name: 'Vinland Saga', releaseInfo: '2019-2023' },
  { id: 'tt15515120', type: 'series', name: 'Blind Wave: Vinland Saga Reaction', releaseInfo: '2021-' },
] };

test('MAL-only anime resolves its series identity without losing season 2', async () => {
  const calls: MetadataProviderRequest[] = [];
  const item = structuredClone(anime);
  const video = await resolveOnlineSubtitleVideo(item, currentEpisode, async (request) => { calls.push(request); return catalog; });
  assert.deepEqual(video, { imdbId: 'tt10233448', type: 'series', season: 2, episode: 1 });
  assert.deepEqual(item, anime);
  assert.deepEqual(calls, [{ provider: 'cinemeta', path: 'catalog/series/top/search=VINLAND%20SAGA.json' }]);
  assert.equal(subtitleSearchUrl(video), 'https://opensubtitles-v3.strem.io/subtitles/series/tt10233448%3A2%3A1.json');
});

test('a valid saved IMDb ID bypasses metadata lookup', async () => {
  const video = await resolveOnlineSubtitleVideo({ ...anime, providerIds: { imdbId: 'tt10233448' } }, currentEpisode,
    async () => { throw new Error('Unexpected request'); });
  assert.equal(video.imdbId, 'tt10233448');
});

test('saved provider IDs take precedence over translated display titles', async () => {
  const calls: MetadataProviderRequest[] = [];
  const video = await resolveOnlineSubtitleVideo({ ...anime, title: 'ヴィンランド・サガ', providerIds: { tvmazeId: '42155' } }, currentEpisode,
    async (request) => { calls.push(request); return { externals: { imdb: 'tt10233448' } }; });
  assert.equal(video.imdbId, 'tt10233448');
  assert.deepEqual(calls, [{ provider: 'tvmaze', path: 'shows/42155' }]);
});

test('conflicting cross-references stop instead of selecting a title', async () => {
  await assert.rejects(resolveOnlineSubtitleVideo({ ...anime, providerIds: { tmdbId: '88803', tvdbId: '359274' } }, currentEpisode,
    async (request) => request.provider === 'tmdb' ? { imdb_id: 'tt10233448' } : { externals: { imdb: 'tt15515120' } }), /different IMDb titles/);
});

test('missing TMDB credentials fall back to the public title lookup', async () => {
  const video = await resolveOnlineSubtitleVideo({ ...anime, providerIds: { tmdbId: '88803' } }, currentEpisode,
    async (request) => { if (request.provider === 'tmdb') throw new Error('TMDB API key is missing.'); return catalog; });
  assert.equal(video.imdbId, 'tt10233448');
});

test('movie remakes are resolved by year and use the movie subtitle endpoint', async () => {
  const video = await resolveOnlineSubtitleVideo({ title: 'Dune', year: 2021, type: 'movie' }, {}, async () => ({ metas: [
    { id: 'tt0087182', type: 'movie', name: 'Dune', releaseInfo: '1984' },
    { id: 'tt1160419', type: 'movie', name: 'Dune', released: '2021-09-15T00:00:00.000Z' },
  ] }));
  assert.equal(subtitleSearchUrl(video), 'https://opensubtitles-v3.strem.io/subtitles/movie/tt1160419.json');
});

test('inexact titles, wrong years, and ambiguous matches are rejected', async () => {
  await assert.rejects(resolveOnlineSubtitleVideo(anime, currentEpisode, async () => ({ metas: [catalog.metas[1]] })), /exact IMDb match/);
  await assert.rejects(resolveOnlineSubtitleVideo({ ...anime, year: 2023 }, currentEpisode, async () => catalog), /exact IMDb match/);
  await assert.rejects(resolveOnlineSubtitleVideo(anime, currentEpisode, async () => ({ metas: [
    catalog.metas[0], { ...catalog.metas[0], id: 'tt1234567' },
  ] })), /More than one IMDb title/);
});

test('offline mode blocks fallback provider requests', async () => {
  let calls = 0;
  await assert.rejects(resolveOnlineSubtitleVideo({ ...anime, providerIds: { tvmazeId: '42155' } }, currentEpisode,
    async () => { calls++; throw new Error('Metadata offline mode is enabled.'); }), /offline mode/);
  assert.equal(calls, 1);
});

test('missing episode coordinates and cancellation do not start a lookup', async () => {
  let calls = 0;
  const request = async () => { calls++; return catalog; };
  await assert.rejects(resolveOnlineSubtitleVideo(anime, { season: 2 }, request), /Choose a season and episode/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveOnlineSubtitleVideo(anime, currentEpisode, request, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('cancellation after cross-reference lookup prevents title fallback', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(resolveOnlineSubtitleVideo({ ...anime, providerIds: { tvmazeId: '42155' } }, currentEpisode,
    async () => { calls++; controller.abort(); return {}; }, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('malformed provider metadata produces an actionable error', async () => {
  await assert.rejects(resolveOnlineSubtitleVideo(anime, currentEpisode, async () => ({ metas: 'invalid' })), /invalid metadata/);
});
