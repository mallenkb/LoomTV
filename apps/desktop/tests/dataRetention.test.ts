import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pruneObsoleteData } from '../src/main/dataRetention.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 2);

function write(dir: string, relative: string, bytes = 10, ageDays = 90): string {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(bytes));
  const seconds = (NOW - ageDays * DAY) / 1000;
  fs.utimesSync(target, seconds, seconds);
  fs.utimesSync(path.dirname(target), seconds, seconds);
  return target;
}

function userData(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-retention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('removes only data Loom created and no longer needs', (t) => {
  const dir = userData(t);
  const committed = 'legacy-42ec4e46f0d9546d40a6bbd8fbd81427';
  const other = 'legacy-44cfabc771b788e62404546e42fd0909';
  const keep = [
    write(dir, `loomtv-migration/backups/canonical-cutover-${committed}/desktop-source-1.sqlite`),
    write(dir, 'backups/loomtv-before-tauri-1788712445105.sqlite'),
    write(dir, 'loomtv-before-media-repair-20260909.sqlite'),
    write(dir, 'loomtv.sqlite'),
    write(dir, 'artwork-cache/ab/cd.jpg'),
    write(dir, `.loomtv-canonical.sqlite.legacy-aaaa.stage`),
    write(dir, `.loomtv-canonical.sqlite.legacy-aaaa.stage-wal`),
  ];
  const remove = [
    write(dir, `loomtv-migration/backups/canonical-cutover-${other}/desktop-source-1.sqlite`, 1000),
    write(dir, 'Cache/tauri-transcodes/session/segment.ts', 500),
    write(dir, 'tauri-shared-storage-v1/state.json'),
    write(dir, `.loomtv-canonical.sqlite.${committed}.stage-shm`),
    write(dir, 'loomtv-pre-profiles-backup.sqlite', 300),
  ];
  const removed = pruneObsoleteData({ userDataDir: dir, now: NOW, committedMigrationId: committed, profilesMigrationComplete: true });
  for (const file of keep) assert.ok(fs.existsSync(file), `kept ${path.relative(dir, file)}`);
  for (const file of remove) assert.equal(fs.existsSync(file), false, `removed ${path.relative(dir, file)}`);
  assert.equal(removed.length, 5);
  assert.ok(removed.reduce((total, entry) => total + entry.bytes, 0) >= 1800);
});

test('keeps every cutover backup when the committed migration is unknown', (t) => {
  const dir = userData(t);
  const backup = write(dir, 'loomtv-migration/backups/canonical-cutover-legacy-44cf/desktop-source-1.sqlite');
  pruneObsoleteData({ userDataDir: dir, now: NOW, committedMigrationId: null, profilesMigrationComplete: true });
  assert.ok(fs.existsSync(backup));
});

test('keeps recent backups and the pre-profiles copy until the migration is done', (t) => {
  const dir = userData(t);
  const recentCutover = write(dir, 'loomtv-migration/backups/canonical-cutover-legacy-44cf/desktop-source-1.sqlite', 10, 5);
  const preProfiles = write(dir, 'loomtv-pre-profiles-backup.sqlite');
  pruneObsoleteData({ userDataDir: dir, now: NOW, committedMigrationId: 'legacy-42ec', profilesMigrationComplete: false });
  assert.ok(fs.existsSync(recentCutover));
  assert.ok(fs.existsSync(preProfiles));
});
