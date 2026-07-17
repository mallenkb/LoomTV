import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerResource, resolveLocalResource } from '../src/main/resourceRegistry.ts';

const MEDIA_KINDS = new Set(['media'] as const);

test('opaque resources resolve only to regular files inside configured roots', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-resource-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const libraryRoot = path.join(temporaryRoot, 'library');
  const outsideRoot = path.join(temporaryRoot, 'outside');
  fs.mkdirSync(libraryRoot);
  fs.mkdirSync(outsideRoot);
  const mediaPath = path.join(libraryRoot, 'movie.mkv');
  const outsidePath = path.join(outsideRoot, 'private.mkv');
  fs.writeFileSync(mediaPath, 'media');
  fs.writeFileSync(outsidePath, 'outside');

  const validId = registerResource('test-secret', 'media', mediaPath);
  const outsideId = registerResource('test-secret', 'media', outsidePath);
  assert.equal(resolveLocalResource(validId, MEDIA_KINDS, [libraryRoot]), fs.realpathSync.native(mediaPath));
  assert.throws(() => resolveLocalResource(outsideId, MEDIA_KINDS, [libraryRoot]), /outside the configured library/);
  assert.throws(() => resolveLocalResource('../movie.mkv', MEDIA_KINDS, [libraryRoot]), /Unknown local resource/);
  assert.throws(() => resolveLocalResource('%2e%2e%2fmovie.mkv', MEDIA_KINDS, [libraryRoot]), /Unknown local resource/);
});

test('opaque resources reject escaping symlinks and files removed after registration', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-resource-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const libraryRoot = path.join(temporaryRoot, 'library');
  fs.mkdirSync(libraryRoot);
  const outsidePath = path.join(temporaryRoot, 'outside.mkv');
  fs.writeFileSync(outsidePath, 'outside');
  const symlinkPath = path.join(libraryRoot, 'escape.mkv');
  fs.symlinkSync(outsidePath, symlinkPath);
  const symlinkId = registerResource('test-secret', 'media', symlinkPath);
  assert.throws(() => resolveLocalResource(symlinkId, MEDIA_KINDS, [libraryRoot]), /outside the configured library/);

  const removedPath = path.join(libraryRoot, 'removed.mkv');
  fs.writeFileSync(removedPath, 'media');
  const removedId = registerResource('test-secret', 'media', removedPath);
  fs.unlinkSync(removedPath);
  assert.throws(() => resolveLocalResource(removedId, MEDIA_KINDS, [libraryRoot]));
});
