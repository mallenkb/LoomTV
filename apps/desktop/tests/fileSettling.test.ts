import assert from 'node:assert/strict';
import test from 'node:test';
import { QUIET_MS, STABLE_CHECK_MS, createFileSettling } from '../src/main/fileRename/fileSettling.ts';

const NOW = 1_800_000_000_000;

function settling(files: Record<string, { size: number; mtimeMs: number; ctimeMs?: number }>, entries: string[] = []) {
  return createFileSettling({
    stat: (filePath) => {
      const file = files[filePath];
      return file ? { ctimeMs: file.mtimeMs, ...file } : null;
    },
    listDirectory: () => [...entries, ...Object.keys(files).map((filePath) => filePath.split('/').pop() || '')],
  });
}

test('a file nothing wrote to for a minute is organized at once', () => {
  const check = settling({ '/m/Runner.mkv': { size: 10, mtimeMs: NOW - QUIET_MS } });
  assert.equal(check.waitMs('/m/Runner.mkv', NOW), 0);
});

test('a just-finished download is organized after two equal looks seconds apart', () => {
  const files = { '/m/One Night Only.mkv': { size: 1_618_359_708, mtimeMs: NOW - 2_000 } };
  const check = settling(files);
  assert.equal(check.waitMs('/m/One Night Only.mkv', NOW), STABLE_CHECK_MS);
  assert.equal(check.waitMs('/m/One Night Only.mkv', NOW + 2_000), STABLE_CHECK_MS - 2_000);
  assert.equal(check.waitMs('/m/One Night Only.mkv', NOW + STABLE_CHECK_MS), 0);
});

test('a growing file keeps waiting', () => {
  const files = { '/m/Copying.mkv': { size: 100, mtimeMs: NOW } };
  const check = settling(files);
  check.waitMs('/m/Copying.mkv', NOW);
  files['/m/Copying.mkv'] = { size: 200, mtimeMs: NOW + STABLE_CHECK_MS };
  assert.ok(check.waitMs('/m/Copying.mkv', NOW + STABLE_CHECK_MS) > 0);
});

test("a download manager's partial file for the same name keeps it waiting", () => {
  const check = settling({ '/m/Movie.mkv': { size: 1, mtimeMs: NOW - 10 * QUIET_MS } }, ['Movie.mkv.crdownload']);
  assert.ok(check.waitMs('/m/Movie.mkv', NOW) > 0);
  const other = settling({ '/m/Movie.mkv': { size: 1, mtimeMs: NOW - 10 * QUIET_MS } }, ['Other.mkv.fdmdownload']);
  assert.equal(other.waitMs('/m/Movie.mkv', NOW), 0, "another file's download does not hold this one");
});

test('a recent copy whose dates were set back is still checked', () => {
  // Finder keeps the original modified date but the status change is new.
  const check = settling({ '/m/Copied.mkv': { size: 5, mtimeMs: NOW - 365 * 86_400_000, ctimeMs: NOW - 1_000 } });
  assert.ok(check.waitMs('/m/Copied.mkv', NOW) > 0);
});
