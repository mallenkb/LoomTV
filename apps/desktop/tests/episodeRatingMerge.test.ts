import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSelectedEpisodeRatings } from '../src/main/officialMetadataService.ts';
import type { EpisodeMeta } from '../src/main/metadata/types.ts';

const ep = (number: number, rating: number, title = `Episode title ${number}`): EpisodeMeta => ({
  season: 1, number, title, summary: '', still: '', rating, airDate: '',
});

test('the selected source wins, and unrated episodes take the first rating another provider has', () => {
  const provider = [ep(1, 0), ep(2, 0), ep(3, 0), ep(4, 0)];
  const tvmaze = [ep(1, 8.1), ep(2, 0)];
  const tmdb = [ep(2, 7.4), ep(3, 0)];
  const omdb = [ep(3, 8.8)];
  const merged = mergeSelectedEpisodeRatings(provider, tvmaze, [tmdb, omdb]);
  assert.deepEqual(merged?.map((episode) => episode.rating), [8.1, 7.4, 8.8, 0]);
});

test('without fallbacks, an unrated episode stays unrated as before', () => {
  const merged = mergeSelectedEpisodeRatings([ep(1, 6)], [ep(1, 0)]);
  assert.equal(merged?.[0].rating, 0);
});
