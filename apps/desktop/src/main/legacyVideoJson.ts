import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { lanMediaItemSchema } from '@loom-media-server/lan-protocol';
import { createMediaItemId } from '@loom-media-server/media-core';
import { normalizeLibraryFolderGroups, flattenLibraryFolders } from './libraryFolders.ts';
import { saveLibrary } from './databaseLibraryRepository.ts';
import type { LibraryData } from './appContracts.ts';

const item = lanMediaItemSchema.extend({
  year: z.number().finite().default(0),
  poster: z.string().default(''),
  backdrop: z.string().default(''),
  summary: z.string().default(''),
  rating: z.number().finite().default(0),
  genres: z.array(z.string()).default([]),
  filePath: z.string().min(1),
});
const folders = z.array(z.string().min(1).max(8192));
const snapshot = z.object({
  movies: z.array(z.unknown()).default([]),
  tvShows: z.array(z.unknown()).default([]),
  animeShows: z.array(z.unknown()).default([]),
  libraryFolders: folders.default([]),
  scanCache: z
    .record(
      z.string(),
      z.object({
        version: z.number().finite().optional(),
        folderKind: z.enum(['movies', 'tv', 'anime', 'auto']),
        signature: z.string(),
        subtitleProfile: z.string().optional(),
        fileCount: z.number().finite().nonnegative(),
        itemCount: z.number().finite().nonnegative(),
        scannedAt: z.number().finite().nonnegative(),
        ratingsRefreshedAt: z.number().finite().nonnegative().optional(),
        childSignatures: z.record(z.string().max(4096), z.string().max(256)).optional(),
      }),
    )
    .default({}),
  libraryFolderGroups: z
    .object({
      movies: folders.default([]),
      tvShows: folders.default([]),
      anime: folders.default([]),
      others: folders.default([]),
    })
    .optional(),
});

/** Legacy JSON is an input to staging only. Normal operation never reads it. */
export function importLegacyVideoJson(database: BetterSqlite3.Database, file: string): void {
  if (fs.statSync(file).size > 128 * 1024 * 1024)
    throw new Error('The legacy video JSON exceeds the supported migration size.');
  const parsed = snapshot.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const groups = normalizeLibraryFolderGroups({
    libraryFolders: parsed.libraryFolders,
    libraryFolderGroups: parsed.libraryFolderGroups,
  });
  const library: LibraryData = {
    movies: [],
    tvShows: [],
    animeShows: [],
    libraryFolderGroups: groups,
    libraryFolders: flattenLibraryFolders(groups),
    scanCache: parsed.scanCache,
  };
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [collection, type] of [
    ['movies', 'movie'],
    ['tvShows', 'tv'],
    ['animeShows', 'anime'],
  ] as const) {
    for (const value of parsed[collection]) {
      if (
        !value ||
        typeof value !== 'object' ||
        !('filePath' in value) ||
        typeof value.filePath !== 'string' ||
        !value.filePath
      ) {
        throw new Error('A legacy video record has no valid file identity.');
      }
      const record = item.parse({ id: createMediaItemId(value.filePath), type, ...value });
      if (ids.has(record.id) || paths.has(record.filePath)) {
        throw Object.assign(new Error('Legacy video records contain conflicting file identities.'), {
          code: 'video_media_identity_conflict',
        });
      }
      ids.add(record.id);
      paths.add(record.filePath);
      const anime =
        record.type === 'anime' ||
        groups.anime.some((root) => {
          const relative = path.relative(root, record.filePath);
          return (
            !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
          );
        });
      if (anime) library.animeShows.push({ ...record, type: 'anime' });
      else if (record.type === 'tv') library.tvShows.push(record);
      else library.movies.push(record);
    }
  }
  saveLibrary(database, library);
}
