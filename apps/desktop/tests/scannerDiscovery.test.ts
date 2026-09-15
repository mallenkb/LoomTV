import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverLibraryRoot } from '../src/main/scanning/discover.ts';
import { scanInventory } from '../src/main/scanning/inventory.ts';
import { scanEpisodeFilesAsync } from '../src/main/libraryScanFiles.ts';
import { decodeScannerFrames, scannerCommandSchema, scannerEventSchema } from '../src/main/scanning/scannerProtocol.ts';
import protocolContract from '../native/scanner/protocol-contract.json' with { type: 'json' };
import protocolFixtures from '../native/scanner/protocol-fixtures.json' with { type: 'json' };
import { MAX_FRAME_BYTES, SCANNER_PROTOCOL } from '../src/main/scanning/discoveryTypes.ts';

const binary = path.resolve(import.meta.dirname, '../native/scanner/target/release/loom-scanner' + (process.platform === 'win32' ? '.exe' : ''));
test('the TypeScript event schema matches the worker protocol contract', () => {
  assert.deepEqual(scannerEventSchema.options.map((option) => option.shape.kind.value), protocolContract.eventKinds);
  for (const option of scannerEventSchema.options) {
    assert.deepEqual(Object.keys(option.shape).filter((field) => !['id', 'version', 'kind'].includes(field)), protocolContract.eventFields[option.shape.kind.value]);
  }
});
test('both protocol implementations use the shared command fixtures', () => {
  for (const fixture of protocolFixtures) {
    const command = { ...fixture.command };
    if ('root' in command && command.root === '$ROOT') command.root = path.resolve('library');
    assert.equal(scannerCommandSchema.safeParse(command).success, fixture.valid, JSON.stringify(command));
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-discovery-test-'));
  for (const name of ['Show/Season 00', 'Show/Season 02', 'Show/extras', 'Movies']) await fs.mkdir(path.join(root, name), { recursive: true });
  for (const name of ['Show/Season 00/Show.S00E01.mkv', 'Show/Season 02/Show.S02E01.mkv', 'Show/Season 02/Show.S02E01.en.srt', 'Show/extras/Trailer.S01E01.mp4', 'Movies/日本語 film 2026.mp4', 'Movies/._ignored.mp4', 'Movies/poster.jpg']) await fs.writeFile(path.join(root, name), 'fixture');
  return root;
}
for (const engine of ['typescript', 'rust'] as const) test(`${engine}: inventory preserves seasons, subtitles, exclusions and file-change checks`, async () => {
  const root = await fixture();
  try {
    const { inventory, metrics } = await discoverLibraryRoot(root, { engine, binary });
    try {
      assert.equal(metrics.directories, 6);
      assert.equal(inventory.signature().fileCount, 6);
      const episodes = await scanInventory.run(inventory, () => scanEpisodeFilesAsync(path.join(root, 'Show'), async () => ({ localMetadata: { videoCodec: 'h264' } })));
      assert.deepEqual(episodes.map((e) => [e.season, e.episode]), [[0, 1], [2, 1]]);
      assert.equal(episodes[1].subtitles?.length, 1);
      const file = path.join(root, 'Movies/日本語 film 2026.mp4');
      await inventory.validateFile(file);
      await fs.appendFile(file, 'changed');
      await assert.rejects(inventory.validateFile(file), /changed/);
    } finally { inventory.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('engines produce identical versioned signatures; auto retries missing binaries once', async () => {
  const root = await fixture();
  try {
    const ts = await discoverLibraryRoot(root);
    const rust = await discoverLibraryRoot(root, { engine: 'rust', binary });
    const fallback = await discoverLibraryRoot(root, { engine: 'auto', binary: path.join(root, 'missing') });
    try {
      assert.deepEqual(ts.inventory.signature(), rust.inventory.signature());
      assert.deepEqual(ts.inventory.signature(), fallback.inventory.signature());
      assert.equal(fallback.metrics.fallback, true);
      await assert.rejects(discoverLibraryRoot(path.join(root, 'missing'), { engine: 'auto', binary }), /filesystem/);
    } finally { ts.inventory.close(); rust.inventory.close(); fallback.inventory.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('batched TypeScript stats preserve Rust parity and stop after cancellation', async () => {
  const { discoverTypescript } = await import('../src/main/scanning/typescriptDiscovery.ts');
  const root = await fixture();
  try {
    for (let index = 0; index < 350; index++) await fs.writeFile(path.join(root, `extra-${index}.mp4`), 'fixture');
    const ts = await discoverLibraryRoot(root);
    const rust = await discoverLibraryRoot(root, { engine: 'rust', binary });
    try { assert.deepEqual(ts.inventory.signature(), rust.inventory.signature()); }
    finally { ts.inventory.close(); rust.inventory.close(); }
    const controller = new AbortController(); let batches = 0;
    await assert.rejects(discoverTypescript(root, async () => { batches++; controller.abort(); }, { signal: controller.signal }));
    assert.equal(batches, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('large inventories spill to disk without changing lookup or signature behavior', async () => {
  const { DiscoveryInventory } = await import('../src/main/scanning/inventory.ts');
  const root = path.resolve('spill-fixture');
  const inventory = new DiscoveryInventory(root);
  try {
    for (let start = 0; start < 65_537; start += 128) {
      const batch = Array.from({ length: Math.min(128, 65_537 - start) }, (_, offset) => ({
        path: path.join(root, `file-${String(start + offset).padStart(5, '0')}.mp4`),
        kind: 'file' as const,
        size: '1',
        mtime: '0',
      }));
      inventory.add(batch);
    }
    inventory.complete = true;
    assert.equal(inventory.entries(root).length, 65_537);
    assert.equal(inventory.get(path.join(root, 'file-00000.mp4'))?.size, '1');
    assert.equal(inventory.get(path.join(root, 'file-65536.mp4'))?.size, '1');
    assert.equal(inventory.signature().fileCount, 65_537);
  } finally { inventory.close(); }
});

test('strict mode fails for missing binaries and cancellation never becomes successful discovery', async () => {
  const root = await fixture();
  try {
    await assert.rejects(discoverLibraryRoot(root, { engine: 'rust', binary: path.join(root, 'missing') }));
    const controller = new AbortController(); controller.abort();
    for (const engine of ['rust', 'typescript', 'auto'] as const) await assert.rejects(discoverLibraryRoot(root, { engine, binary, signal: controller.signal }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('frame decoder handles UTF-8 chunk boundaries and rejects truncated, oversized and invalid messages', async () => {
  const value = { version: SCANNER_PROTOCOL, id: '日本', kind: 'ready', capabilities: ['discovery'] };
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  async function* chunks(buffer: Buffer) { for (const byte of buffer) yield Buffer.from([byte]); }
  const events = []; for await (const event of decodeScannerFrames(chunks(bytes))) events.push(event);
  assert.deepEqual(events, [value]);
  const lifecycle = [
    { version: SCANNER_PROTOCOL, id: 'scan', kind: 'progress', directories: 64, stats: 128 },
    { version: SCANNER_PROTOCOL, id: 'scan', kind: 'cancelled' },
  ];
  const lifecycleEvents = [];
  for await (const event of decodeScannerFrames(chunks(Buffer.from(lifecycle.map((entry) => JSON.stringify(entry)).join('\n') + '\n')))) lifecycleEvents.push(event);
  assert.deepEqual(lifecycleEvents, lifecycle);
  for (const buffer of [Buffer.from('{}\n'), Buffer.from('{'), Buffer.alloc(MAX_FRAME_BYTES + 1, 65)]) {
    await assert.rejects(async () => { for await (const event of decodeScannerFrames((async function* () { yield buffer; })())) void event; });
  }
});

test('cancels Rust while a batch awaits acknowledgement and discards the attempt', async () => {
  const { discoverRust } = await import('../src/main/scanning/rustScannerClient.ts');
  const root = await fixture();
  try {
    for (let i = 0; i < 400; i++) await fs.writeFile(path.join(root, `file-${i}.mp4`), 'fixture');
    const controller = new AbortController(); let batches = 0;
    await assert.rejects(discoverRust(binary, root, async () => { batches++; controller.abort(); }, { signal: controller.signal }));
    assert.equal(batches, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Rust handles progress events and a slow batch consumer', async () => {
  const { discoverRust } = await import('../src/main/scanning/rustScannerClient.ts');
  const root = await fixture();
  try {
    for (let i = 0; i < 65; i++) await fs.mkdir(path.join(root, `extra-${i}`));
    for (let i = 0; i < 280; i++) await fs.writeFile(path.join(root, `video-${i}.mp4`), 'fixture');
    let batches = 0;
    const result = await discoverRust(binary, root, async () => {
      batches++;
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.ok(result.directories >= 64);
    assert.ok(batches >= 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('shutdown stops a backpressured worker without completing its root', async () => {
  const { discoverRust, stopScannerProcesses } = await import('../src/main/scanning/rustScannerClient.ts');
  const root = await fixture();
  try {
    for (let i = 0; i < 280; i++) await fs.writeFile(path.join(root, `video-${i}.mp4`), 'fixture');
    await assert.rejects(discoverRust(binary, root, async () => { stopScannerProcesses(); }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('symlinked directories are not traversed, Unicode replacement characters remain valid', async () => {
  const root = await fixture();
  try {
    await fs.writeFile(path.join(root, 'valid-\ufffd.mp4'), 'fixture');
    if (process.platform !== 'win32') await fs.symlink(root, path.join(root, 'loop'));
    for (const engine of ['typescript', 'rust'] as const) {
      const { inventory } = await discoverLibraryRoot(root, { engine, binary });
      try { assert.equal(inventory.signature().fileCount, 7); }
      finally { inventory.close(); }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('embedded tags take precedence, Specials stay season zero, and invalid media is excluded', async () => {
  const root = await fixture();
  try {
    for (const engine of ['typescript', 'rust'] as const) {
      const { inventory } = await discoverLibraryRoot(root, { engine, binary });
      try {
        const episodes = await scanInventory.run(inventory, () => scanEpisodeFilesAsync(path.join(root, 'Show'), async (file) => file.includes('S02') ? {} : { season: 9, episode: 7, localMetadata: { videoCodec: 'h264' } }));
        assert.deepEqual(episodes.map((e) => [e.season, e.episode]), [[0, 7]]);
      } finally { inventory.close(); }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('unreadable descendants fail the entire discovery attempt', { skip: process.platform === 'win32' }, async () => {
  const root = await fixture(); const locked = path.join(root, 'Show');
  try {
    await fs.chmod(locked, 0);
    for (const engine of ['typescript', 'rust', 'auto'] as const) await assert.rejects(discoverLibraryRoot(root, { engine, binary }));
  } finally { await fs.chmod(locked, 0o700); await fs.rm(root, { recursive: true, force: true }); }
});

test('malformed and wrong-version workers fail without hanging', { skip: process.platform === 'win32' }, async () => {
  const { discoverRust } = await import('../src/main/scanning/rustScannerClient.ts');
  const root = await fixture();
  try {
    for (const output of ['not-json\n', '{"version":999,"id":"bad","kind":"ready","capabilities":[]}\n']) {
      const executable = path.join(root, 'worker');
      await fs.writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)}); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
      await assert.rejects(discoverRust(executable, root, async () => { return; }, { timeoutMs: 500 }));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('worker crash and early EOF cannot complete a root; auto discards and retries', { skip: process.platform === 'win32' }, async () => {
  const root = await fixture();
  try {
    for (const exitCode of [0, 42]) {
      const executable = path.join(root, 'early-worker');
      await fs.writeFile(executable, `#!${process.execPath}\nprocess.stdin.once('data', (chunk) => { const id = JSON.parse(chunk.toString().split('\\n')[0]).id; process.stdout.write(JSON.stringify({ version: ${SCANNER_PROTOCOL}, id, kind: 'ready', capabilities: ['discovery', 'cancel', 'ack', 'signature'] }) + '\\n', () => process.exit(${exitCode})); });\n`, { mode: 0o700 });
      await assert.rejects(discoverLibraryRoot(root, { engine: 'rust', binary: executable }));
      const fallback = await discoverLibraryRoot(root, { engine: 'auto', binary: executable });
      try { assert.equal(fallback.metrics.fallback, true); assert.ok(fallback.inventory.signature().fileCount > 0); }
      finally { fallback.inventory.close(); }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Rust filename hints match TypeScript title, year and episode conventions', async () => {
  const { filenameHints } = await import('../src/main/scanning/filename.ts');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-filename-parity-'));
  const names = ['Show.S01E02.1080p.mkv', '[Group] Show - 07.mkv', '03 - A Beginning.mkv', 'Show 2026.mkv', '1917 (2019) 1080p.mkv', '日本語 (2022).mp4', 'Movie.2020.Extended.Cut.mp4', 'E03.mkv', 'Show S00E001.mkv', 'weird_𐀀_2021.mkv', 'Season 00', 'Specials - OVAs', 'Series 04: Arc'];
  try {
    for (const name of names) await fs.writeFile(path.join(root, name), 'fixture');
    const { inventory } = await discoverLibraryRoot(root, { engine: 'rust', binary });
    try { for (const name of names) assert.deepEqual(inventory.get(path.join(root, name))?.hints, filenameHints(name), name); }
    finally { inventory.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('non-collecting scans stage results without publishing partial catalog arrays', async () => {
  const { createLibraryScanner } = await import('../src/main/libraryScanner.ts');
  const root = await fixture();
  try {
    const { inventory } = await discoverLibraryRoot(root);
    try {
      const scanner = createLibraryScanner({
        buildMovieItemFromFile: async (request) => ({ id: request.fullPath, filePath: request.fullPath, type: 'movie', title: request.fileName, year: 2026, poster: '', backdrop: '', summary: '', rating: 0, genres: [], cast: [] }),
        buildTVItemFromFolder: async () => null,
        probeMediaFile: async () => ({}), scanEpisodeFiles: async () => [], shouldSplitContainerFolder: async () => false,
      });
      const output = await scanInventory.run(inventory, () => scanner.scanFolder(root, { folderKind: 'movies' }, (items) => inventory.stageItems(items), false));
      assert.deepEqual(output, []);
      assert.ok(inventory.stagedItemCount() > 0);
      assert.equal([...inventory.stagedItems()].length, inventory.stagedItemCount());
    } finally { inventory.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('subtitle matching respects episode boundaries and language suffixes', async () => {
  const { subtitleMatchesVideo } = await import('../src/main/fileClassification.ts');
  assert.equal(subtitleMatchesVideo('Show episode 10.en.srt', 'Show episode 1.mp4'), false);
  assert.equal(subtitleMatchesVideo('SHOW EPISODE 1.en.srt', 'Show episode 1.mp4'), true);
  assert.equal(subtitleMatchesVideo('Show episode 1.srt', 'Show episode 1.mp4'), true);
  assert.equal(subtitleMatchesVideo('Show episode 1 [fr].ass', 'Show episode 1.mp4'), true);
});

test('both engines associate subtitle formats and languages without prefix collisions', async () => {
  const { indexScanSubtitles } = await import('../src/main/libraryScanFiles.ts');
  const { filenameHints } = await import('../src/main/scanning/filename.ts');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-subtitle-parity-'));
  const subtitles = ['SHOW EPISODE 1.en.srt', 'Show episode 1 [fr].ass', 'Show episode 1_de.SSA',
    'Show episode 1.vtt', 'Show episode 10.en.srt', '日本語 1 (ja).srt', 'ΟΣ 1.el.srt'];
  try {
    for (const name of subtitles) await fs.writeFile(path.join(root, name), 'fixture');
    for (const engine of ['typescript', 'rust'] as const) {
      const { inventory } = await discoverLibraryRoot(root, { engine, binary });
      try {
        for (const name of subtitles) assert.deepEqual(inventory.get(path.join(root, name))?.hints, filenameHints(name));
        scanInventory.run(inventory, () => {
          const match = indexScanSubtitles(root, subtitles);
          assert.deepEqual(match('Show episode 1.mp4'), subtitles.slice(0, 4));
          assert.deepEqual(match('Show episode 10.mp4'), [subtitles[4]]);
          assert.deepEqual(match('日本語 1.mp4'), [subtitles[5]]);
          assert.deepEqual(match('ΟΣ 1.mp4'), [subtitles[6]]);
          assert.deepEqual(match('Show episode 2.mp4'), []);
        });
      } finally { inventory.close(); }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('inventory rejects escaped roots and duplicate paths', async () => {
  const { DiscoveryInventory } = await import('../src/main/scanning/inventory.ts');
  const root = await fixture(); const inventory = new DiscoveryInventory(root);
  try {
    assert.throws(() => inventory.add([{ path: path.join(root, '../outside.mp4'), kind: 'file', size: '1', mtime: '1' }]), /outside/);
    inventory.add([{ path: path.join(root, 'inside.mp4'), kind: 'file', size: '1', mtime: '1' }]);
    assert.throws(() => inventory.add([{ path: path.join(root, 'inside.mp4'), kind: 'file', size: '1', mtime: '1' }]));
    assert.throws(() => inventory.signature(), /incomplete/);
  } finally { inventory.close(); await fs.rm(root, { recursive: true, force: true }); }
});


test('spilled inventory preserves root paths, byte ordering, hints and evicted directory lookups', async () => {
  const { DiscoveryInventory } = await import('../src/main/scanning/inventory.ts');
  const root = path.parse(process.cwd()).root;
  const inventory = new DiscoveryInventory(root);
  const entries = Array.from({ length: 4_200 }, (_, index) => ({
    path: path.join(root, `directory-${index % 600}`, `file-${index}.mp4`),
    kind: 'file' as const, size: String(index), mtime: '0',
    hints: { title: `Title ${index}`, year: 2026, subtitleKeys: [`file-${index}`] },
  }));
  entries.push(...['a.mp4', 'a/one.mp4', 'a-/two.mp4', '日本/film.mp4', '𐀀.mp4', '\ue000.mp4'].map((name) => ({
    path: path.join(root, name), kind: 'file' as const, size: '1', mtime: '0',
    hints: { title: name, year: 2026, subtitleKeys: [name] },
  })));
  try {
    for (let start = 0; start < entries.length; start += 128) inventory.add(entries.slice(start, start + 128));
    inventory.complete = true;
    const expected = createHash('sha256');
    for (const entry of [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
      expected.update(JSON.stringify([path.relative(root, entry.path).split(path.sep).join('/'), entry.size, entry.mtime]) + '\n');
    }
    assert.equal((await inventory.signatureAsync()).signature, `inventory-v1:${entries.length}:${expected.digest('hex')}`);
    for (const index of [0, 599, 4_199]) assert.deepEqual(inventory.get(entries[index].path), entries[index]);
    assert.equal(inventory.entries(path.join(root, 'directory-0')).length, 7);
    assert.deepEqual(inventory.entries(path.join(root, 'missing-directory')), []);
    assert.equal(inventory.get(path.join(root, 'missing-directory/file.mp4')), undefined);
    assert.throws(() => inventory.add([entries[0]]), /completed/);
  } finally { inventory.close(); }
});

test('episode probe batches preserve ordering, subtitle matches and failure propagation', async () => {
  const { DiscoveryInventory } = await import('../src/main/scanning/inventory.ts');
  const root = path.resolve('episode-batch-fixture');
  const inventory = new DiscoveryInventory(root);
  for (let index = 260; index > 0; index--) {
    const stem = `Show.S01E${String(index).padStart(3, '0')}`;
    inventory.add(['.mp4', '.en.srt'].map((extension) => ({ path: path.join(root, stem + extension), kind: 'file', size: '1', mtime: '0' })));
  }
  inventory.complete = true;
  let active = 0; let peak = 0;
  try {
    const episodes = await scanInventory.run(inventory, () => scanEpisodeFilesAsync(root, async (file) => {
      active++; peak = Math.max(peak, active);
      await yieldToEventLoop();
      active--;
      return file.endsWith('E129.mp4') ? {} : { localMetadata: { videoCodec: 'h264' } };
    }));
    assert.equal(peak, 4);
    assert.equal(active, 0);
    assert.deepEqual(episodes.map((episode) => episode.episode), Array.from({ length: 260 }, (_, index) => index + 1).filter((number) => number !== 129));
    for (const episode of episodes) assert.equal(episode.subtitles?.length, 1);
    let started = 0;
    await assert.rejects(scanInventory.run(inventory, () => scanEpisodeFilesAsync(root, async () => {
      started++;
      if (started === 140) throw new Error('Probe failed');
      await yieldToEventLoop();
      return { localMetadata: { videoCodec: 'h264' } };
    })), /Probe failed/);
    assert.ok(started <= 143);
  } finally { inventory.close(); }
});

test('file facts stay lightweight while filename hints remain identical before and after spilling', async () => {
  const { DiscoveryInventory } = await import('../src/main/scanning/inventory.ts');
  const { filenameHints } = await import('../src/main/scanning/filename.ts');
  const root = path.resolve('lazy-filename-fixture');
  const inventory = new DiscoveryInventory(root);
  const names = ['日本語.Show.S02E03.2026.mp4', 'Show.S02E03.en.srt', '[Group] Show - 07.mkv'];
  try {
    inventory.add(names.map((name) => ({ path: path.join(root, name), kind: 'file', size: '1', mtime: '0' })));
    const check = () => {
      for (const name of names) {
        const file = path.join(root, name);
        assert.equal(inventory.facts(file)?.hints, undefined);
        assert.deepEqual(inventory.get(file)?.hints, filenameHints(name));
        assert.equal(inventory.facts(file)?.hints, undefined);
        assert.equal(inventory.facts(file)?.size, '1');
      }
    };
    check();
    for (let start = 0; start < 4_200; start += 128) {
      inventory.add(Array.from({ length: Math.min(128, 4_200 - start) }, (_, offset) => ({
        path: path.join(root, `filler-${start + offset}.mp4`), kind: 'file', size: '1', mtime: '0',
      })));
    }
    inventory.complete = true;
    const signature = await inventory.signatureAsync();
    check();
    assert.deepEqual(await inventory.signatureAsync(), signature);
  } finally { inventory.close(); }
});
