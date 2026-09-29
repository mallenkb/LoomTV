import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getLibraryFolderStatus,
  isNetworkLikePath,
  libraryFolderStatusesFor,
} from '../src/main/libraryFolders.ts';

test('network-like library paths are detected across common mount styles', () => {
  assert.equal(isNetworkLikePath('/Volumes/Media/Movies'), true);
  assert.equal(isNetworkLikePath('/mnt/nas/Movies'), true);
  assert.equal(isNetworkLikePath('/media/user/NAS/TV'), true);
  assert.equal(isNetworkLikePath('\\\\NAS\\Media\\Movies'), true);
  assert.equal(isNetworkLikePath('/Users/me/Movies'), false);
});

test('library folder status reports readable folders as available', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-folder-status-'));
  try {
    const status = getLibraryFolderStatus(dir, 'movies');
    assert.equal(status.path, dir);
    assert.equal(status.kind, 'movies');
    assert.equal(status.state, 'available');
    assert.equal(status.message, 'Folder is available.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('library folder status keeps unavailable network shares recoverable', () => {
  const missing = path.join('/Volumes', 'LoomTVMissingNAS', 'Movies');
  const status = getLibraryFolderStatus(missing, 'movies');
  assert.equal(status.state, 'unavailable');
  assert.equal(status.isNetworkLike, true);
  assert.match(status.message, /Reconnect the share/);
});

test('library folder statuses preserve section ordering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-folder-order-'));
  try {
    const statuses = libraryFolderStatusesFor({
      movies: [path.join(dir, 'Movies')],
      tvShows: [path.join(dir, 'TV')],
      anime: [path.join(dir, 'Anime')],
      others: [path.join(dir, 'Other')],
    });
    assert.deepEqual(statuses.map((status) => status.kind), ['movies', 'tvShows', 'anime', 'others']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
