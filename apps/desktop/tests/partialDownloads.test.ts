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
  const plan = () => planRenames({
    items: [item], libraryRoots: [root], listDirectory,
    isLocked: () => false, sameDrive: () => true,
  });
  const settling = createFileSettling({
    stat: () => ({ size: 10, mtimeMs: NOW - 10 * QUIET_MS, ctimeMs: NOW - 10 * QUIET_MS }),
    listDirectory,
  });
  return { root, source, note, plan, settling };
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

