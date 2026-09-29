import assert from 'node:assert/strict';
import test from 'node:test';

import { episodeFileKey, indexEpisodeFiles } from '../src/components/VideoPlayer/episodeIndex.ts';

test('episode file keys remain stable across seasons', () => {
  assert.equal(episodeFileKey(1, 2), '1:2');
  assert.notEqual(episodeFileKey(1, 23), episodeFileKey(12, 3));
});

test('episode file indexing preserves the prior last-file-wins behavior', () => {
  const first = { season: 1, episode: 1, filePath: '/first.mkv' };
  const replacement = { season: 1, episode: 1, filePath: '/replacement.mkv' };
  const second = { season: 1, episode: 2, filePath: '/second.mkv' };
  const index = indexEpisodeFiles([first, second, replacement]);

  assert.equal(index.size, 2);
  assert.equal(index.get('1:1'), replacement);
  assert.equal(index.get('1:2'), second);
});
