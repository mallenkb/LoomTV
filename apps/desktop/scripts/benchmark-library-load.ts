import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { migrateDatabase } from '../src/main/databaseMigrations.ts';
import { loadLibrary, saveLibrary } from '../src/main/databaseLibraryRepository.ts';
import type { LibraryData } from '../src/main/appContracts.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';

const [mode, databasePath, variant] = process.argv.slice(2);
const baselineUrl = new URL('../src/main/.benchmark-library-before.ts', import.meta.url);
if (mode === 'fixture') {
  const db = new BetterSqlite3(databasePath);
  migrateDatabase(db);
  const item = (id: string, type: MediaItem['type']): MediaItem => ({
    id, type, title: `Title ${id}`, year: 2026, filePath: `/fixture/${id}.mp4`,
    poster: `https://example.invalid/${id}.jpg`, backdrop: '', summary: 'Fixture description. '.repeat(20),
    rating: 7, genres: ['Drama'], cast: [{ name: 'Actor', character: 'Character', image: '' }],
  });
  const data: LibraryData = {
    movies: Array.from({ length: 10000 }, (_, i) => item(`movie-${i}`, 'movie')),
    tvShows: [], animeShows: [], libraryFolders: ['/fixture'],
    libraryFolderGroups: { movies: ['/fixture'], tvShows: [], anime: [], others: [] }, scanCache: {},
  };
  for (let i = 0; i < 2000; i++) {
    const show = item(`show-${i}`, i % 2 ? 'anime' : 'tv');
    show.seasons = [{ number: 1, title: 'Season 1', episodeCount: 20 }];
    show.episodes = Array.from({ length: 20 }, (_, e) => ({
      season: 1, number: e + 1, title: `Episode ${e + 1}`, summary: 'Episode description. '.repeat(20),
      still: `https://example.invalid/${i}/${e}.jpg`, rating: 7, airDate: '2026-01-01',
    }));
    show.episodeFiles = show.episodes.map(e => ({ season: 1, episode: e.number, filePath: `/fixture/${i}/${e.number}.mp4` }));
    (show.type === 'anime' ? data.animeShows : data.tvShows).push(show);
  }
  saveLibrary(db, data);
  db.close();
} else if (mode === 'measure') {
  const loader = variant === 'before' ? (await import(baselineUrl.href)).loadLibrary : loadLibrary;
  const db = new BetterSqlite3(databasePath, { readonly: true });
  const custom = new Map([['movie-0', new Map([['poster', 'fixture-custom-artwork']])]]);
  global.gc?.();
  const initial = process.memoryUsage();
  const start = performance.now();
  const result = loader(db, custom);
  const durationMs = performance.now() - start;
  const end = process.memoryUsage();
  const peakRssKiB = process.resourceUsage().maxRSS;
  global.gc?.();
  const retainedHeapBytes = process.memoryUsage().heapUsed;
  const checksum = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  db.close();
  console.log(JSON.stringify({ variant, durationMs, initialRssBytes: initial.rss, peakRssKiB,
    heapAfterLoadBytes: end.heapUsed, retainedHeapBytes, checksum }));
} else {
  const output = mode || '/tmp/loom-library-load-benchmark.json';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-library-load-'));
  const db = path.join(dir, 'fixture.sqlite');
  const script = fileURLToPath(import.meta.url);
  const desktop = fileURLToPath(new URL('..', import.meta.url));
  const child = (args: string[]) => execFileSync(process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--expose-gc', script, ...args],
    { cwd: desktop, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  let baselineCreated = false;
  try {
    const baseline = process.env.LOOM_LIBRARY_BASELINE
      ? fs.readFileSync(process.env.LOOM_LIBRARY_BASELINE)
      : execFileSync('git', ['show', 'HEAD:apps/desktop/src/main/databaseLibraryRepository.ts'], { cwd: desktop });
    fs.writeFileSync(baselineUrl, baseline, { flag: 'wx' });
    baselineCreated = true;
    child(['fixture', db]);
    const runs = [];
    for (let pair = 0; pair < 3; pair++) {
      for (const version of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        runs.push(JSON.parse(child(['measure', db, version])));
      }
    }
    assert.equal(new Set(runs.map(r => r.checksum)).size, 1, 'Library output differs');
    const report = { timestamp: new Date().toISOString(), node: process.version,
      fixture: { videos: 50000, movies: 10000, shows: 2000, episodes: 40000 },
      note: 'Fresh processes, alternating order, warm filesystem cache; RSS includes Node and SQLite. Peak sampled before output serialization. Not whole-app memory.', runs };
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, identicalResults: true, runs }));
  } finally {
    if (baselineCreated) fs.rmSync(baselineUrl, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
