import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import BetterSqlite3 from 'better-sqlite3';
import { migrateDatabase } from '../src/main/databaseMigrations.ts';
import { saveLibrary, saveLibraryScanDelta } from '../src/main/databaseLibraryRepository.ts';
import { discoverLibraryRoot, fingerprintLibraryRoot, inspectLibraryRoot } from '../src/main/scanning/discover.ts';
import { planScanDelta } from '../src/main/scanning/scanPersistence.ts';
import { canCheckUnchangedRoot } from '../src/main/scanning/quickScanCache.ts';
import { createMediaItemId } from '../src/main/libraryItemHelpers.ts';
import { scanInventory } from '../src/main/scanning/inventory.ts';
import { scanEpisodeFilesAsync } from '../src/main/libraryScanFiles.ts';
import type { LibraryData } from '../src/main/appContracts.ts';
import type { EpisodeFile, MediaItem } from '../src/main/metadata/types.ts';

const run = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, '..');
const binary = path.join(desktop, 'native/scanner/target/release/loom-scanner' + (process.platform === 'win32' ? '.exe' : ''));
const baselineRevision = process.env.LOOM_SCAN_BASELINE || 'cd042e2ace4e2661ecb8cf65273e120adca8caf1';

if (process.argv[2] === '--sample') {
  const engine = process.argv[3]; const fixture = process.argv[4]; const phase = process.argv[5];
  const baselinePath = path.join(desktop, 'src/main', `.scan-pipeline-baseline-${process.pid}.ts`);
  const database = new BetterSqlite3(':memory:');
  database.pragma('foreign_keys = ON'); migrateDatabase(database);
  const empty = (): LibraryData => ({ movies: [], tvShows: [], animeShows: [],
    libraryFolderGroups: { movies: [fixture], tvShows: [], anime: [], others: [] },
    libraryFolders: [fixture], scanCache: {} });
  let current = empty();
  try {
    let baseline;
    if (engine === 'baseline') {
      await fs.writeFile(baselinePath, execFileSync('git', ['show', `${baselineRevision}:apps/desktop/src/main/libraryScanFiles.ts`], { cwd: desktop, encoding: 'utf8' }));
      baseline = await import(pathToFileURL(baselinePath).href);
    }
    const measure = async () => {
      const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const started = performance.now();
      let providerCalls = 0; let probes = 0; let childPeakRssBytes = 0;
      let directories: number | undefined; let stats: number | undefined;
      let signature: { signature: string; fileCount: number } | null;
      let inventory: Awaited<ReturnType<typeof discoverLibraryRoot>>['inventory'] | undefined;
      if (engine === 'baseline') signature = await baseline.getLibraryFolderSignatureAsync(fixture);
      else {
        const cached = current.scanCache?.[fixture];
        const eligible = (engine === 'native-quick' || engine === 'native-reuse') && canCheckUnchangedRoot({
          mode: 'quick', root: fixture, folderKind: 'movies', items: current.movies, entry: cached,
          cacheVersion: 16, providerProfile: '', now: 100, metadataRefreshIntervalMs: 604800000,
          missingMetadataRetryIntervalMs: 86400000,
        });
        const inspected = eligible && cached && engine === 'native-reuse'
          ? await inspectLibraryRoot(fixture, cached.signature, { engine: 'rust', binary }) : undefined;
        const fingerprint = eligible && engine === 'native-quick'
          ? await fingerprintLibraryRoot(fixture, { engine: 'rust', binary }) : undefined;
        if (inspected) {
          inventory = inspected.inventory;
          signature = inspected.metrics;
          directories = inspected.metrics.directories; stats = inspected.metrics.stats;
          childPeakRssBytes = inspected.metrics.peakRssBytes || 0;
        } else if (fingerprint && fingerprint.signature === cached?.signature && fingerprint.fileCount === cached.fileCount) {
          signature = fingerprint;
          directories = fingerprint.directories; stats = fingerprint.stats;
          childPeakRssBytes = fingerprint.peakRssBytes || 0;
        } else {
          const result = await discoverLibraryRoot(fixture, { engine: engine.startsWith('native-') ? 'typescript' : engine as 'typescript' | 'rust', binary });
          inventory = result.inventory;
          signature = await inventory.signatureAsync();
          directories = result.metrics.directories + (fingerprint?.directories || 0);
          stats = result.metrics.stats + (fingerprint?.stats || 0);
          childPeakRssBytes = Math.max(fingerprint?.peakRssBytes || 0,
            'peakRssBytes' in result.metrics ? Number(result.metrics.peakRssBytes || 0) : 0);
        }
      }
      const discoveryMs = performance.now() - started;
      try {
        if (!signature) throw new Error('Fixture disappeared.');
        let movies: MediaItem[];
        if (current.scanCache?.[fixture]?.signature === signature.signature) movies = current.movies;
        else {
          const probe = async () => { probes++; return { localMetadata: { videoCodec: 'h264' } }; };
          if (engine !== 'baseline' && !inventory) throw new Error('Missing scan inventory.');
          const episodes: EpisodeFile[] = engine === 'baseline'
            ? await baseline.scanEpisodeFilesAsync(fixture, probe)
            : await scanInventory.run(inventory, () => scanEpisodeFilesAsync(fixture, probe));
          movies = [];
          for (const episode of episodes) {
            providerCalls++;
            const provider = await Promise.resolve({ rating: 7, year: 2026 });
            movies.push({ id: createMediaItemId(episode.filePath), type: 'movie', filePath: episode.filePath,
              title: path.basename(episode.filePath), year: provider.year, rating: provider.rating,
              poster: '', backdrop: '', summary: '', genres: [], cast: [] });
          }
        }
        // The coordinator releases each root inventory before its checkpoint.
        inventory?.close();
        inventory = undefined;
        const next: LibraryData = { ...current, movies, scanCache: { ...current.scanCache,
          [fixture]: { version: 16, folderKind: 'movies', signature: signature.signature,
            subtitleProfile: '', fileCount: signature.fileCount, itemCount: movies.length, scannedAt: 100 } } };
        const beforeWrites = (database.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
        const beforePersistence = performance.now();
        if (engine === 'baseline') saveLibrary(database, next);
        else {
          const delta = planScanDelta(current, next, [fixture]);
          const cache = JSON.stringify(current.scanCache?.[fixture]) === JSON.stringify(next.scanCache?.[fixture])
            ? {} : next.scanCache || {};
          saveLibraryScanDelta(database, delta.changed, delta.removed, cache);
        }
        const persistenceMs = performance.now() - beforePersistence;
        const rowsChanged = (database.prepare('SELECT total_changes() AS n').get() as { n: number }).n - beforeWrites;
        current = next;
        delay.disable();
        const parentPeakRssBytes = process.resourceUsage().maxRSS * 1024;
        return { discoveryMs, endToEndMs: performance.now() - started, persistenceMs, rowsChanged,
          eventLoopP95Ms: delay.percentile(95) / 1e6, combinedPeakUpperBoundBytes: parentPeakRssBytes + childPeakRssBytes,
          parentPeakRssBytes, childPeakRssBytes, providerCalls, probes, directories, stats, items: movies.length };
      } finally { inventory?.close(); }
    };
    if (phase === 'repeat' || phase === 'changed') await measure();
    if (phase === 'changed') {
      if (!path.basename(path.dirname(fixture)).startsWith('loom-pipeline-benchmark-')) throw new Error('Changed benchmark requires an owned fixture.');
      const changedFile = path.join(fixture, 'Series-0/Show.S01E001.mp4');
      const original = await fs.stat(changedFile);
      try {
        await fs.appendFile(changedFile, 'changed');
        console.log(JSON.stringify(await measure()));
      } finally {
        await fs.truncate(changedFile, original.size);
        await fs.utimes(changedFile, original.atime, original.mtime);
      }
    } else console.log(JSON.stringify(await measure()));
  } finally { database.close(); await fs.rm(baselinePath, { force: true }); }
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-pipeline-benchmark-'));
  const results = [];
  const compareReuse = process.argv.includes('--compare-reuse');
  try {
    for (const count of [1000, 10000, 50000]) {
      const fixture = path.join(root, String(count)); await fs.mkdir(fixture);
      for (let index = 0; index < count / 2; index++) {
        const directory = path.join(fixture, `Series-${Math.floor(index / 100)}`);
        if (index % 100 === 0) await fs.mkdir(directory);
        const stem = `Show.S01E${String(index % 100 + 1).padStart(3, '0')}`;
        await fs.writeFile(path.join(directory, stem + '.mp4'), 'fixture');
        await fs.writeFile(path.join(directory, stem + '.en.srt'), 'fixture');
      }
      for (let repetition = 0; repetition < 5; repetition++) for (const engine of compareReuse ? ['typescript', 'native-quick', 'native-reuse'] : ['baseline', 'typescript', 'rust', 'native-quick', 'native-reuse']) for (const phase of compareReuse ? ['repeat', 'changed'] : ['first', 'repeat']) {
        const output = await run(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', import.meta.filename, '--sample', engine, fixture, phase]);
        const result = { count, engine, phase, repetition, ...JSON.parse(output.stdout) };
        results.push(result); console.log(JSON.stringify(result));
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  await fs.writeFile(process.argv[2] || '/tmp/loom-scan-pipeline-benchmark.json', JSON.stringify({ baselineRevision,
    platform: process.platform, arch: process.arch,
    note: 'Controlled provider and probe responses with real SQLite writes and canonical media IDs. Native-quick checks a Rust signature then traverses changed roots again with TypeScript. Native-reuse inspects once and replays saved facts for changed roots. Both use the production cache eligibility guard. Repeat follows one completed scan; changed then modifies one file. First starts with an empty catalog. Fixtures are recently created local files. This does not measure cold disks or live providers. Memory sums process peaks including warmup, an upper bound.', results }, null, 2));
}
