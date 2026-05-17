import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bestSeriesTitleFromEpisodeFiles,
  chooseMetadataSearchTitle,
  seriesTitleFromEpisodeFileName,
  tmdbLogoCandidates,
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

test('tmdb logo candidates prefer English transparent title art', () => {
  assert.deepEqual(
    tmdbLogoCandidates({
      images: {
        logos: [
          { file_path: '/no-language.png', iso_639_1: null, vote_average: 8 },
          { file_path: '/spanish.png', iso_639_1: 'es', vote_average: 10 },
          { file_path: '/english-best.png', iso_639_1: 'en', vote_average: 7 },
          { file_path: '/english-alt.png', iso_639_1: 'en', vote_average: 4 },
        ],
      },
    }),
    [
      'https://image.tmdb.org/t/p/w500/english-best.png',
      'https://image.tmdb.org/t/p/w500/english-alt.png',
      'https://image.tmdb.org/t/p/w500/no-language.png',
    ],
  );
});

test('tmdb logo candidates keep only the best few fallback images', () => {
  const logos = Array.from({ length: 10 }, (_, index) => ({
    file_path: `/english-${index}.png`,
    iso_639_1: 'en',
    vote_average: 10 - index,
  }));

  assert.deepEqual(
    tmdbLogoCandidates({ images: { logos } }),
    [
      'https://image.tmdb.org/t/p/w500/english-0.png',
      'https://image.tmdb.org/t/p/w500/english-1.png',
      'https://image.tmdb.org/t/p/w500/english-2.png',
      'https://image.tmdb.org/t/p/w500/english-3.png',
      'https://image.tmdb.org/t/p/w500/english-4.png',
      'https://image.tmdb.org/t/p/w500/english-5.png',
    ],
  );
});
