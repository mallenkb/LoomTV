import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { stripInlineArtworkFromLibrary } from '../src/main/libraryProjections.ts';
import type { LibraryData } from '../src/main/appContracts.ts';

const desktop = path.resolve(import.meta.dirname, '..');
const baselineRevision = 'cd042e2ace4e2661ecb8cf65273e120adca8caf1';
const run = promisify(execFile);

if (process.argv[2] === '--sample') {
  const mode = process.argv[3];
  if (mode !== 'previous' && mode !== 'current') throw new Error('Unknown projection benchmark mode.');
  const baselinePath = path.join(desktop, 'src/main', `.scan-projection-baseline-${process.pid}.ts`);
  try {
    await fs.writeFile(baselinePath, execFileSync('git', ['show', `${baselineRevision}:apps/desktop/src/main/libraryProjections.ts`], { cwd: desktop, encoding: 'utf8' }));
    const baseline = await import(pathToFileURL(baselinePath).href);
    const count = 50_000;
    // Model already durable committed records and newly scanned item objects.
    // Input creation is identical in both modes and remains part of peak RSS.
    const previous: LibraryData = {
      movies: Array.from({ length: count }, (_, index) => ({
        id: String(index), type: 'movie', title: `Movie ${index}`, filePath: `/fixture/${index}.mp4`,
        year: 2026, poster: 'poster.jpg', backdrop: 'backdrop.jpg', logo: '',
        posterCandidates: [], backdropCandidates: [], logoCandidates: [],
        summary: 'Fixture summary', rating: 7, genres: ['Drama'],
        cast: [{ name: `Actor ${index}`, character: 'Lead', image: 'actor.jpg', characterImage: '', voiceActorImage: '' }],
        episodes: undefined, episodeFiles: undefined,
      })),
      tvShows: [], animeShows: [], libraryFolders: ['/fixture'], scanCache: {},
    };
    const next: LibraryData = { ...previous, movies: previous.movies.map((item) => ({ ...item })) };
    const started = performance.now();
    const durablePrevious: LibraryData = mode === 'current'
      ? stripInlineArtworkFromLibrary(previous, true) : baseline.stripInlineArtworkFromLibrary(previous);
    const durableNext: LibraryData = mode === 'current'
      ? stripInlineArtworkFromLibrary(next) : baseline.stripInlineArtworkFromLibrary(next);
    const normalizationMs = performance.now() - started;
    // Keep both projected catalogs reachable through the measurement, as they
    // are while the coordinator plans its delta. Do not force garbage collection.
    console.log(JSON.stringify({ count, normalizationMs, peakRssBytes: process.resourceUsage().maxRSS * 1024,
      previousItems: durablePrevious.movies.length, nextItems: durableNext.movies.length,
      reusedPreviousItems: durablePrevious.movies.reduce((total, item, index) => total + Number(item === previous.movies[index]), 0),
    }));
  } finally { await fs.rm(baselinePath, { force: true }); }
} else {
  const results = [];
  for (let repetition = 0; repetition < 5; repetition++) for (const mode of ['previous', 'current']) {
    const output = await run(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', import.meta.filename, '--sample', mode]);
    const row = { mode, repetition, ...JSON.parse(output.stdout) };
    results.push(row); console.log(JSON.stringify(row));
  }
  await fs.writeFile(process.argv[2] || '/tmp/loom-scan-projection-benchmark.json', JSON.stringify({ baselineRevision,
    platform: process.platform, arch: process.arch,
    note: 'Five interleaved fresh-process runs. Measures only artwork normalization of 50,000 committed records and incoming records, as used before checkpoint delta planning. Input creation is included in process peak RSS. No forced garbage collection. Excludes discovery, database writes, providers and Electron rendering. This is not a whole-application memory measurement.',
    results,
  }, null, 2) + '\n');
}
