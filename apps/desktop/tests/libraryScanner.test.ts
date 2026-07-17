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
