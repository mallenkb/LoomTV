import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { organizationFixture } from './helpers/organizationFixture.ts';
import { createCleanupStore, findLeftovers } from '../src/main/libraryCleanup.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';
import { inventoryIdentity } from '../src/main/fileRename/importInventory.ts';

test('a standalone movie returns to its first flat name after repeated moves', (t) => {
  const f = organizationFixture(t);
  const original = f.file('Runner.2026.WEB-DL.mkv');
  f.setItems([f.item(original)]);
  f.organize();
  const record = f.inventory.all()[0];
  assert.ok(record);
  const organized = f.data().movies[0].filePath;
  assert.match(organized, /Runner \(2026\)/);
  const later = path.join(path.dirname(organized), 'Runner (2026) - later.mkv');
  fs.renameSync(organized, later);
  f.inventory.moved([{ from: organized, to: later, role: 'video' }]);
  f.setItems([f.item(later)]);
  assert.equal(f.inventory.originalPath(later), original);
  f.executor.restoreOriginal(record.id);
  assert.equal(fs.readFileSync(original, 'utf8'), 'video');
  assert.equal(fs.existsSync(path.dirname(organized)), false);
  assert.ok(f.inventory.get(record.id)?.restoredAt);
  assert.equal(f.executor.plan().entries.length, 0, 'restoration is not reversed by automatic organization');
});

test('a folder snapshot includes hidden files, available clutter, and empty directories', (t) => {
  const f = organizationFixture(t);
  const original = f.file('Runner.2026.WEB-DL/Runner.2026.WEB-DL.mkv');
  f.file('Runner.2026.WEB-DL/.hidden-reference', 'keep');
  f.file('Runner.2026.WEB-DL/downloaded-from.txt', 'advert');
  fs.mkdirSync(path.join(path.dirname(original), 'empty'));
  f.setItems([f.item(original)]);
  f.organize();
  const record = f.inventory.all()[0];
  assert.ok(record.entries.some((entry) => entry.original.endsWith('.hidden-reference')));
  const cleanup = createCleanupStore(() => f.database, path.join(f.directory, 'holding'), {
    beforeHold: (paths) => f.inventory.capturePaths(paths, [f.root]),
    moved: (from, to, held) => f.inventory.moved([{ from, to, role: 'sidecar' }], held),
  });
  cleanup.hold(findLeftovers([f.root]));
  const heldRecord = f.inventory.get(record.id);
  assert.ok(heldRecord);
  cleanup.restoreImport(heldRecord);
  f.executor.restoreOriginal(record.id);
  assert.equal(fs.readFileSync(path.join(path.dirname(original), '.hidden-reference'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(path.dirname(original), 'downloaded-from.txt'), 'utf8'), 'advert');
  assert.ok(fs.statSync(path.join(path.dirname(original), 'empty')).isDirectory());
  assert.ok(f.inventory.get(record.id)?.restoredAt);
});

for (const category of ['tv', 'anime'] as const) {
  test(`${category}: a new episode in an existing show root uses Season 02 and restores to the root`, (t) => {
    const f = organizationFixture(t);
    const first = f.file('Person of Interest (2011)/Season 01/S01E01 - Pilot.mkv');
    fs.mkdirSync(path.join(f.root, 'Person of Interest (2011)/Season 02'));
    const show = (files: Array<{ filePath: string; season: number; episode: number }>) => f.item(path.join(f.root, 'Person of Interest (2011)'), {
      type: category, title: 'Person of Interest', year: 2011, episodeFiles: files,
      episodes: [{ season: 1, number: 1, title: 'Pilot' }, { season: 2, number: 5, title: 'Bury the Lede' }] as MediaItem['episodes'],
    });
    f.setItems([show([{ filePath: first, season: 1, episode: 1 }])]);
    f.inventory.captureLibrary([...f.data().tvShows, ...f.data().animeShows], [f.root]);
    const incoming = f.file('Person of Interest (2011)/Person.of.Interest.S02E05.mkv');
    f.setItems([show([{ filePath: first, season: 1, episode: 1 }, { filePath: incoming, season: 2, episode: 5 }])]);
    f.organize();
    const second = f.inventory.all().find((record) => record.entries.some((entry) => entry.original === incoming));
    assert.ok(second);
    assert.ok(fs.existsSync(path.join(f.root, 'Person of Interest (2011)/Season 02/S02E05 - Bury the Lede.mkv')));
    f.executor.restoreOriginal(second.id);
    assert.ok(fs.existsSync(incoming));
    assert.ok(fs.existsSync(first));
    assert.ok(fs.statSync(path.join(f.root, 'Person of Interest (2011)/Season 02')).isDirectory(), 'a pre-existing season folder stays');
    const again = f.executor.plan({ importId: second.id });
    assert.ok(again.entries.length);
    f.executor.apply(again.entries.map((entry) => entry.id), false, second.id);
    assert.ok(fs.existsSync(path.join(f.root, 'Person of Interest (2011)/Season 02/S02E05 - Bury the Lede.mkv')));
    f.executor.restoreOriginal(second.id);
    assert.ok(fs.existsSync(incoming));
    assert.ok(fs.existsSync(first));
  });
}


test('deletion preserves history without bytes, and the same path gets a fresh import', (t) => {
  const f = organizationFixture(t);
  const original = f.file('Runner.mkv');
  f.inventory.captureLibrary([f.item(original)], [f.root], 1);
  const old = f.inventory.all()[0];
  fs.unlinkSync(original);
  f.inventory.reconcile([f.root], 2);
  assert.equal(f.inventory.get(old.id)?.removedAt, 2);
  assert.throws(() => f.inventory.requestRestore(old.id), /available/);
  f.file('Runner.mkv', 'new video');
  f.inventory.captureLibrary([f.item(original)], [f.root], 3);
  assert.equal(f.inventory.all().length, 2);
  assert.notEqual(f.inventory.all()[1].id, old.id);
  assert.equal(f.inventory.all()[1].entries[0].original, original);
});

test('an unscanned or inaccessible root is not marked deleted', (t) => {
  const f = organizationFixture(t);
  const video = f.file('Runner.mkv');
  f.inventory.captureLibrary([f.item(video)], [f.root]);
  fs.renameSync(f.root, `${f.root}-unplugged`);
  f.inventory.reconcile([]);
  f.inventory.reconcile([f.root]);
  assert.equal(f.inventory.all()[0].removedAt, 0);
});

test('occupied destinations and later contents survive restore', (t) => {
  const f = organizationFixture(t);
  const original = f.file('Runner.2026.mkv');
  f.setItems([f.item(original)]);
  f.organize();
  const id = f.inventory.all()[0].id;
  f.file('Runner.2026.mkv', 'different video');
  f.file('Runner (2026)/later-note.txt', 'later');
  const blocked = f.executor.restoreOriginal(id);
  assert.equal(blocked.issues.length, 1);
  assert.equal(fs.readFileSync(original, 'utf8'), 'different video');
  fs.unlinkSync(original);
  f.executor.restoreOriginal(id);
  assert.equal(fs.readFileSync(original, 'utf8'), 'video');
  assert.equal(fs.readFileSync(path.join(f.root, 'Runner (2026)/later-note.txt'), 'utf8'), 'later');
});

test('a changed file at a recorded path is not restored as the old import', (t) => {
  const f = organizationFixture(t);
  const original = f.file('Runner.2026.mkv');
  f.setItems([f.item(original)]);
  f.organize();
  const record = f.inventory.all()[0];
  fs.writeFileSync(record.entries[0].current, 'replacement video');
  assert.notEqual(inventoryIdentity(record.entries[0].current), record.entries[0].identity);
  assert.equal(f.executor.restoreOriginal(record.id).issues.length, 1);
  assert.equal(fs.existsSync(original), false);
});


test('a parent-only rename records every contained original path before moving', (t) => {
  const f = organizationFixture(t);
  const original = f.file('Runner.WEB-DL/Runner (2026).mkv');
  const hidden = f.file('Runner.WEB-DL/.download-source', 'source');
  f.setItems([f.item(original)]);
  const result = f.organize();
  assert.equal(result.renamed, 1);
  const record = f.inventory.all()[0];
  assert.ok(record.entries.some((entry) => entry.original === hidden));
  assert.equal(f.inventory.originalPath(f.data().movies[0].filePath), original);
  f.executor.restoreOriginal(record.id);
  assert.ok(fs.existsSync(original));
  assert.ok(fs.existsSync(hidden));
});

for (const category of ['tv', 'anime'] as const) {
  test(`${category}: a duplicate episode dropped in the show root is left for review`, (t) => {
    const f = organizationFixture(t);
    const existing = f.file('Person of Interest (2011)/Season 02/S02E05 - Bury the Lede.mkv');
    const duplicate = f.file('Person of Interest (2011)/Person.of.Interest.S02E05.mp4');
    f.setItems([f.item(path.join(f.root, 'Person of Interest (2011)'), {
      type: category, title: 'Person of Interest', year: 2011,
      episodeFiles: [{ filePath: existing, season: 2, episode: 5 }, { filePath: duplicate, season: 2, episode: 5 }],
      episodes: [{ season: 2, number: 5, title: 'Bury the Lede' }] as MediaItem['episodes'],
    })]);
    const plan = f.executor.plan();
    assert.equal(plan.entries.some((entry) => entry.from === duplicate), false);
    assert.ok(plan.skipped.some((skip) => /duplicate/.test(skip.reason)));
    assert.ok(fs.existsSync(existing));
    assert.ok(fs.existsSync(duplicate));
  });
}


test('metadata rename after restore preserves the first names and other restored imports', (t) => {
  const f = organizationFixture(t);
  const runner = f.file('Runner.2026.WEB-DL.mkv');
  const other = f.file('Other.2025.WEB-DL.mkv');
  f.setItems([f.item(runner), f.item(other, { title: 'Other', year: 2025, providerIds: { tmdbId: '456' } })]);
  f.organize();
  const first = f.inventory.all().find((record) => record.entries.some((entry) => entry.original === runner));
  const second = f.inventory.all().find((record) => record.entries.some((entry) => entry.original === other));
  assert.ok(first);
  assert.ok(second);
  f.executor.restoreOriginal(first.id);
  f.executor.restoreOriginal(second.id);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const preview = f.executor.plan({ importId: first.id });
    assert.ok(preview.entries.length, JSON.stringify(preview));
    assert.ok(f.inventory.protection()(runner), 'preview does not remove restore protection');
    assert.equal(f.executor.plan().entries.length, 0, 'cancelling preview leaves automatic organization blocked');
    f.executor.apply(preview.entries.map((entry) => entry.id), false, first.id);
    assert.equal(fs.existsSync(runner), false);
    assert.equal(fs.readFileSync(other, 'utf8'), 'video');
    assert.ok(f.inventory.get(second.id)?.restoreRequestedAt);
    assert.equal(f.inventory.get(first.id)?.restoreRequestedAt, 0);
    f.executor.restoreOriginal(first.id);
    assert.equal(fs.readFileSync(runner, 'utf8'), 'video');
    assert.equal(f.inventory.get(first.id)?.entries.find((entry) => entry.video)?.original, runner);
  }
});

test('metadata rename rejects stale approval without releasing restoration protection', (t) => {
  const f = organizationFixture(t);
  const original = f.file('Runner.2026.mkv');
  f.setItems([f.item(original)]);
  f.organize();
  const id = f.inventory.all()[0].id;
  f.executor.restoreOriginal(id);
  const planned = f.executor.plan({ importId: id });
  f.setItems([f.item(original, { title: 'Other', year: 2025, providerIds: { tmdbId: '456' } })]);
  assert.throws(() => f.executor.apply(planned.entries.map((entry) => entry.id), false, id), /changed since the preview/);
  assert.ok(f.inventory.get(id)?.restoreRequestedAt);
  assert.equal(fs.readFileSync(original, 'utf8'), 'video');
});
