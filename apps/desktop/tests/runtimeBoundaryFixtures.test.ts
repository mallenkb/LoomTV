import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  lanLibraryIndexSchema,
  lanLibraryCardSchema,
  parseJsonResponse,
} from '@loom-media-server/lan-protocol';
import { parseDatabaseRow, DatabaseRowValidationError } from '../src/main/databaseRows.ts';
import { parseIpcArguments, IpcArgumentValidationError } from '../src/main/ipcValidation.ts';
import { tmdbListResponseSchema } from '../src/lib/tmdbSchemas.ts';

const invalidJsonFixtures = [
  { name: 'truncated JSON', input: '{"catalogVersion":1' },
  { name: 'non-JSON text', input: '<html>upstream error</html>' },
] as const;

for (const fixture of invalidJsonFixtures) {
  test(`LAN decoder rejects ${fixture.name} with boundary context`, () => {
    assert.throws(
      () => parseJsonResponse(
        fixture.input,
        lanLibraryIndexSchema(lanLibraryCardSchema),
        'Library index',
      ),
      /Library index returned invalid JSON/,
    );
  });
}

const invalidLibraryPayloads = [
  { catalogVersion: 2, revision: 1, movies: [], tvShows: [], animeShows: [] },
  { catalogVersion: 1, revision: -1, movies: [], tvShows: [], animeShows: [] },
  { catalogVersion: 1, revision: 1, movies: [{}], tvShows: [], animeShows: [] },
] as const;

for (const [index, payload] of invalidLibraryPayloads.entries()) {
  test(`LAN decoder rejects invalid library payload ${index + 1}`, () => {
    assert.throws(
      () => parseJsonResponse(
        JSON.stringify(payload),
        lanLibraryIndexSchema(lanLibraryCardSchema),
        'Library index',
      ),
      /Library index returned an invalid payload/,
    );
  });
}

test('provider schemas reject malformed TMDB list results', () => {
  assert.equal(tmdbListResponseSchema.safeParse({ results: [{ id: 'not-a-number' }] }).success, false);
});

test('database rows fail locally with a named repository error', () => {
  assert.throws(
    () => parseDatabaseRow({ id: 42 }, z.object({ id: z.string() }), 'media item'),
    (error: unknown) => error instanceof DatabaseRowValidationError
      && error.message === 'The media item database row has an invalid shape.',
  );
});

test('IPC tuple validation rejects malformed calls with the channel name', () => {
  assert.throws(
    () => parseIpcArguments('library:get-item', [42], z.tuple([z.string().min(1)])),
    (error: unknown) => error instanceof IpcArgumentValidationError
      && error.message.includes('library:get-item'),
  );
});
