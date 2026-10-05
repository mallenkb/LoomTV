// Runs the fast, deterministic benchmarks and fails when a median goes over
// its ceiling in performance-budgets.json. Usage:
//   node scripts/check-performance-budgets.ts [--output <file.json>]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const run = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, '..');
const node = [process.execPath, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];

type Budgets = { budgets: Record<string, { ceilings: Array<{ value: number }> }> };

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

if (process.argv[2] === '--projection-sample') {
  // A fresh process per sample keeps peak RSS meaningful.
  const { stripInlineArtworkFromLibrary } = await import('../src/main/libraryProjections.ts');
  const count = 50_000;
  const previous = {
    movies: Array.from({ length: count }, (_, index) => ({
      id: String(index), type: 'movie', title: `Movie ${index}`, filePath: `/fixture/${index}.mp4`,
      year: 2026, poster: 'poster.jpg', backdrop: 'backdrop.jpg', logo: '',
      posterCandidates: [], backdropCandidates: [], logoCandidates: [],
      summary: 'Fixture summary', rating: 7, genres: ['Drama'],
      cast: [{ name: `Actor ${index}`, character: 'Lead', image: 'actor.jpg', characterImage: '', voiceActorImage: '' }],
    })),
    tvShows: [], animeShows: [], libraryFolders: ['/fixture'], scanCache: {},
  } as Parameters<typeof stripInlineArtworkFromLibrary>[0];
  const next = { ...previous, movies: previous.movies.map((item) => ({ ...item })) };
  const started = performance.now();
  const kept = [stripInlineArtworkFromLibrary(previous, true), stripInlineArtworkFromLibrary(next)];
  const ms = performance.now() - started;
  console.log(JSON.stringify({ ms, peakRssMb: process.resourceUsage().maxRSS / 1024, items: kept.length }));
} else {
  const budgets = JSON.parse(await fs.readFile(path.join(desktop, 'performance-budgets.json'), 'utf8')) as Budgets;
  const results: Record<string, number> = {};

  const persistenceFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'loom-budget-')), 'persistence.json');
  await run(node[0], [...node.slice(1), path.join(desktop, 'scripts/benchmark-scan-persistence.ts'), persistenceFile], { cwd: desktop });
  const rows = JSON.parse(await fs.readFile(persistenceFile, 'utf8')) as Array<{ count: number; mode: string; milliseconds: number }>;
  const persistence = (count: number, mode: string) => median(rows.filter((row) => row.count === count && row.mode === mode).map((row) => row.milliseconds));
  results['scan-persistence-delta-10000-ms'] = persistence(10_000, 'delta');
  results['scan-persistence-delta-50000-ms'] = persistence(50_000, 'delta');
  results['scan-persistence-replacement-50000-ms'] = persistence(50_000, 'replacement');
  await fs.rm(path.dirname(persistenceFile), { recursive: true, force: true });

  const samples: Array<{ ms: number; peakRssMb: number }> = [];
  for (let index = 0; index < 3; index += 1) {
    const { stdout } = await run(node[0], [...node.slice(1), import.meta.filename, '--projection-sample'], { cwd: desktop });
    samples.push(JSON.parse(stdout.trim().split('\n').at(-1) || '{}'));
  }
  results['scan-projection-50000-ms'] = median(samples.map((sample) => sample.ms));
  results['scan-projection-50000-peak-rss-mb'] = median(samples.map((sample) => sample.peakRssMb));

  let failed = false;
  for (const [name, budget] of Object.entries(budgets.budgets)) {
    const ceiling = budget.ceilings.at(-1)?.value;
    const value = results[name];
    if (value === undefined || ceiling === undefined) {
      console.error(`✖ ${name}: no measurement or ceiling`);
      failed = true;
      continue;
    }
    const over = value > ceiling;
    failed ||= over;
    console.log(`${over ? '✖' : '✓'} ${name}: ${value.toFixed(1)} (ceiling ${ceiling})`);
  }
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex > 0 && process.argv[outputIndex + 1]) {
    await fs.writeFile(process.argv[outputIndex + 1], JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 2));
  }
  if (failed) process.exitCode = 1;
}
