import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedSubtitleUrl, compareSubtitleLanguages, downloadOnlineSubtitle, findOnlineSubtitles,
  subtitleLanguageLabel, subtitleSearchMatches, subtitleSearchUrl,
} from '../src/lib/openSubtitlesV3.ts';

const downloadUrl = 'https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/45899';
const video = { imdbId: 'tt0133093', type: 'movie' as const };

test('puts English first and sorts the other languages alphabetically', () => {
  assert.deepEqual(['French', 'Arabic', 'English', 'German'].sort(compareSubtitleLanguages),
    ['English', 'Arabic', 'French', 'German']);
});

test('builds movie and episode requests from validated IMDb identities', () => {
  assert.equal(subtitleSearchUrl(video), 'https://opensubtitles-v3.strem.io/subtitles/movie/tt0133093.json');
  assert.equal(subtitleSearchUrl({ ...video, type: 'series', season: 0, episode: 2 }),
    'https://opensubtitles-v3.strem.io/subtitles/series/tt0133093%3A0%3A2.json');
  assert.throws(() => subtitleSearchUrl({ ...video, imdbId: '../secret' }));
  assert.throws(() => subtitleSearchUrl({ ...video, type: 'series', season: 1, episode: 0 }));
});

test('language aliases group together and search supports names, languages and sources', () => {
  assert.equal(subtitleLanguageLabel('eng'), 'English');
  assert.equal(subtitleLanguageLabel('fre'), 'French');
  assert.equal(subtitleLanguageLabel('fra'), subtitleLanguageLabel('fr'));
  assert.equal(subtitleLanguageLabel('ger'), 'German');
  assert.equal(subtitleLanguageLabel('pob'), 'Brazilian Portuguese');
  assert.equal(subtitleLanguageLabel('und'), 'Unknown language');
  assert.ok(subtitleSearchMatches('fra', 'Movie BluRay.srt', 'french bluray', 'OpenSubtitles v3'));
  assert.ok(subtitleSearchMatches('eng', 'Movie.srt', 'opensubtitles', 'OpenSubtitles v3'));
  assert.equal(subtitleSearchMatches('fra', 'Movie.srt', 'english'), false);
});

test('rejects untrusted download targets', () => {
  assert.ok(allowedSubtitleUrl(downloadUrl));
  for (const url of [
    'http://subs5.strem.io/en/download/file/1', 'https://127.0.0.1/en/download/file/1',
    'https://subs5.strem.io.evil.example/en/download/file/1', 'https://subs5.strem.io:8443/en/download/file/1',
    'https://user:pass@subs5.strem.io/en/download/file/1', 'https://subs5.strem.io/other',
  ]) assert.equal(allowedSubtitleUrl(url), false, url);
});

test('normalizes results, preserves the source and filters invalid or duplicate downloads', async () => {
  const fakeFetch: typeof fetch = async (_url, init) => {
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    return Response.json({ subtitles: [
      { id: '1', lang: 'eng', url: downloadUrl, subtitleFileName: 'Movie.en.srt' },
      { id: '2', lang: 'eng', url: downloadUrl, subtitleFileName: 'Movie.en.srt' },
      { id: '3', lang: 'fra', url: 'http://localhost/private' },
      null,
    ] });
  };
  const results = await findOnlineSubtitles(video, undefined, fakeFetch);
  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'OpenSubtitles v3');
  assert.equal(results[0].name, 'Movie.en.srt');
});

test('downloads timed text and rejects provider errors and oversized responses', async () => {
  const subtitle = { id: downloadUrl, url: downloadUrl, language: 'eng', name: 'Movie.srt', source: 'OpenSubtitles v3' as const };
  const text = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
  assert.equal(await downloadOnlineSubtitle(subtitle, undefined, async () => new Response(text)), text);
  await assert.rejects(downloadOnlineSubtitle(subtitle, undefined, async () => new Response('<html>Unavailable</html>')), /timed|SRT/);
  await assert.rejects(findOnlineSubtitles(video, undefined, async () => new Response('', { status: 429 })), /429/);
  await assert.rejects(findOnlineSubtitles(video, undefined, async () => Response.json({})), /invalid/);
  await assert.rejects(findOnlineSubtitles(video, undefined, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), /too large/);
});

test('passes cancellation to the provider request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(findOnlineSubtitles(video, controller.signal, async (_url, init) => {
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException('Aborted', 'AbortError');
  }), { name: 'AbortError' });
});
