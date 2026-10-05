import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFileSettling, hasPartialSibling, QUIET_MS, STABLE_CHECK_MS } from '../src/main/fileRename/fileSettling.ts';
import { planRenames } from '../src/main/fileRename/renamePlanner.ts';
import { findLeftovers } from '../src/main/libraryCleanup.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';

const NOW = 1_800_000_000_000;

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-partials-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'Show');
  const directory = path.join(folder, 'Season 1');
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'Show.S01E01.mkv');
  const note = path.join(directory, 'Visit our website.txt');
  fs.writeFileSync(source, 'video');
  fs.writeFileSync(note, 'note');
  const listDirectory = (directory: string) => {
    try { return fs.readdirSync(directory); } catch { return null; }
  };
  const item = {
    id: 'show', type: 'tv', title: 'Show', year: 2026, filePath: folder,
    providerIds: { tvdbId: '1' }, episodeFiles: [{ season: 1, episode: 1, filePath: source }],
    episodes: [{ season: 1, number: 1, title: 'The First Day' }],
  } as MediaItem;
  const plan = (isRecentlyModified?: (filePath: string) => boolean) => planRenames({
    items: [item], libraryRoots: [root], listDirectory,
    isLocked: () => false, sameDrive: () => true, isRecentlyModified,
  });
  const settling = createFileSettling({
    stat: () => ({ size: 10, mtimeMs: NOW - 10 * QUIET_MS, ctimeMs: NOW - 10 * QUIET_MS }),
    listDirectory,
  });
  return { root, directory, source, note, plan, settling, listDirectory };
}

for (const suffix of ['.part', '.partial', '.crdownload', '.download', '.fdmdownload', '.opdownload', '.!qB', '.!ut', '.aria2']) {
  for (const extension of [suffix, suffix.toUpperCase()]) {
    test(`settling, folder planning and cleanup agree on ${extension} markers`, (t) => {
      const { root, source, note, plan, settling } = fixture(t);
      const ready = plan();
      assert.ok(ready.entries.length > 0, JSON.stringify(ready.skipped));
      assert.deepEqual(findLeftovers([root]).map((candidate) => candidate.path), [note]);
      settling.waitMs(source, NOW);
      assert.equal(settling.waitMs(source, NOW + STABLE_CHECK_MS), 0);

      fs.writeFileSync(`${source}${extension}`, 'partial');
      fs.writeFileSync(`${note}${extension}`, 'partial');
      assert.equal(settling.waitMs(source, NOW + STABLE_CHECK_MS), STABLE_CHECK_MS);
      assert.equal(settling.waitMs(source, NOW + 2 * STABLE_CHECK_MS), STABLE_CHECK_MS);
      if (suffix !== '.aria2') {
        assert.equal(settling.waitMs(`${source}${extension}`, NOW), STABLE_CHECK_MS);
        assert.equal(settling.waitMs(`${source}${extension}`, NOW + STABLE_CHECK_MS), STABLE_CHECK_MS);
      }
      const blocked = plan();
      assert.deepEqual(blocked.entries, []);
      assert.match(blocked.skipped[0]?.reason || '', /still downloading/);
      assert.deepEqual(findLeftovers([root]), []);

      fs.unlinkSync(`${source}${extension}`);
      fs.unlinkSync(`${note}${extension}`);
      assert.ok(plan().entries.length > 0);
      assert.deepEqual(findLeftovers([root]).map((candidate) => candidate.path), [note]);
      assert.equal(settling.waitMs(source, NOW + 2 * STABLE_CHECK_MS), STABLE_CHECK_MS);
      assert.equal(settling.waitMs(source, NOW + 3 * STABLE_CHECK_MS), 0);
    });
  }
}

test('sibling markers compare extension case but keep the complete base name', () => {
  assert.equal(hasPartialSibling('Movie.mkv', ['Movie.mkv.ARIA2']), true);
  assert.equal(hasPartialSibling('Movie.mkv', ['Movie.mkv.!QB']), true);
  assert.equal(hasPartialSibling('Movie.mkv', ['Other.mkv.PART', 'Movie.mkv.part.backup', 'Movie.mkv2.part']), false);
  assert.equal(hasPartialSibling('Movie.mkv', ['movie.mkv.part']), false);
});

test('bare hidden partial names keep waiting as they did with the suffix check', () => {
  const settling = createFileSettling({
    stat: () => ({ size: 10, mtimeMs: 0, ctimeMs: 0 }),
    listDirectory: () => ['.PART'],
  });
  assert.equal(settling.waitMs('/m/.PART', NOW), STABLE_CHECK_MS);
  assert.equal(settling.waitMs('/m/.PART', NOW + STABLE_CHECK_MS), STABLE_CHECK_MS);
});

for (const name of ['Show.S01E01.en.ass', 'poster.jpg', 'movie.nfo', 'notes.txt', 'archive.zip', '.copy-state', 'Extras/info.txt', '.sync/info.txt']) {
  for (const timestamp of ['mtimeMs', 'ctimeMs'] as const) {
    test(`folder planning waits the settling quiet window for ${name}'s ${timestamp}`, (t) => {
      const { directory, source, note, plan, listDirectory } = fixture(t);
      const recent = path.join(directory, name);
      fs.mkdirSync(path.dirname(recent), { recursive: true });
      fs.writeFileSync(recent, 'copy');
      let now = NOW;
      const settling = createFileSettling({
        stat: (filePath) => {
          assert.ok(fs.statSync(filePath).isFile(), 'folder timestamps do not count as file writes');
          return { size: 10, mtimeMs: NOW - 10 * QUIET_MS, ctimeMs: NOW - 10 * QUIET_MS,
            ...(filePath === recent ? { [timestamp]: NOW - 1_000 } : {}) };
        },
        listDirectory,
      });
      for (const filePath of [source, note, recent]) settling.waitMs(filePath, NOW - STABLE_CHECK_MS);
      const check = (filePath: string) => settling.waitMs(filePath, now) > 0;
      const blocked = plan(check);
      assert.deepEqual(blocked.entries, []);
      assert.ok(blocked.skipped.some((skip) => skip.reason.includes(path.basename(recent)) && /still being copied/.test(skip.reason)));
      now = NOW + QUIET_MS - 1_001;
      assert.deepEqual(plan(check).entries, []);
      now += 1;
      assert.ok(plan(check).entries.length > 0, 'folder changes resume at the unchanged quiet-window boundary');
    });
  }
}

test('folder planning checks files inside directories with media extensions', (t) => {
  const { directory, plan } = fixture(t);
  const folder = path.join(directory, 'Extras.jpg');
  fs.mkdirSync(folder);
  const recent = path.join(folder, 'notes.txt');
  fs.writeFileSync(recent, 'copy');
  const blocked = plan((filePath) => {
    assert.notEqual(filePath, folder);
    return filePath === recent;
  });
  assert.deepEqual(blocked.entries, []);
  assert.ok(blocked.skipped.some((skip) => /notes.txt.*still being copied/.test(skip.reason)));
});

test('browsing a folder in Finder does not hold back folder changes', (t) => {
  const { directory, plan } = fixture(t);
  for (const name of ['.DS_Store', '._Show.S01E01.mkv', '.localized']) fs.writeFileSync(path.join(directory, name), 'metadata');
  assert.ok(plan(() => true).entries.length === 0, 'visible files written just now still block');
  const metadataOnly = plan((filePath) => /^(?:\.DS_Store|\._.*|\.localized)$/.test(path.basename(filePath)));
  assert.ok(metadataOnly.entries.length > 0, JSON.stringify(metadataOnly.skipped));
});

test('non-video partial files also block parent folder changes', (t) => {
  const { directory, plan } = fixture(t);
  fs.writeFileSync(path.join(directory, '.copy-state.OPDOWNLOAD'), 'partial');
  assert.deepEqual(plan().entries, []);
  assert.match(plan().skipped[0]?.reason || '', /still downloading/);
});
