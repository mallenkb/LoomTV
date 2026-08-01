import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLibraryScanner } from '../src/main/libraryScanner.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';

function item(filePath: string, type: MediaItem['type']): MediaItem {
  return {
    id: filePath,
    type,
    title: path.basename(filePath),
    year: 0,
    poster: '',
    backdrop: '',
    summary: '',
    rating: 0,
    genres: [],
    cast: [],
    filePath,
  };
}

test('library scanner delegates standalone and nested movie files with an explicit movie type', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'loomtv-library-scanner-'));
  const nested = path.join(root, 'Collection');
  mkdirSync(nested);
  writeFileSync(path.join(root, 'Root Movie.mkv'), 'video');
  writeFileSync(path.join(nested, 'Nested Movie.mp4'), 'video');
  const calls: Array<{ filePath: string; forcedType?: MediaItem['type'] }> = [];
  const scanner = createLibraryScanner({
    buildMovieItemFromFile: async (request) => {
      calls.push({ filePath: request.fullPath, forcedType: request.forcedType });
      return item(request.fullPath, request.forcedType || 'movie');
    },
    buildTVItemFromFolder: async () => null,
    probeMediaFile: () => ({}),
    scanEpisodeFiles: () => [],
    shouldSplitContainerFolder: () => false,
  });

  try {
    const items = await scanner.scanFolder(root, { folderKind: 'movies' });
    assert.equal(items.length, 2);
    assert.deepEqual(calls.map((call) => call.forcedType), ['movie', 'movie']);
    assert.deepEqual(items.map((media) => path.basename(media.filePath)).sort(), ['Nested Movie.mp4', 'Root Movie.mkv']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mixed Others scans retain every loose video and detect structured TV folders', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'loomtv-mixed-library-'));
  const homeVideos = path.join(root, 'Home Videos');
  const show = path.join(root, 'Example Show');
  mkdirSync(homeVideos);
  mkdirSync(show);
  writeFileSync(path.join(root, 'Loose Movie.mkv'), 'video');
  writeFileSync(path.join(homeVideos, 'Birthday.divx'), 'video');
  writeFileSync(path.join(homeVideos, 'Holiday.mxf'), 'video');
  writeFileSync(path.join(show, 'Example.Show.S01E01.mkv'), 'video');

  const movieCalls: Array<{ filePath: string; forcedType?: MediaItem['type'] }> = [];
  const tvCalls: string[] = [];
  const scanner = createLibraryScanner({
    buildMovieItemFromFile: async (request) => {
      movieCalls.push({ filePath: request.fullPath, forcedType: request.forcedType });
      return item(request.fullPath, request.forcedType || 'movie');
    },
    buildTVItemFromFolder: async (request) => {
      tvCalls.push(request.fullPath);
      return item(request.fullPath, 'tv');
    },
    probeMediaFile: () => ({}),
    scanEpisodeFiles: (folderPath) => folderPath === show
      ? [{ season: 1, episode: 1, filePath: path.join(show, 'Example.Show.S01E01.mkv') }]
      : [],
    shouldSplitContainerFolder: () => false,
  });

  try {
    const items = await scanner.scanFolder(root, {});
    assert.equal(items.length, 4);
    assert.deepEqual(movieCalls.map((call) => path.basename(call.filePath)).sort(), [
      'Birthday.divx',
      'Holiday.mxf',
      'Loose Movie.mkv',
    ]);
    assert.deepEqual(movieCalls.map((call) => call.forcedType), [undefined, undefined, undefined]);
    assert.deepEqual(tvCalls, [show]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
