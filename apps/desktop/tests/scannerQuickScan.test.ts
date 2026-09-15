import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverLibraryRoot, fingerprintLibraryRoot, inspectLibraryRoot } from '../src/main/scanning/discover.ts';
import { canCheckUnchangedRoot } from '../src/main/scanning/quickScanCache.ts';
import { createMediaItemId } from '../src/main/libraryItemHelpers.ts';
import { discoverRust, hasScannerProcesses } from '../src/main/scanning/rustScannerClient.ts';
import { SCANNER_PROTOCOL } from '../src/main/scanning/discoveryTypes.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';

const binary = path.resolve(import.meta.dirname, '../native/scanner/target/release/loom-scanner' + (process.platform === 'win32' ? '.exe' : ''));

test('inspection returns no inventory for a match and reusable facts for changed and emptied roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-inspect-test-'));
  try {
    const file = path.join(root, 'Movie.mp4');
    await fs.writeFile(file, 'fixture');
    const initial = await fingerprintLibraryRoot(root, { engine: 'rust', binary });
    assert.ok(initial);
    const matched = await inspectLibraryRoot(root, initial.signature, { engine: 'rust', binary });
    assert.equal(matched?.unchanged, true);
    assert.equal(matched?.inventory, undefined);
    for (const change of [async () => fs.writeFile(file, 'longer fixture'), async () => fs.rm(file)]) {
      await change();
      const inspected = await inspectLibraryRoot(root, initial.signature, { engine: 'rust', binary });
      assert.ok(inspected?.inventory);
      try {
        assert.equal(inspected.unchanged, false);
        assert.equal(inspected.metrics.stats, inspected.metrics.fileCount + 1);
        const actual = await fingerprintLibraryRoot(root, { engine: 'rust', binary });
        assert.equal(inspected.inventory.signature().signature, actual?.signature);
        if (inspected.metrics.fileCount) assert.equal(inspected.inventory.get(file)?.hints?.title, 'Movie');
        else assert.deepEqual(inspected.inventory.entries(root), []);
      } finally { inspected.inventory.close(); }
    }
    assert.equal(await inspectLibraryRoot(root, initial.signature, { binary: path.join(root, 'missing') }), undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('changed inspection replays saved facts after traversal and observes cancellation during replay', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-inspect-replay-'));
  const moved = root + '-moved';
  let renamed = false;
  try {
    for (let i = 0; i < 260; i++) await fs.writeFile(path.join(root, `${i}.mp4`), 'fixture');
    let entries = 0;
    const expectedSignature = `inventory-v1:0:${'0'.repeat(64)}`;
    const result = await discoverRust(binary, root, async (batch) => {
      entries += batch.length;
      if (!renamed) { await fs.rename(root, moved); renamed = true; }
    }, { expectedSignature });
    assert.equal(entries, 260);
    assert.equal(result.stats, 261);
    await fs.rename(moved, root); renamed = false;
    const controller = new AbortController();
    await assert.rejects(discoverRust(binary, root, async () => controller.abort(), {
      expectedSignature, signal: controller.signal,
    }), /abort|cancel/i);
    assert.equal(hasScannerProcesses(), false);
  } finally { await fs.rm(renamed ? moved : root, { recursive: true, force: true }); }
});

test('native signature checks agree with discovery and detect additions, edits and removals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fingerprint-test-'));
  try {
    const file = path.join(root, '日本語.S01E01.mp4');
    await fs.writeFile(file, 'fixture');
    await fs.writeFile(path.join(root, '日本語.S01E01.en.srt'), 'subtitle');
    let previous = '';
    for (const mutate of [async () => undefined, async () => fs.writeFile(file, 'changed fixture'),
      async () => fs.writeFile(path.join(root, 'poster.jpg'), 'image'), async () => fs.rm(file)]) {
      await mutate();
      const full = await discoverLibraryRoot(root, { engine: 'typescript' });
      try {
        const fingerprint = await fingerprintLibraryRoot(root, { engine: 'rust', binary });
        assert.ok(fingerprint);
        assert.deepEqual({ signature: fingerprint.signature, fileCount: fingerprint.fileCount }, full.inventory.signature());
        assert.notEqual(fingerprint.signature, previous);
        previous = fingerprint.signature;
      } finally { full.inventory.close(); }
    }
    await assert.rejects(fingerprintLibraryRoot(path.join(root, 'missing'), { binary }), /filesystem/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fingerprintLibraryRoot(root, { binary, signal: controller.signal }), /abort/i);
    assert.equal(hasScannerProcesses(), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('quick cache eligibility rejects stale metadata, changed settings and cross-root paths', () => {
  const root = path.resolve('fixture');
  const filePath = path.join(root, 'Movie.mp4');
  const item: MediaItem = { id: createMediaItemId(filePath), filePath, type: 'movie', title: 'Movie',
    year: 2026, rating: 7, summary: '', poster: '', backdrop: '', cast: [], genres: [] };
  const options: Parameters<typeof canCheckUnchangedRoot>[0] = {
    root, mode: 'quick', folderKind: 'movies', items: [item], cacheVersion: 16, providerProfile: 'keys', now: 1000,
    metadataRefreshIntervalMs: 700, missingMetadataRetryIntervalMs: 100,
    entry: { version: 16, folderKind: 'movies', subtitleProfile: 'keys', signature: `inventory-v1:1:${'0'.repeat(64)}`,
      fileCount: 1, itemCount: 1, scannedAt: 950 },
  };
  assert.equal(canCheckUnchangedRoot(options), true);
  for (const override of [{ mode: 'full' as const }, { mode: 'metadata' as const }, { cacheVersion: 17 },
    { providerProfile: 'changed' }, { folderKind: 'anime' as const }, { now: 1100 }, { items: [] },
    { items: [{ ...item, id: 'legacy-id' }] }, { items: [{ ...item, episodeFiles: [] }] },
    { items: [{ ...item, filePath: path.resolve('outside/Movie.mp4') }] }]) {
    assert.equal(canCheckUnchangedRoot({ ...options, ...override }), false);
  }
  const series: MediaItem = { ...item, id: createMediaItemId(root), filePath: root, type: 'tv',
    episodeFiles: [{ season: 1, episode: 1, filePath }],
    seasons: [{ number: 1, title: 'Season 1', episodeCount: 1 }] };
  assert.ok(options.entry);
  const seriesOptions = { ...options, items: [series], folderKind: 'tv' as const,
    entry: { ...options.entry, folderKind: 'tv' as const } };
  assert.equal(canCheckUnchangedRoot(seriesOptions), true);
  assert.equal(canCheckUnchangedRoot({ ...seriesOptions, items: [{ ...series,
    seasons: [{ number: 1, title: 'Season 1', episodeCount: 2 }] }] }), false);
  assert.equal(canCheckUnchangedRoot({ ...seriesOptions, items: [{ ...series,
    episodeFiles: [{ season: 1, episode: 1, filePath: path.resolve('outside/Episode.mp4') }] }] }), false);
});

test('unavailable or older workers fall back without reusing an unverified cache', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fingerprint-compat-'));
  try {
    assert.equal(await fingerprintLibraryRoot(root, { binary: path.join(root, 'missing') }), undefined);
    assert.equal(await fingerprintLibraryRoot(root, { engine: 'typescript', binary }), undefined);
    const worker = path.join(root, 'old-worker');
    await fs.writeFile(worker, `#!${process.execPath}\nprocess.stdin.once('data', data => {
      const hello = JSON.parse(data.toString().trim());
      process.stdout.write(JSON.stringify({ version: ${SCANNER_PROTOCOL}, id: hello.id, kind: 'ready', capabilities: ['discovery', 'cancel', 'ack', 'signature'] }) + '\\n');
    });\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    assert.equal(await fingerprintLibraryRoot(root, { binary: worker }), undefined);
    await assert.rejects(discoverRust(worker, root, async () => undefined, { fingerprintOnly: true }), /does not support/);
    assert.equal(hasScannerProcesses(), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
