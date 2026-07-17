import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allItems,
  filePathFromUrl,
  matchesMobileLibraryFilter,
  matchesQuery,
  needsTranscode,
  playTargetForItem,
  progressStateFor,
} from '../mobileLibrary.ts';

const resourceId = 'a'.repeat(43);
const resourceUrl = `http://desktop.local:3847/stream?resourceId=${resourceId}`;

test('resource identifiers are read from stream URLs and accepted in opaque form', () => {
  assert.equal(filePathFromUrl(resourceUrl), resourceId);
  assert.equal(filePathFromUrl(resourceId), resourceId);
  assert.equal(filePathFromUrl('/Users/example/movie.mkv'), '');
});

test('transcode decisions preserve container and audio compatibility rules', () => {
  assert.equal(needsTranscode(resourceUrl, { container: 'matroska', audioCodec: 'aac' }), true);
  assert.equal(needsTranscode(resourceUrl, { container: 'mp4', audioCodec: 'eac3' }), true);
  assert.equal(needsTranscode(resourceUrl, { container: 'mp4', audioCodec: 'aac' }), false);
});

test('series playback selects the first not-watched episode and preserves resume position', () => {
  const firstId = 'b'.repeat(43);
  const secondId = 'c'.repeat(43);
  const item = {
    id: 'show',
    type: 'tv',
    title: 'Example Show',
    filePath: firstId,
    episodeFiles: [
      { season: 1, episode: 1, filePath: firstId },
      { season: 1, episode: 2, filePath: secondId },
    ],
  };
  const target = playTargetForItem(item, {
    [firstId]: { position: 900, duration: 1000, updatedAt: 1, watched: true },
    [secondId]: { position: 120, duration: 1000, updatedAt: 2, watched: false },
  });

  assert.equal(target.streamPath, secondId);
  assert.equal(target.startPosition, 120);
  assert.equal(target.subtitle, 'S01E02 · Example Show');
});

test('progress and library filters retain the existing ninety-percent watched threshold', () => {
  const movie = { id: 'movie', type: 'movie', title: 'Movie', filePath: resourceId };
  const progress = {
    [resourceId]: { position: 900, duration: 1000, updatedAt: 1, watched: false },
  };

  assert.equal(progressStateFor(progress, resourceId).watched, true);
  assert.equal(matchesMobileLibraryFilter(movie, 'watched', progress), true);
  assert.equal(matchesMobileLibraryFilter(movie, 'unwatched', progress), false);
});

test('library selectors preserve collection order and text matching behavior', () => {
  const anime = { id: 'anime', type: 'anime', title: 'Sky Story', filePath: resourceId, genres: ['Action Adventure'] };
  const tv = { id: 'tv', type: 'tv', title: 'Drama House', filePath: resourceId };
  const movie = { id: 'movie', type: 'movie', title: 'Comedy Night', filePath: resourceId };

  assert.deepEqual(allItems({ animeShows: [anime], tvShows: [tv], movies: [movie] }), [anime, tv, movie]);
  assert.equal(matchesQuery(anime, 'action'), true);
  assert.equal(matchesQuery(anime, 'missing'), false);
});
