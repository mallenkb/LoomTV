import assert from 'node:assert/strict';
import test from 'node:test';
import {
  firstEpisodeFilePath,
  shouldRequestFallbackThumbnail,
} from '../src/lib/renderPerformance.ts';

test('fallback thumbnails are deferred until missing artwork is visible', () => {
  assert.equal(shouldRequestFallbackThumbnail({ hasArtworkSources: false, isVisible: false }), false);
  assert.equal(shouldRequestFallbackThumbnail({ hasArtworkSources: true, isVisible: true }), false);
  assert.equal(shouldRequestFallbackThumbnail({ hasArtworkSources: false, isVisible: true }), true);
});

test('fallback thumbnails load for visible cards after artwork fails', () => {
  assert.equal(shouldRequestFallbackThumbnail({
    hasArtworkSources: true,
    hasArtworkFailed: true,
    isVisible: false,
  }), false);
  assert.equal(shouldRequestFallbackThumbnail({
    hasArtworkSources: true,
    hasArtworkFailed: true,
    isVisible: true,
  }), true);
});

test('first episode file path is chosen without mutating the source files', () => {
  const files = [
    { season: 2, episode: 1, filePath: '/show/s02e01.mkv' },
    { season: 1, episode: 2, filePath: '/show/s01e02.mkv' },
    { season: 1, episode: 1, filePath: '/show/s01e01.mkv' },
  ];

  assert.equal(firstEpisodeFilePath(files), '/show/s01e01.mkv');
  assert.deepEqual(files.map((file) => file.filePath), [
    '/show/s02e01.mkv',
    '/show/s01e02.mkv',
    '/show/s01e01.mkv',
  ]);
});
