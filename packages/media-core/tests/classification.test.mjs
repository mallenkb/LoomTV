import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyVideoFile,
  cleanMediaTitle,
  isLikelyAnimePath,
  parseEpisodeFileName,
  seriesTitleFromEpisodeName,
} from '../src/index.mjs';

test('cleanMediaTitle strips release noise and extracts the year', () => {
  assert.deepEqual(
    cleanMediaTitle('The.Matrix.1999.1080p.BluRay.x264-YTS.mkv'),
    { title: 'The Matrix', year: 1999 },
  );
  assert.deepEqual(cleanMediaTitle('Spirited Away (2001) [1080p]'), { title: 'Spirited Away', year: 2001 });
  assert.equal(cleanMediaTitle('Some Show S02E05 720p WEB-DL').title, 'Some Show');
});

test('year-titled movies keep the later year as release year (ported desktop behavior)', () => {
  // Titles that are themselves years ("1917") are a known limitation shared
  // with the desktop cleaner: the title survives as a non-empty fallback and
  // the release year is still extracted.
  const cleaned = cleanMediaTitle('1917.2019.1080p.mkv');
  assert.equal(cleaned.year, 2019);
  assert.ok(cleaned.title.length > 0);
});

test('parseEpisodeFileName reads SxxEyy, named episodes, and gated bare numbers', () => {
  assert.deepEqual(parseEpisodeFileName('Show.S03E12.mkv', 1), { season: 3, episode: 12 });
  assert.deepEqual(parseEpisodeFileName('Show - Episode 7.mkv', 2), { season: 2, episode: 7 });
  // Bare numbers only parse in aggressive mode: "Rocky 3" is a movie.
  assert.equal(parseEpisodeFileName('Rocky 3.mkv', 1), null);
  assert.deepEqual(parseEpisodeFileName('Title - 07.mkv', 4, { aggressive: true }), { season: 4, episode: 7 });
});

test('seriesTitleFromEpisodeName recovers the show name from scene-style names', () => {
  assert.equal(seriesTitleFromEpisodeName('Breaking.Bad.S05E14.1080p.mkv'), 'Breaking Bad');
  assert.equal(seriesTitleFromEpisodeName('JustAMovie.2020.mkv'), null);
});

test('isLikelyAnimePath detects folder cues and fansub groups', () => {
  assert.equal(isLikelyAnimePath('Anime/Frieren/S01/ep1.mkv'), true);
  assert.equal(isLikelyAnimePath('[SubsPlease] Frieren - 01.mkv'), true);
  assert.equal(isLikelyAnimePath('Movies/Heat (1995).mkv'), false);
});

test('classifyVideoFile: scene-named episode inside show/season folders', () => {
  const result = classifyVideoFile('Severance/Season 2/Severance.S02E03.1080p.mkv');
  assert.equal(result.kind, 'episode');
  assert.deepEqual(result.series, { title: 'Severance', season: 2, episode: 3 });
});

test('classifyVideoFile: bare episode numbers only count inside a season folder', () => {
  const inSeason = classifyVideoFile('Frieren/Season 1/Frieren - 07.mkv');
  assert.equal(inSeason.kind, 'episode');
  assert.equal(inSeason.series.season, 1);
  assert.equal(inSeason.series.episode, 7);

  const looseMovie = classifyVideoFile('Movies/Rocky 3.mkv');
  assert.equal(looseMovie.kind, 'movie');
  assert.equal(looseMovie.title, 'Rocky 3');
});

test('classifyVideoFile: series title falls back to the parent folder', () => {
  const result = classifyVideoFile('My Quiet Show/episode 4.mkv');
  assert.equal(result.kind, 'episode');
  assert.equal(result.series.title, 'My Quiet Show');
  assert.equal(result.series.episode, 4);
});

test('classifyVideoFile: generic folder names never become series titles', () => {
  const result = classifyVideoFile('TV Shows/Dark.S01E01.mkv');
  assert.equal(result.kind, 'episode');
  assert.equal(result.series.title, 'Dark');
});

test('classifyVideoFile: movies keep title, year, and anime hint', () => {
  const result = classifyVideoFile('Anime/Akira.1988.2160p.Remux.mkv');
  assert.equal(result.kind, 'movie');
  assert.equal(result.title, 'Akira');
  assert.equal(result.year, 1988);
  assert.equal(result.animeLikely, true);
});
