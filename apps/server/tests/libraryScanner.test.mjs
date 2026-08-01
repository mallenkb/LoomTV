import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHeadlessLibraryScanner } from '../src/library-scanner.js';

function makeHarness(initialState) {
  const state = {
    roots: [],
    catalog: [],
    scan: { state: 'idle' },
    ...initialState,
  };
  const logs = [];
  const scanner = createHeadlessLibraryScanner({
    loadState: async () => state,
    saveState: async () => undefined,
    appendLog: async (level, message, context) => { logs.push({ level, message, context }); },
  });
  return { scanner, state, logs };
}

async function makeLibrary(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-scan-'));
  for (const file of files) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'fake-video-bytes');
  }
  return root;
}

async function waitForScan(state, timeoutMs = 5000) {
  const start = Date.now();
  while (state.scan?.state === 'scanning') {
    if (Date.now() - start > timeoutMs) throw new Error('Scan did not complete in time.');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  return state.scan;
}

test('a scan indexes nested video files and skips non-video files', async () => {
  const rootPath = await makeLibrary(['Show/Season 1/episode-01.mkv', 'Movie (2020)/movie.mp4', 'notes.txt']);
  const { scanner, state } = makeHarness({ roots: [{ id: 'root-1', path: rootPath }] });

  await scanner.start({});
  const scan = await waitForScan(state);

  assert.equal(scan.state, 'completed');
  assert.equal(state.catalog.length, 2);
  const titles = state.catalog.map((item) => item.title).sort();
  assert.deepEqual(titles, ['episode 01', 'movie']);
  for (const item of state.catalog) {
    assert.equal(item.rootId, 'root-1');
    assert.equal(item.available, true);
    assert.equal(typeof item.id, 'string');
  }
});

test('an offline root preserves existing records as unavailable instead of deleting them', async () => {
  const rootPath = await makeLibrary(['keeper.mkv']);
  const { scanner, state } = makeHarness({ roots: [{ id: 'root-1', path: rootPath }] });
  await scanner.start({});
  await waitForScan(state);
  assert.equal(state.catalog.length, 1);

  await fs.rm(rootPath, { recursive: true, force: true });
  await scanner.start({});
  const scan = await waitForScan(state);

  assert.deepEqual(scan.offlineRoots, ['root-1']);
  assert.match(scan.warning, /unavailable/i);
  assert.equal(state.catalog.length, 1);
  assert.equal(state.catalog[0].available, false);
});

test('quick rescans keep enriched fields on unchanged files; full rescans rebuild records', async () => {
  const rootPath = await makeLibrary(['stable.mkv']);
  const { scanner, state } = makeHarness({ roots: [{ id: 'root-1', path: rootPath }] });
  await scanner.start({ mode: 'quick' });
  await waitForScan(state);

  // Simulate a future metadata pass enriching the record.
  state.catalog[0].plot = 'Enriched by a metadata provider.';

  await scanner.start({ mode: 'quick' });
  await waitForScan(state);
  assert.equal(state.catalog[0].plot, 'Enriched by a metadata provider.', 'quick scan must preserve unchanged records');

  await scanner.start({ mode: 'full' });
  await waitForScan(state);
  assert.equal(state.catalog[0].plot, undefined, 'full scan must rebuild records from disk');
});

test('a metadata scan states that enrichment is not available yet', async () => {
  const rootPath = await makeLibrary(['anything.mkv']);
  const { scanner, state } = makeHarness({ roots: [{ id: 'root-1', path: rootPath }] });

  await scanner.start({ mode: 'metadata' });
  const scan = await waitForScan(state);

  assert.equal(scan.state, 'completed');
  assert.match(scan.warning, /metadata enrichment is not available/i);
});

test('a changed file gets a fresh record even during a quick scan', async () => {
  const rootPath = await makeLibrary(['changing.mkv']);
  const { scanner, state } = makeHarness({ roots: [{ id: 'root-1', path: rootPath }] });
  await scanner.start({ mode: 'quick' });
  await waitForScan(state);
  state.catalog[0].plot = 'Stale enrichment.';

  await fs.writeFile(path.join(rootPath, 'changing.mkv'), 'different-longer-fake-video-bytes');
  await scanner.start({ mode: 'quick' });
  await waitForScan(state);

  assert.equal(state.catalog[0].plot, undefined, 'a resized file must not keep stale enrichment');
});

test('starting a scan with no roots fails with a clear error', async () => {
  const { scanner } = makeHarness({ roots: [] });
  await assert.rejects(() => scanner.start({}), (error) => error.status === 400);
});
