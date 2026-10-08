import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { backupDestinationOverlapsLiveDatabase } from '../src/main/backupDestination.ts';

test('backup destinations may not replace a live database, its sidecars, or an alias of either', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'loomtv-backup-destination-'));
  const userData = path.join(root, 'LoomTV');
  mkdirSync(userData);
  const live = path.join(userData, 'loomtv.sqlite');
  writeFileSync(live, 'db');
  writeFileSync(`${live}-wal`, 'wal');
  symlinkSync(userData, path.join(root, 'alias'));
  linkSync(live, path.join(root, 'hardlink.sqlite'));
  const protectedPaths = [live, path.join(userData, 'loomtv-canonical.sqlite')];

  try {
    assert.equal(backupDestinationOverlapsLiveDatabase(live, protectedPaths), true);
    assert.equal(backupDestinationOverlapsLiveDatabase(`${live}-wal`, protectedPaths), true);
    assert.equal(backupDestinationOverlapsLiveDatabase(`${live}-shm`, protectedPaths), true);
    assert.equal(backupDestinationOverlapsLiveDatabase(path.join(userData, 'loomtv-canonical.sqlite'), protectedPaths), true);
    assert.equal(backupDestinationOverlapsLiveDatabase(path.join(root, 'alias', 'loomtv.sqlite'), protectedPaths), true);
    assert.equal(backupDestinationOverlapsLiveDatabase(path.join(root, 'hardlink.sqlite'), protectedPaths), true);
    if (process.platform === 'darwin') {
      assert.equal(backupDestinationOverlapsLiveDatabase(path.join(userData, 'LoomTV.sqlite'), protectedPaths), true);
    }

    assert.equal(backupDestinationOverlapsLiveDatabase(path.join(userData, 'loomtv-backup-2026-10-08.sqlite'), protectedPaths), false);
    assert.equal(backupDestinationOverlapsLiveDatabase(path.join(root, 'elsewhere', 'loomtv.sqlite'), protectedPaths), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
