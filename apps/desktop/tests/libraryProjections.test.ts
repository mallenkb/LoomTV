import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryData, LibraryFolderGroups } from '../src/main/appContracts.ts';
import {
  createLibraryDeliveryProjections,
  stripInlineArtworkFromLibrary,
} from '../src/main/libraryProjections.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';

function mediaItem(): MediaItem {
  return {
    id: 'show',
    type: 'tv',
    title: 'Show',
    year: 2026,
    poster: 'poster.jpg',
    backdrop: 'backdrop.jpg',
    logo: 'logo.png',
    posterCandidates: ['poster.jpg', 'poster-2.jpg'],
    backdropCandidates: ['backdrop.jpg'],
    logoCandidates: ['logo.png'],
    summary: 'Summary',
    rating: 8,
    genres: ['Drama'],
    cast: [],
    filePath: '/library/show',
    localMetadata: { audioTracks: 1 },
    subtitles: [{ lang: 'en', label: 'English', url: '/library/show.en.srt' }],
    episodes: [{
      season: 1,
      number: 1,
      title: 'Pilot',
      summary: '',
      still: 'still.jpg',
      rating: 0,
      airDate: '',
    }],
    episodeFiles: [{
      season: 1,
      episode: 1,
      filePath: '/library/show.s01e01.mkv',
      subtitles: [{ lang: 'en', label: 'English', url: '/library/show.s01e01.en.srt' }],
      localMetadata: { subtitleTracks: 1 },
    }],
  };
}

function library(item = mediaItem()): LibraryData {
  return {
    movies: [],
    tvShows: [item],
    animeShows: [],
    libraryFolders: ['/library'],
    libraryFolderGroups: { movies: [], tvShows: ['/library'], anime: [], others: [] },
    scanCache: {},
  };
}

function projections() {
  const defaultGroups: LibraryFolderGroups = { movies: [], tvShows: [], anime: [], others: [] };
  return createLibraryDeliveryProjections({
    artworkDeliveryUrl: (source) => source ? `delivered:${source}` : '',
    artworkDeliveryUrls: (sources) => (sources || []).map((source) => `delivered:${source}`),
    remoteArtworkDeliveryUrl: (source, base) => source ? `${base}/remote/${source}` : '',
    subtitleRecordsForRenderer: (subtitles) => subtitles?.map((subtitle) => ({ ...subtitle, url: `renderer:${subtitle.url}` })),
    subtitleRecordsForLocalNetwork: (subtitles, base) => subtitles?.map((subtitle) => ({ ...subtitle, url: `${base}/subtitle/${subtitle.lang}` })),
    getRemoteThumbnailUrl: (filePath, base) => `${base}/thumbnail/${encodeURIComponent(filePath)}`,
    signedStreamUrlForRemote: (base, filePath) => `${base}/stream/${encodeURIComponent(filePath)}`,
    localMetadataWithTracks: (_filePath, metadata) => ({ ...metadata, tracks: [] }),
    normalizeLibraryFolderGroups: (data) => data?.libraryFolderGroups || defaultGroups,
    flattenLibraryFolders: (groups) => [...groups.movies, ...groups.tvShows, ...groups.anime, ...groups.others],
    libraryFolderStatusesFor: (groups) => [...groups.movies, ...groups.tvShows, ...groups.anime, ...groups.others].map((folder) => ({
      path: folder,
      kind: 'tvShows' as const,
      state: 'available' as const,
      isNetworkLike: false,
      checkedAt: 1,
      message: '',
    })),
  });
}

test('durable projection removes inline artwork without mutating library input', () => {
  const original = mediaItem();
  const episode = original.episodes?.[0];
  assert.ok(episode);
  const input = library({
    ...original,
    poster: 'data:image/png;base64,poster',
    posterCandidates: ['data:image/png;base64,poster', ' https://example.test/poster.jpg '],
    episodes: [{ ...episode, still: 'data:image/png;base64,still' }],
  });

  const result = stripInlineArtworkFromLibrary(input);

  assert.equal(result.tvShows[0].poster, '');
  assert.deepEqual(result.tvShows[0].posterCandidates, ['https://example.test/poster.jpg']);
  assert.equal(result.tvShows[0].episodes?.[0].still, '');
  assert.match(input.tvShows[0].poster, /^data:/);
});

test('renderer and LAN projections preserve media fields while rewriting delivery-only data', () => {
  const input = library();
  const projection = projections();

  const renderer = projection.libraryForRenderer(input);
  assert.equal(renderer.tvShows[0].poster, 'delivered:poster.jpg');
  assert.equal(renderer.tvShows[0].subtitles?.[0].url, 'renderer:/library/show.en.srt');
  assert.deepEqual(renderer.libraryFolders, ['/library']);
  assert.equal(renderer.libraryFolderStatuses?.[0].state, 'available');

  const lan = projection.libraryForLocalNetwork(input, 'http://loom.local');
  assert.deepEqual(lan.libraryFolders, []);
  assert.deepEqual(lan.libraryFolderGroups, { movies: [], tvShows: [], anime: [], others: [] });
  assert.equal(lan.tvShows[0].filePath, 'http://loom.local/stream/%2Flibrary%2Fshow');
  assert.equal(lan.tvShows[0].episodeFiles?.[0].still, 'http://loom.local/remote/delivered:still.jpg');
  assert.equal(lan.tvShows[0].episodeFiles?.[0].subtitles?.[0].url, 'http://loom.local/subtitle/en');
  assert.deepEqual(lan.tvShows[0].localMetadata?.tracks, []);
  assert.equal(input.tvShows[0].filePath, '/library/show');
});
