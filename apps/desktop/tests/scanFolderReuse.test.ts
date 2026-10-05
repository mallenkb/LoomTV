import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { reusableChildFolders } from '../src/main/scanning/quickScanCache.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';

const root = path.resolve('/library/Anime');
const show = (name: string, files: string[], complete = true) => ({
  id: name, type: 'anime', title: name, year: 2020, poster: complete ? 'p.jpg' : '', backdrop: complete ? 'b.jpg' : '',
  summary: complete ? 'A summary.' : '', rating: 7, genres: complete ? ['Action'] : [], cast: [],
  filePath: path.join(root, name),
  episodeFiles: files.map((file, index) => ({ season: 1, episode: index + 1, filePath: path.join(root, name, file) })),
}) as unknown as MediaItem;

const previous = { Overgeared: 'child-v1:1:a', 'Attack on Titan': 'child-v1:2:b', Frieren: 'child-v1:1:c' };

test('only folders whose files changed are rebuilt', () => {
  const items = [show('Overgeared', ['S01E01.mkv']), show('Attack on Titan', ['S01E01.mkv', 'S01E02.mkv']), show('Frieren', ['S01E01.mkv'])];
  const current = { ...previous, Overgeared: 'child-v1:2:new' };
  const reused = reusableChildFolders(root, items, previous, current, false);
  assert.deepEqual([...reused.keys()].sort(), [path.join(root, 'Attack on Titan'), path.join(root, 'Frieren')]);
  assert.equal(reused.get(path.join(root, 'Frieren'))?.[0].id, 'Frieren');
});

test('new, removed and never-fingerprinted folders are rebuilt', () => {
  const items = [show('Attack on Titan', ['S01E01.mkv']), show('Frieren', ['S01E01.mkv'])];
  const current = { 'Attack on Titan': previous['Attack on Titan'], 'New Show': 'child-v1:1:n' };
  const reused = reusableChildFolders(root, items, { 'Attack on Titan': previous['Attack on Titan'] }, current, false);
  assert.deepEqual([...reused.keys()], [path.join(root, 'Attack on Titan')]);
});

test('an item with files in two folders blocks reuse of both', () => {
  const split = show('Overgeared', ['S01E01.mkv']);
  split.episodeFiles?.push({ season: 2, episode: 1, filePath: path.join(root, 'Frieren', 'stray.mkv') } as never);
  const reused = reusableChildFolders(root, [split, show('Frieren', ['S01E01.mkv']), show('Attack on Titan', ['S01E01.mkv'])], previous, previous, false);
  assert.deepEqual([...reused.keys()], [path.join(root, 'Attack on Titan')]);
});

test('loose files in the root are never reused', () => {
  const loose = { ...show('Movie', []), filePath: path.join(root, 'Movie.mkv'), episodeFiles: [] } as MediaItem;
  const reused = reusableChildFolders(root, [loose, show('Frieren', ['S01E01.mkv'])], previous, previous, false);
  assert.deepEqual([...reused.keys()], [path.join(root, 'Frieren')]);
});

test('when a missing-metadata retry is due, shows with incomplete metadata are rebuilt', () => {
  const items = [show('Frieren', ['S01E01.mkv'], false), show('Attack on Titan', ['S01E01.mkv'], false)];
  assert.equal(reusableChildFolders(root, items, previous, previous, true).size, 0);
  assert.equal(reusableChildFolders(root, items, previous, previous, false).size, 2);
});
