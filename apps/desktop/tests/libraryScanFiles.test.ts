import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  extractSeasons,
  getLibraryFolderSignature,
  scanEpisodeFiles,
  seasonNumberFromDirectoryName,
} from '../src/main/libraryScanFiles.ts';
import {
  mergeLocalSeasonsWithMetadata,
  mergeOfficialSeasonMetadata,
  parseEpisodeFileName,
} from '../src/main/scanClassification.ts';

test('episode filename parsing covers TV, anime, and numbered-title conventions', () => {
  assert.deepEqual(parseEpisodeFileName('Show.S02E03.mkv', 1), { season: 2, episode: 3 });
  assert.deepEqual(parseEpisodeFileName('Show - Episode 12.mp4', 4), { season: 4, episode: 12 });
  assert.deepEqual(parseEpisodeFileName('[Group] Show - 07.mkv', 1), { season: 1, episode: 7 });
  assert.deepEqual(parseEpisodeFileName('03 - A Beginning.mkv', 5), { season: 5, episode: 3 });
  assert.equal(parseEpisodeFileName('Show 2026.mkv', 1), null);
});

test('decorated season folder names retain their leading season number', () => {
  assert.equal(seasonNumberFromDirectoryName('Season 01 - Unwavering Resolve Arc'), 1);
  assert.equal(seasonNumberFromDirectoryName('Season 2. Entertainment District Arc'), 2);
  assert.equal(seasonNumberFromDirectoryName('S03_Swordsmith Village Arc'), 3);
  assert.equal(seasonNumberFromDirectoryName('Series 04: Hashira Training Arc'), 4);
  assert.equal(seasonNumberFromDirectoryName('Specials - OVAs'), 0);
  assert.equal(seasonNumberFromDirectoryName('S01E02'), null);
  assert.equal(seasonNumberFromDirectoryName('Season 2024'), null);
});

test('decorated season folders group numbered anime files under the parent series', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'loomtv-decorated-seasons-'));
  try {
    const seasonOne = path.join(root, 'Season 01 - Unwavering Resolve Arc');
    const seasonTwo = path.join(root, 'Season 02. Entertainment District Arc');
    mkdirSync(seasonOne);
    mkdirSync(seasonTwo);
    writeFileSync(path.join(seasonOne, '[Group] Show - 01.mkv'), 'video');
    writeFileSync(path.join(seasonTwo, '[Group] Show - 01.mkv'), 'video');

    const probe = () => ({ localMetadata: { videoCodec: 'h264' } });
    const episodes = scanEpisodeFiles(root, probe);
    const seasons = extractSeasons(root, path.basename(root), probe);

    assert.deepEqual(episodes.map(({ season, episode }) => ({ season, episode })), [
      { season: 1, episode: 1 },
      { season: 2, episode: 1 },
    ]);
    assert.deepEqual(seasons, [
      { number: 1, title: 'Season 01 - Unwavering Resolve Arc', episodeCount: 1 },
      { number: 2, title: 'Season 02. Entertainment District Arc', episodeCount: 1 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('official season names replace local folder subtitles by season number', () => {
  const localSeasons = [
    { number: 1, title: 'Season 01', episodeCount: 26 },
    { number: 2, title: 'Season 02 - Entertainment Resort', episodeCount: 11 },
    { number: 3, title: 'Season 03 - Swordsmith Village Arc', episodeCount: 11 },
  ];

  assert.deepEqual(mergeLocalSeasonsWithMetadata(localSeasons, [
    { number: 1, title: 'Unwavering Resolve Arc', episodeCount: 26 },
    { number: 2, title: 'Season 2 - Entertainment District Arc', episodeCount: 11 },
    { number: 3, title: 'Season 3', episodeCount: 11 },
  ]), [
    { number: 1, title: 'Season 1: Unwavering Resolve Arc', episodeCount: 26 },
    { number: 2, title: 'Season 2: Entertainment District Arc', episodeCount: 11 },
    { number: 3, title: 'Season 3', episodeCount: 11 },
  ]);
});

test('meaningful season names from a fallback provider replace generic API names', () => {
  assert.deepEqual(mergeOfficialSeasonMetadata(
    [
      { number: 1, title: 'Season 1', episodeCount: 26 },
      { number: 2, title: 'Season 2', episodeCount: 0 },
    ],
    [
      { number: 1, title: 'Season 1', episodeCount: 26 },
      { number: 2, title: 'Entertainment District Arc', episodeCount: 11 },
    ],
  ), [
    { number: 1, title: 'Season 1', episodeCount: 26 },
    { number: 2, title: 'Entertainment District Arc', episodeCount: 11 },
  ]);
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
