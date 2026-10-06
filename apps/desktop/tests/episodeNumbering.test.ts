import assert from 'node:assert/strict';
import test from 'node:test';
import { alignAbsoluteEpisodes } from '../src/main/metadata/episodeNumbering.ts';
import type { EpisodeMeta } from '../src/main/metadata/types.ts';

const provider: EpisodeMeta[] = [1, 2, 3, 4].flatMap((season) => Array.from({ length: season === 4 ? 11 : 13 }, (_, index) => ({
  season, number: index + 1, title: `S${season}E${index + 1}`, summary: 'x', still: '', rating: 7, airDate: '',
})));

test('a season numbered by absolute episode takes the matching provider episodes', () => {
  const local = [40, 41, 47].map((episode) => ({ season: 4, episode }));
  const aligned = alignAbsoluteEpisodes(local, provider) || [];
  const byKey = new Map(aligned.map((episode) => [`${episode.season}:${episode.number}`, episode.title]));
  assert.equal(byKey.get('4:40'), 'S4E1');
  assert.equal(byKey.get('4:41'), 'S4E2');
  assert.equal(byKey.get('4:47'), 'S4E8');
});

test('a single episode the provider has not listed yet is not remapped', () => {
  const local = [...Array.from({ length: 13 }, (_, index) => ({ season: 2, episode: index + 1 })), { season: 2, episode: 14 }];
  assert.equal(alignAbsoluteEpisodes(local, provider), provider, 'nothing added');
});

test('season one and numbers that do not land inside the season are left alone', () => {
  assert.equal(alignAbsoluteEpisodes([{ season: 1, episode: 20 }], provider), provider);
  assert.equal(alignAbsoluteEpisodes([{ season: 4, episode: 60 }], provider), provider);
});
