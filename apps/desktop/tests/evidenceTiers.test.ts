import assert from 'node:assert/strict';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { migrateDatabase } from '../src/main/databaseMigrations.ts';
import { createDatabaseSegmentsRepository } from '../src/main/databaseSegmentsRepository.ts';
import { mediaSegmentResponseSchema } from '../src/lib/desktopDecoders.ts';
import { resolveCandidates } from '../src/main/skipSegments/normalize.ts';
import type { MediaSegmentCandidate } from '../src/main/skipSegments/types.ts';

function candidate(overrides: Partial<MediaSegmentCandidate> = {}): MediaSegmentCandidate {
  return {
    id: 'candidate',
    mediaId: 'show',
    season: 1,
    episode: 1,
    filePath: '/episode.mkv',
    fileRevision: 'revision',
    type: 'intro',
    startMs: 10_000,
    endMs: 90_000,
    confidence: 0.9,
    source: 'chromaprint',
    status: 'active',
    mediaDurationMs: 1_400_000,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createRepository(): { database: BetterSqlite3.Database; repository: ReturnType<typeof createDatabaseSegmentsRepository> } {
  const database = new BetterSqlite3(':memory:');
  database.pragma('foreign_keys = ON');
  migrateDatabase(database);
  return { database, repository: createDatabaseSegmentsRepository(database) };
}

test('same-source fileVerified candidate beats newer unverified same-source candidate', () => {
  const verified = candidate({
    id: 'verified-old',
    source: 'chromaprint',
    updatedAt: '2026-01-01T00:00:00.000Z',
    analysisMetadata: { fileVerified: true },
  });
  const unverified = candidate({
    id: 'unverified-new',
    source: 'chromaprint',
    updatedAt: '2026-06-01T00:00:00.000Z',
    analysisMetadata: {},
  });
  const resolved = resolveCandidates([unverified, verified]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, 'verified-old');
});

test('cross-source precedence still wins over fileVerified', () => {
  const chapter = candidate({
    id: 'chapter-unverified',
    source: 'chapter',
    updatedAt: '2026-01-01T00:00:00.000Z',
    analysisMetadata: {},
  });
  const chromaprint = candidate({
    id: 'chromaprint-verified',
    source: 'chromaprint',
    updatedAt: '2026-06-01T00:00:00.000Z',
    analysisMetadata: { fileVerified: true },
  });
  const resolved = resolveCandidates([chromaprint, chapter]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, 'chapter-unverified');
});

test('credits keeps multiple same-source intervals', () => {
  const first = candidate({
    id: 'credits-1',
    type: 'credits',
    source: 'chromaprint',
    startMs: 6_000_000,
    endMs: 6_180_000,
    mediaDurationMs: 6_600_000,
    analysisMetadata: { fileVerified: true },
  });
  const second = candidate({
    id: 'credits-2',
    type: 'credits',
    source: 'chromaprint',
    startMs: 6_240_000,
    endMs: null,
    mediaDurationMs: 6_600_000,
    analysisMetadata: {},
  });
  const resolved = resolveCandidates([first, second]);
  assert.deepEqual(
    resolved.map((segment) => segment.id).sort(),
    ['credits-1', 'credits-2'],
  );
});

test('metadata schema accepts and preserves the flag', () => {
  const parsed = mediaSegmentResponseSchema.parse({
    segments: [{
      id: 'candidate',
      type: 'intro',
      startMs: 10_000,
      endMs: 90_000,
      confidence: 0.9,
      source: 'chromaprint',
      mediaDurationMs: 1_400_000,
      updatedAt: '2026-01-01T00:00:00.000Z',
      analysisMetadata: { fileVerified: true },
    }],
    revision: 'revision',
  });
  assert.equal(parsed.segments[0]?.analysisMetadata?.fileVerified, true);

  const { database, repository } = createRepository();
  try {
    repository.replaceSegmentCandidatesForSource('revision', 'chromaprint', [
      candidate({ analysisMetadata: { fileVerified: true } }),
    ]);
    const stored = repository.getSegmentCandidates('revision');
    assert.equal(stored[0]?.analysisMetadata?.fileVerified, true);
  } finally {
    database.close();
  }
});

test('user approval confers fileVerified and rejection clears it', () => {
  const { database, repository } = createRepository();
  try {
    repository.replaceSegmentCandidatesForSource('revision', 'chromaprint', [candidate()]);
    assert.equal(repository.updateSegmentCandidate('candidate', { status: 'active' }), true);
    assert.equal(
      repository.getSegmentCandidates('revision')[0]?.analysisMetadata?.fileVerified,
      true,
    );
    assert.equal(repository.updateSegmentCandidate('candidate', { status: 'rejected' }), true);
    assert.equal(
      repository.getSegmentCandidates('revision')[0]?.analysisMetadata?.fileVerified,
      false,
    );
  } finally {
    database.close();
  }
});

test('source refresh reapplies stored fileVerified alongside the user decision', () => {
  const { database, repository } = createRepository();
  try {
    repository.replaceSegmentCandidatesForSource('revision', 'chromaprint', [candidate()]);
    repository.updateSegmentCandidate('candidate', { status: 'active' });
    repository.replaceSegmentCandidatesForSource('revision', 'chromaprint', [candidate()]);
    const stored = repository.getSegmentCandidates('revision')[0];
    assert.equal(stored?.analysisMetadata?.fileVerified, true);
    assert.equal(stored?.status, 'active');
  } finally {
    database.close();
  }
});
