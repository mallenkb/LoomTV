import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import BetterSqlite3 from 'better-sqlite3';
import { migrateDatabase } from '../src/main/databaseMigrations.ts';
import { saveLibrary, saveLibraryScanDelta } from '../src/main/databaseLibraryRepository.ts';
import { planScanDelta } from '../src/main/scanning/scanPersistence.ts';
import type { LibraryData } from '../src/main/appContracts.ts';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-db-benchmark-'));
const rows = [];
try {
  for (const count of [1000, 10000, 50000]) {
    const data: LibraryData = { movies: Array.from({ length: count }, (_, index) => ({ id: String(index), type: 'movie', title: `Movie ${index}`, filePath: path.join(directory, 'library', `${index}.mp4`), year: 2026, poster: '', backdrop: '', summary: '', rating: 0, genres: [], cast: [] })), tvShows: [], animeShows: [], libraryFolderGroups: { movies: [path.join(directory, 'library')], tvShows: [], anime: [], others: [] }, scanCache: {} };
    for (const mode of ['replacement', 'delta']) {
      const database = new BetterSqlite3(path.join(directory, `${count}-${mode}.sqlite`));
      database.pragma('foreign_keys = ON'); migrateDatabase(database); saveLibrary(database, data);
      try {
        for (let repetition = 0; repetition < 5; repetition++) {
          const before = (database.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
          const start = performance.now();
          if (mode === 'replacement') saveLibrary(database, data);
          else { const delta = planScanDelta(data, structuredClone(data), [path.join(directory, 'library')]); saveLibraryScanDelta(database, delta.changed, delta.removed, {}); }
          const milliseconds = performance.now() - start;
          const changes = (database.prepare('SELECT total_changes() AS n').get() as { n: number }).n - before;
          rows.push({ count, mode, repetition, milliseconds, changes });
        }
      } finally { database.close(); }
    }
  }
} finally { await fs.rm(directory, { recursive: true, force: true }); }
await fs.writeFile(process.argv[2] || '/tmp/loom-scan-persistence-benchmark.json', JSON.stringify(rows, null, 2));
