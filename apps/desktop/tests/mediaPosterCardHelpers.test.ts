import assert from 'node:assert/strict';
import test from 'node:test';

import type { MediaItem, TVShow } from '../src/contexts/LibraryContext.tsx';
import {
  availableSeasonCount,
  firstPlayableMediaPath,
  mediaLink,
  mediaMetaLine,
} from '../src/components/MediaPosterCard.helpers.ts';

function media(overrides: Partial<MediaItem>): MediaItem {
  return {
    id: 'media-1',
    type: 'movie',
    title: 'Example',
    year: 2024,
    poster: '',
    backdrop: '',
    summary: '',
    rating: 0,
    genres: [],
    cast: [],
    filePath: '/movies/example.mkv',
    ...overrides,
  };
}

test('poster helpers preserve media routes and movie fallback paths', () => {
  const movie = media({ id: 'movie-a' });
  assert.equal(mediaLink(movie), '/movie/movie-a');
  assert.equal(firstPlayableMediaPath(movie), '/movies/example.mkv');
  assert.equal(mediaMetaLine(movie), '2024');
});

test('poster helpers select the first sorted episode without mutating episode order', () => {
  const episodeFiles = [
    { season: 2, episode: 1, filePath: '/shows/s02e01.mkv' },
    { season: 1, episode: 2, filePath: '/shows/s01e02.mkv' },
    { season: 1, episode: 1, filePath: '/shows/s01e01.mkv' },
  ];
  const show = media({
    id: 'show-a',
    type: 'tv',
    filePath: '',
    episodeFiles,
    seasons: [],
  }) as TVShow;

  assert.equal(firstPlayableMediaPath(show), '/shows/s01e01.mkv');
  assert.equal(episodeFiles[0]?.filePath, '/shows/s02e01.mkv');
  assert.equal(availableSeasonCount(show), 2);
  assert.equal(mediaLink(show), '/tv/show-a');
  assert.equal(mediaMetaLine(show), '2024 · 2 Seasons');
});

test('season metadata falls back to declared seasons and routes anime separately', () => {
  const anime = media({
    id: 'anime-a',
    type: 'anime',
    year: 0,
    filePath: '',
    episodeFiles: [],
    seasons: [{ number: 1, title: 'Season 1', episodeCount: 12 }],
  }) as TVShow;

  assert.equal(availableSeasonCount(anime), 1);
  assert.equal(mediaLink(anime), '/anime/anime-a');
  assert.equal(mediaMetaLine(anime), '1 Season');
});
