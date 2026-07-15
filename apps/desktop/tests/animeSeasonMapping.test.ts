import assert from 'node:assert/strict';
import test from 'node:test';
import { isConfidentAnimeSeasonMapping } from '../src/main/animeSeasonMapping.ts';

const episodes = Array.from({ length: 12 }, (_, index) => ({
  season: 1, number: index + 1, title: `Episode ${index + 1}`, summary: '', still: '', rating: 0, airDate: '',
}));
const localEpisodes = Array.from({ length: 12 }, (_, index) => ({
  season: 2, episode: index + 1, filePath: `/Show Season 2 S02E${index + 1}.mkv`,
}));

test('season mapping accepts a unique matching cour with complete episode coverage', () => {
  assert.equal(isConfidentAnimeSeasonMapping({
    malId: 200, title: 'Show Season 2', aliases: ['Show Part 2'], episodes,
  }, 'Show Season 2', localEpisodes), true);
});

test('season mapping refuses reused MAL ids, wrong parts, and incomplete cours', () => {
  const metadata = { malId: 200, title: 'Show Season 2', aliases: ['Show Part 2'], episodes };
  assert.equal(isConfidentAnimeSeasonMapping(metadata, 'Show Season 2', localEpisodes, new Set([200])), false);
  assert.equal(isConfidentAnimeSeasonMapping({ ...metadata, title: 'Different Show', aliases: [] }, 'Show Season 2', localEpisodes), false);
  assert.equal(isConfidentAnimeSeasonMapping({ ...metadata, episodes: episodes.slice(0, 6) }, 'Show Season 2', localEpisodes), false);
});
