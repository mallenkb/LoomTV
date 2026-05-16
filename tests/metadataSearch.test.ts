import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bestSeriesTitleFromEpisodeFiles,
  chooseMetadataSearchTitle,
  seriesTitleFromEpisodeFileName,
} from '../src/main/metadata/helpers.ts';

test('series title extraction uses episode file names, not episode titles', () => {
  assert.equal(seriesTitleFromEpisodeFileName('/Anime/Baby Steps/Season 1/Baby Steps - S01E01.mkv'), 'Baby Steps');
  assert.equal(seriesTitleFromEpisodeFileName('/Anime/Baby Steps/Season 2/Baby Steps 2 - S02E20.mkv'), 'Baby Steps 2');
});

test('metadata lookup keeps the show title ahead of episode-name noise', () => {
  const episodeSeriesTitle = bestSeriesTitleFromEpisodeFiles([
    { filePath: '/Anime/Baby Steps/Season 1/Baby Steps - S01E01.mkv' },
    { filePath: '/Anime/Baby Steps/Season 1/Baby Steps - S01E02.mkv' },
    { filePath: '/Anime/Baby Steps/Season 2/Baby Steps 2 - S02E20.mkv' },
  ]);

  assert.equal(episodeSeriesTitle, 'Baby Steps');
  assert.equal(
    chooseMetadataSearchTitle({
      itemTitle: 'Baby Steps',
      folderTitle: 'Baby Steps',
      parsedPathTitle: 'Baby Steps S01E01',
      episodeSeriesTitle: 'Psychological Warfare and Self-Control',
      fallbackTitle: 'Baby Steps',
    }),
    'Baby Steps',
  );
});

test('metadata lookup can recover from a wrong applied title by trusting the folder title', () => {
  assert.equal(
    chooseMetadataSearchTitle({
      itemTitle: '[C] CONTROL - The Money and Soul of Possibility',
      folderTitle: 'Baby Steps',
      parsedPathTitle: 'Baby Steps S01E01',
      fallbackTitle: '[C] CONTROL - The Money and Soul of Possibility',
    }),
    'Baby Steps',
  );
});
