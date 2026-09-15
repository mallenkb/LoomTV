import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { discoverLibraryRoot } from '../src/main/scanning/discover.ts';
import { scanInventory } from '../src/main/scanning/inventory.ts';
import { scanEpisodeFilesAsync } from '../src/main/libraryScanFiles.ts';
const run = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, '..');
const binary = path.join(desktop, 'native/scanner/target/release/loom-scanner' + (process.platform === 'win32' ? '.exe' : ''));
const baselineRevision = process.env.LOOM_SCAN_BASELINE || 'cd042e2ace4e2661ecb8cf65273e120adca8caf1';

if (process.argv[2] === '--sample') {
  const engine = process.argv[3]; const fixture = process.argv[4]; const phase = process.argv[5];
  const baselinePath = path.join(desktop, 'src/main', `.scan-baseline-${process.pid}.ts`);
  try {
    let baseline;
    if (engine === 'baseline') {
      await fs.writeFile(baselinePath, execFileSync('git', ['show', `${baselineRevision}:apps/desktop/src/main/libraryScanFiles.ts`], { cwd: desktop, encoding: 'utf8' }));
      baseline = await import(pathToFileURL(baselinePath).href);
    }
    const measure = async () => {
      const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
      await new Promise((resolve) => setTimeout(resolve, 20));
      let probes = 0; let childPeakRssBytes = 0;
      const probe = async () => { probes++; return { localMetadata: { videoCodec: 'h264' } }; };
      const started = performance.now(); let discoveryMs: number;
      let directories: number | undefined; let stats: number | undefined;
      if (engine === 'baseline') {
        await baseline.getLibraryFolderSignatureAsync(fixture);
        discoveryMs = performance.now() - started;
        await baseline.scanEpisodeFilesAsync(fixture, probe);
      } else if (engine === 'typescript' || engine === 'rust') {
        const result = await discoverLibraryRoot(fixture, { engine, binary });
        try {
          await result.inventory.signatureAsync();
          discoveryMs = performance.now() - started;
          directories = result.metrics.directories; stats = result.metrics.stats;
          childPeakRssBytes = 'peakRssBytes' in result.metrics ? Number(result.metrics.peakRssBytes || 0) : 0;
          await scanInventory.run(result.inventory, () => scanEpisodeFilesAsync(fixture, probe));
        } finally { result.inventory.close(); }
      } else throw new Error('Unknown benchmark engine.');
      const localScanMs = performance.now() - started;
      delay.disable();
      const parentPeakRssBytes = process.resourceUsage().maxRSS * 1024;
      return { discoveryMs, localScanMs, eventLoopP95Ms: delay.percentile(95) / 1e6,
        combinedPeakUpperBoundBytes: parentPeakRssBytes + childPeakRssBytes, parentPeakRssBytes, childPeakRssBytes, probes, directories, stats };
    };
    if (phase === 'repeat') await measure();
    console.log(JSON.stringify(await measure()));
  } finally { await fs.rm(baselinePath, { force: true }); }
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-scan-benchmark-')); const results = [];
  try {
    for (const count of [1000, 10000, 50000]) {
      const fixture = path.join(root, String(count)); await fs.mkdir(fixture);
      for (let i = 0; i < count / 2; i++) {
        const directory = path.join(fixture, 'Series-' + Math.floor(i / 100));
        if (i % 100 === 0) await fs.mkdir(directory);
        const stem = `Show.S01E${String(i % 100 + 1).padStart(3, '0')}`;
        await fs.writeFile(path.join(directory, stem + '.mp4'), 'fixture');
        await fs.writeFile(path.join(directory, stem + '.en.srt'), 'fixture');
      }
      for (let repetition = 0; repetition < 5; repetition++) {
        for (const engine of ['baseline', 'typescript', 'rust']) {
          for (const phase of ['first', 'repeat']) {
            const output = await run(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', import.meta.filename, '--sample', engine, fixture, phase]);
            const result = { count, engine, phase, repetition, ...JSON.parse(output.stdout) };
            results.push(result); console.log(JSON.stringify(result));
          }
        }
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  await fs.writeFile(process.argv[2] || '/tmp/loom-scan-benchmark.json', JSON.stringify({ baselineRevision, platform: process.platform, arch: process.arch,
    note: 'Each sample uses a fresh Node process. First is the first traversal in that process; repeat has one unmeasured traversal. Recently created local fixtures do not represent a cold disk cache. Controlled probes, no providers or persistence. Combined memory is the conservative sum of parent and child peak RSS, not their simultaneous peak.', results }, null, 2));
}
