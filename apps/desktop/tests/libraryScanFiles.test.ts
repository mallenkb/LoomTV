import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getLibraryFolderSignature,
  scanEpisodeFiles,
} from '../src/main/libraryScanFiles.ts';
import { parseEpisodeFileName } from '../src/main/scanClassification.ts';

test('episode filename parsing covers TV, anime, and numbered-title conventions', () => {
  assert.deepEqual(parseEpisodeFileName('Show.S02E03.mkv', 1), { season: 2, episode: 3 });
  assert.deepEqual(parseEpisodeFileName('Show - Episode 12.mp4', 4), { season: 4, episode: 12 });
  assert.deepEqual(parseEpisodeFileName('[Group] Show - 07.mkv', 1), { season: 1, episode: 7 });
  assert.deepEqual(parseEpisodeFileName('03 - A Beginning.mkv', 5), { season: 5, episode: 3 });
  assert.equal(parseEpisodeFileName('Show 2026.mkv', 1), null);
});

test('episode scanning follows season folders, pairs subtitles, and skips extras', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'loomtv-scan-'));
  try {
    const season = path.join(root, 'Season 02');
    const extras = path.join(root, 'Extras');
    mkdirSync(season);
    mkdirSync(extras);
    writeFileSync(path.join(season, 'Show.S02E01.mkv'), 'video');
    writeFileSync(path.join(season, 'Show.S02E01.en.srt'), 'subtitle');
    writeFileSync(path.join(extras, 'Show.S00E01.mkv'), 'bonus');

    const episodes = scanEpisodeFiles(root, () => ({
      localMetadata: { videoCodec: 'h264' },
    }));

    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].season, 2);
    assert.equal(episodes[0].episode, 1);
    assert.equal(episodes[0].subtitles?.[0]?.lang, 'en');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('library signatures include media assets but ignore macOS sidecars', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'loomtv-signature-'));
  try {
    writeFileSync(path.join(root, 'Movie.mkv'), 'video');
    writeFileSync(path.join(root, 'Movie.en.srt'), 'subtitle');
    writeFileSync(path.join(root, 'poster.jpg'), 'image');
    writeFileSync(path.join(root, '._Movie.mkv'), 'sidecar');
    writeFileSync(path.join(root, 'notes.txt'), 'ignored');

    const signature = getLibraryFolderSignature(root);
    assert.equal(signature?.fileCount, 3);
    assert.match(signature?.signature || '', /^3:[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
