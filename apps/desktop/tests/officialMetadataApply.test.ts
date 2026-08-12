import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryData } from '../src/main/appContracts.ts';
import {
  createOfficialMetadataService,
  type OfficialMetadataCandidate,
  type OfficialMetadataServiceDependencies,
} from '../src/main/officialMetadataService.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';

function animeShow(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'anime-1',
    type: 'anime',
    title: 'Kimetsu no Yaiba',
    year: 2019,
    poster: 'poster.jpg',
    backdrop: 'backdrop.jpg',
    summary: 'Stale summary',
    rating: 3.4,
    providerRatings: { imdb: { value: 3.4, scale: 10 } },
    genres: ['Animation'],
    cast: [],
    filePath: '/library/anime',
    ...overrides,
  } as MediaItem;
}

function candidate(overrides: Partial<OfficialMetadataCandidate> = {}): OfficialMetadataCandidate {
  return {
    id: 'candidate-1',
    source: 'TMDB',
    title: 'Demon Slayer: Kimetsu no Yaiba',
    year: 2019,
    rating: 8.6,
    thumbnail: 'tmdb-poster.jpg',
    cover: 'tmdb-backdrop.jpg',
    summary: 'Fresh summary',
    genres: ['Animation', 'Action & Adventure'],
    ...overrides,
  };
}

type ServiceHarness = {
  service: ReturnType<typeof createOfficialMetadataService>;
  saved: MediaItem[];
  omdbById: string[];
};

function createHarness(item: MediaItem, omdbResponse: Record<string, unknown> | null = null): ServiceHarness {
  const library: LibraryData = { movies: [], tvShows: [], animeShows: [item] } as LibraryData;
  const saved: MediaItem[] = [];
  const omdbById: string[] = [];
  const noop = () => undefined;
  const none = async () => null;
  const empty = async () => [];

  const deps = {
    loadLibrary: () => library,
    saveLibraryItem: (saveItem: MediaItem) => {
      saved.push(JSON.parse(JSON.stringify(saveItem)) as MediaItem);
    },
    getMetadataRefreshState: () => null,
    recordMetadataRefresh: noop,
    cacheArtworkNow: async () => undefined,
    loadSettings: () => ({ metadataApiKeys: { omdb: 'omdb-key' } }),
    getMetadataApiKey: (_settings: unknown, provider: string) => (provider === 'omdb' ? 'omdb-key' : ''),
    localTitleFromPath: () => null,
    probeMediaFile: () => ({}),
    fetchAniListAnimeMetadata: none,
    fetchFanartMovieLogos: empty,
    fetchFanartTVLogos: empty,
    fetchJikanMetadata: none,
    fetchJikanMetadataCandidates: empty,
    fetchOMDbMetadata: none,
    fetchOMDbMetadataById: async (imdbId?: string) => {
      if (imdbId) omdbById.push(imdbId);
      return omdbResponse;
    },
    fetchTMDBMovieMetadata: none,
    fetchTMDBMovieMetadataById: none,
    fetchTMDBMovieMetadataCandidates: empty,
    fetchTMDBStreamingProvidersById: empty,
    fetchTMDBTVMetadata: none,
    fetchTMDBTVMetadataById: none,
    fetchTMDBTVMetadataCandidates: empty,
    fetchTVMetadata: none,
    fetchTVMetadataCandidates: empty,
    artworkDeliveryUrl: (source?: string | null) => source || '',
    artworkDeliveryUrls: (sources?: string[]) => sources || [],
    orderedArtworkCandidates: (...urls: Array<string | null | undefined>) => [
      ...new Set(urls.filter((url): url is string => Boolean(url))),
    ],
  } as unknown as OfficialMetadataServiceDependencies;

  return { service: createOfficialMetadataService(deps), saved, omdbById };
}

test('applying a candidate whose source has no provider scores drops the stale ones', async () => {
  const { service, saved } = createHarness(animeShow());

  const result = await service.applyOfficialMetadataCandidate('anime-1', candidate());

  assert.equal(result.rating, 8.6);
  assert.deepEqual(result.providerRatings, {});
  assert.equal(saved.length, 1);
  assert.equal(saved[0].rating, 8.6);
  assert.deepEqual(saved[0].providerRatings, {});
});

test('applying a candidate looks its scores up by the id the match came with', async () => {
  const { service, saved, omdbById } = createHarness(animeShow(), {
    Response: 'True',
    imdbRating: '8.6',
    imdbVotes: '132,000',
    Metascore: '82',
  });

  const result = await service.applyOfficialMetadataCandidate('anime-1', candidate({
    providerIds: { imdbId: 'tt9335498' },
  }));

  assert.deepEqual(omdbById, ['tt9335498']);
  assert.deepEqual(result.providerRatings?.imdb, { value: 8.6, scale: 10, votes: 132000 });
  assert.deepEqual(saved[0].providerRatings?.metacritic, { value: 82, scale: 100 });
  assert.equal(saved[0].providerIds?.imdbId, 'tt9335498');
});

test('an OMDb candidate applies the scores it already carries', async () => {
  const { service, saved, omdbById } = createHarness(animeShow());

  const result = await service.applyOfficialMetadataCandidate('anime-1', candidate({
    source: 'OMDb',
    rating: 8.5,
    providerIds: { imdbId: 'tt9335498' },
    providerRatings: { imdb: { value: 8.5, scale: 10, votes: 130000 } },
  }));

  assert.deepEqual(omdbById, []);
  assert.equal(result.rating, 8.5);
  assert.deepEqual(saved[0].providerRatings, { imdb: { value: 8.5, scale: 10, votes: 130000 } });
});

test('a candidate with no rating at all leaves the stored scores alone', async () => {
  const { service, saved } = createHarness(animeShow());

  const result = await service.applyOfficialMetadataCandidate('anime-1', candidate({
    source: 'TVmaze',
    rating: 0,
  }));

  assert.equal(result.rating, 3.4);
  assert.deepEqual(saved[0].providerRatings, { imdb: { value: 3.4, scale: 10 } });
});

test('applying only the poster leaves ratings untouched', async () => {
  const { service, saved } = createHarness(animeShow());

  const result = await service.applyOfficialMetadataCandidate('anime-1', candidate(), 'poster');

  assert.equal(result.rating, 3.4);
  assert.deepEqual(saved[0].providerRatings, { imdb: { value: 3.4, scale: 10 } });
});
