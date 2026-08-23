import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bestSeriesTitleFromEpisodeFiles,
  chooseMetadataSearchTitle,
  mergeEpisodeMetadataSources,
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
      'https://image.tmdb.org/t/p/original/english-best.png',
      'https://image.tmdb.org/t/p/original/english-alt.png',
      'https://image.tmdb.org/t/p/original/no-language.png',
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
      'https://image.tmdb.org/t/p/original/english-0.png',
      'https://image.tmdb.org/t/p/original/english-1.png',
      'https://image.tmdb.org/t/p/original/english-2.png',
      'https://image.tmdb.org/t/p/original/english-3.png',
      'https://image.tmdb.org/t/p/original/english-4.png',
      'https://image.tmdb.org/t/p/original/english-5.png',
    ],
  );
});

test('episode metadata merge fills missing anime ratings from lower-priority sources', () => {
  const [episode] = mergeEpisodeMetadataSources(
    [{
      season: 1,
      number: 1,
      title: 'Local File Title',
      summary: '',
      still: '',
      rating: 0,
      airDate: '',
    }],
    [
      [{
        season: 1,
        number: 1,
        title: 'TVmaze Episode Title',
        summary: '',
        still: '',
        rating: 0,
        airDate: '2024-01-01',
      }],
      [{
        season: 1,
        number: 1,
        title: 'Jikan Episode Title',
        summary: '',
        still: '',
        rating: 8.4,
        airDate: '',
      }],
    ],
  );

  assert.equal(episode.title, 'TVmaze Episode Title');
  assert.equal(episode.rating, 8.4);
  assert.equal(episode.airDate, '2024-01-01');
});

test('episode metadata merge preserves MAL-style episode scores', () => {
  const [episode] = mergeEpisodeMetadataSources(
    [{
      season: 1,
      number: 12,
      title: 'Local File Title',
      summary: '',
      still: '',
      rating: 0,
      airDate: '',
    }],
    [
      [{
        season: 1,
        number: 12,
        title: 'Improvement by Memory',
        summary: '',
        still: '',
        rating: 0,
        airDate: '2014-06-22',
      }],
      [{
        season: 1,
        number: 12,
        title: 'Improvement by Memory',
        summary: '',
        still: '',
        rating: 4.74,
        airDate: '2014-06-22',
      }],
    ],
  );

  assert.equal(episode.rating, 4.74);
});
