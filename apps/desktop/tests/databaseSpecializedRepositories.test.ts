import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import type { LibraryData } from '../src/main/appContracts.ts';
import { createDatabaseArtworkRepository } from '../src/main/databaseArtworkRepository.ts';
import { migrateDatabase } from '../src/main/databaseMigrations.ts';
import {
  listProfileStremioAccess,
  saveStremioAddonState,
  setProfileStremioAccess,
} from '../src/main/databasePluginRepository.ts';
import { createProfile } from '../src/main/databaseProfilesRepository.ts';
import { createDatabaseSegmentsRepository } from '../src/main/databaseSegmentsRepository.ts';
import type { MediaSegmentCandidate, ProviderCacheEntry } from '../src/main/skipSegments/types.ts';
import type { SegmentAnalysisJob } from '../src/main/skipSegments/analysisJobs.ts';

function createDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3(':memory:');
  database.pragma('foreign_keys = ON');
  migrateDatabase(database);
  return database;
}

function candidate(overrides: Partial<MediaSegmentCandidate> = {}): MediaSegmentCandidate {
  return {
    id: 'candidate',
    mediaId: 'show',
    season: 1,
    episode: 1,
    filePath: '/library/show.s01e01.mkv',
    fileRevision: 'revision',
    type: 'intro',
    startMs: 1_000,
    endMs: 60_000,
    confidence: 0.9,
    source: 'chapter',
    status: 'active',
    mediaDurationMs: 2_400_000,
    updatedAt: '2026-07-16T12:00:00.000Z',
    ...overrides,
  };
}

test('segment repository preserves provider cache, resolution, fingerprints, and analysis state', () => {
  const database = createDatabase();
  const repository = createDatabaseSegmentsRepository(database);
  try {
    const cache: ProviderCacheEntry = {
      provider: 'theintrodb',
      lookupKey: 'series:episode',
      durationBucket: 40,
      status: 'success',
      segments: [{ type: 'intro', startMs: 1_000, endMs: 60_000, source: 'theintrodb', confidence: 0.8 }],
      fetchedAt: 100,
      expiresAt: 200,
      staleUntil: 300,
    };
    repository.saveSegmentSourceCache(cache);
    assert.deepEqual(repository.getSegmentSourceCache('theintrodb', 'series:episode', 40), cache);

    const resolved = repository.replaceSegmentCandidatesForSource('revision', 'chapter', [candidate()]);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].id, 'candidate');
    assert.deepEqual(repository.getSegmentCandidates('revision').map((entry) => entry.id), ['candidate']);

    repository.saveMediaFingerprint({
      fileRevision: 'revision',
      audioTrack: 1,
      windowType: 'intro',
      algorithmVersion: 'v1',
      fingerprintJson: '[1,2,3]',
      durationMs: 50_000,
      updatedAt: 123,
    });
    assert.equal(repository.getMediaFingerprint('revision', 1, 'intro', 'v1')?.fingerprintJson, '[1,2,3]');

    repository.saveSegmentAnalysisState('show:1', 'show', 1, 'complete', 'matched');
    assert.deepEqual(repository.getSegmentAnalysisStates('show').map((state) => ({
      jobKey: state.jobKey,
      state: state.state,
      detail: state.detail,
    })), [{ jobKey: 'show:1', state: 'complete', detail: 'matched' }]);
  } finally {
    database.close();
  }
});

test('a manual analysis request supersedes every parked request for the same revision', () => {
  const database = createDatabase();
  const repository = createDatabaseSegmentsRepository(database);
  const job = (jobKey: string, kind: SegmentAnalysisJob['kind'], state: SegmentAnalysisJob['state']): SegmentAnalysisJob => ({
    jobKey, kind, state, mediaId: 'show', season: 1, episode: 1, fileRevision: 'revision',
    configHash: 'config', detail: '', createdAt: 1, updatedAt: 1,
  });
  try {
    repository.enqueueSegmentAnalysisJob(job('incremental', 'incremental', 'pending'));
    repository.enqueueSegmentAnalysisJob(job('manual-old', 'manual', 'waiting_for_peers'));
    repository.enqueueSegmentAnalysisJob(job('manual-new', 'manual', 'pending'));
    const states = new Map(repository.getSegmentAnalysisJobs().map((entry) => [entry.jobKey, entry.state]));
    assert.equal(states.get('incremental'), 'cancelled');
    assert.equal(states.get('manual-old'), 'cancelled');
    assert.equal(states.get('manual-new'), 'pending');
  } finally {
    database.close();
  }
});

test('Stremio persistence revokes profile grants when an add-on is disabled or re-reviewed', () => {
  const database = createDatabase();
  try {
    const profile = createProfile(database, { name: 'Standard profile' });
    const record = {
      addonId: 'org.example.catalog',
      state: 'enabled' as const,
      reviewToken: 'review-one',
    };
    saveStremioAddonState(database, { stateVersion: 1, addons: [record] });
    assert.equal(setProfileStremioAccess(database, profile.id, record.addonId, true), true);
    assert.deepEqual(listProfileStremioAccess(database, profile.id), [record.addonId]);

    saveStremioAddonState(database, {
      stateVersion: 1,
      addons: [{ ...record, state: 'pending-review', reviewToken: 'review-two' }],
    });
    assert.deepEqual(
      listProfileStremioAccess(database, profile.id),
      [],
      'a new review must not inherit a standard profile grant from an older approval',
    );
  } finally {
    database.close();
  }
});

test('manual segment repository keeps history-backed delete and undo behavior', () => {
  const database = createDatabase();
  const repository = createDatabaseSegmentsRepository(database);
  try {
    const manual = candidate({ id: 'manual', source: 'manual', confidence: 1 });
    assert.equal(repository.saveManualSegmentCandidate(manual)[0].id, 'manual');
    assert.deepEqual(repository.getManualSegmentCandidates('show', 1, 1).map((entry) => entry.id), ['manual']);
    assert.deepEqual(repository.deleteManualSegmentCandidate('revision', 'intro'), []);
    assert.equal(repository.undoManualSegmentCandidate('revision', 'intro')[0].id, 'manual');
  } finally {
    database.close();
  }
});

function artworkLibrary(sourceUrl: string): LibraryData {
  return {
    movies: [{
      id: 'movie',
      type: 'movie',
      title: 'Movie',
      year: 2026,
      poster: sourceUrl,
      backdrop: '',
      summary: '',
      rating: 0,
      genres: [],
      cast: [],
      filePath: '/library/movie.mkv',
    }],
    tvShows: [],
    animeShows: [],
    libraryFolders: ['/library'],
  };
}

test('artwork repository persists custom artwork and maintains the disk cache through an injected fetcher', async (t) => {
  const database = createDatabase();
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-artwork-repository-'));
  t.after(() => {
    database.close();
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  });
  const fetched: string[] = [];
  const repository = createDatabaseArtworkRepository(database, {
    cacheDirectory,
    fetchArtworkBytes: async (sourceUrl) => {
      fetched.push(sourceUrl);
      const bytes = Buffer.from(`image:${sourceUrl}`);
      return {
        bytes,
        mimeType: 'image/png',
        byteLength: bytes.byteLength,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
      };
    },
  });

  repository.importCustomArtwork({ movie: { poster: 'data:image/png;base64,poster', empty: '' } });
  assert.deepEqual(repository.getCustomArtwork('movie'), { poster: 'data:image/png;base64,poster' });
  assert.equal(repository.getCustomArtworkData('movie', 'poster')?.dataUrl, 'data:image/png;base64,poster');
  assert.equal(repository.getCustomArtworkMap().get('movie')?.get('poster'), 'data:image/png;base64,poster');

  const firstUrl = 'https://image.tmdb.org/first.png';
  const first = await repository.cacheArtworkSource(firstUrl);
  assert.ok(first?.cachePath && fs.existsSync(first.cachePath));
  assert.equal((await repository.cacheArtworkSource(firstUrl))?.cachePath, first?.cachePath);
  assert.deepEqual(fetched, [firstUrl]);

  const secondUrl = 'https://image.tmdb.org/second.png';
  await repository.cacheLibraryArtwork(artworkLibrary(secondUrl));
  assert.equal(repository.getCachedArtwork(firstUrl), null);
  assert.ok(repository.getCachedArtwork(secondUrl)?.cachePath);
  assert.equal(first?.cachePath ? fs.existsSync(first.cachePath) : true, false);
  assert.deepEqual(fetched, [firstUrl, secondUrl]);
});
