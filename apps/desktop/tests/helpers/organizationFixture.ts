import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type BetterSqlite3 from 'better-sqlite3';
import type { TestContext } from 'node:test';
import { migrateDatabase } from '../../src/main/databaseMigrations.ts';
import { createImportInventory } from '../../src/main/fileRename/importInventory.ts';
import { createRenameExecutor } from '../../src/main/fileRename/renameExecutor.ts';
import type { MediaItem } from '../../src/main/metadata/types.ts';
import type { LibraryData } from '../../src/main/appContracts.ts';

export function organizationFixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-restore-original-'));
  const root = path.join(directory, 'library');
  fs.mkdirSync(root);
  const sqlite = new DatabaseSync(':memory:');
  let transactionId = 0;
  const database = {
    prepare: sqlite.prepare.bind(sqlite), exec: sqlite.exec.bind(sqlite),
    pragma: (source: string) => sqlite.prepare(`PRAGMA ${source}`).all(),
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      const name = `operation_${++transactionId}`;
      sqlite.exec(`SAVEPOINT ${name}`);
      try { const result = fn(...args); sqlite.exec(`RELEASE ${name}`); return result; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    },
  } as unknown as BetterSqlite3.Database;
  migrateDatabase(database);
  t.after(() => { sqlite.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const file = (name: string, contents = 'video') => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    return target;
  };
  const item = (filePath: string, fields: Partial<MediaItem> = {}) => ({
    id: filePath, type: 'movie', title: 'Runner', year: 2026, filePath,
    poster: '', backdrop: '', summary: '', rating: 0, genres: [], providerIds: { tmdbId: '123' }, ...fields,
  }) as MediaItem;
  let data = { movies: [], tvShows: [], animeShows: [], libraryFolders: [root] } as LibraryData;
  const inventory = createImportInventory(() => database);
  const executor = createRenameExecutor({
    getDatabase: () => database, inventory, loadLibrary: () => data,
    saveLibraryMutation: (next) => { data = next; }, remapMediaIds: () => undefined,
    isScanRunning: () => false, libraryRoots: () => [root],
  });
  return { directory, root, file, item, database, inventory, executor,
    data: () => data, setItems: (items: MediaItem[]) => { data = { ...data, movies: items.filter((value) => value.type === 'movie'), tvShows: items.filter((value) => value.type === 'tv'), animeShows: items.filter((value) => value.type === 'anime') }; },
    organize: () => executor.apply(executor.plan().entries.map((entry) => entry.id)),
  };
}
