import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { organizationFixture } from './helpers/organizationFixture.ts';
import { CLEANUP_RETENTION_MS, createCleanupStore, findLeftovers, findRedundantSubtitles, type EmbeddedTrack } from '../src/main/libraryCleanup.ts';
import { fileStamp, planFileTransfer, resumeFileTransfer } from '../src/main/fileRename/recoverableFileMove.ts';

test('partial restore retains the blocked original through expiry and allows retry', (t) => {
  const f = organizationFixture(t);
  const note = f.file('downloaded-from.txt', 'original');
  const store = createCleanupStore(() => f.database, path.join(f.directory, 'holding'));
  const batch = store.hold(findLeftovers([f.root]), 1);
  assert.ok(batch);
  f.file('downloaded-from.txt', 'replacement');
  assert.deepEqual(store.restore(batch.id, 2), { restored: 0, skipped: [note] });
  assert.equal(store.history()[0].restoredAt, 0);
  store.purgeExpired(CLEANUP_RETENTION_MS + 10);
  assert.equal(fs.readFileSync(batch.items[0].held, 'utf8'), 'original');
  fs.unlinkSync(note);
  assert.deepEqual(store.restore(batch.id, 3), { restored: 1, skipped: [] });
  assert.equal(fs.readFileSync(note, 'utf8'), 'original');
});

test('a crash after moving but before committing inventory is recoverable', (t) => {
  const f = organizationFixture(t);
  f.file('downloaded-from.txt', 'original');
  let fail = true;
  const store = createCleanupStore(() => f.database, path.join(f.directory, 'holding'), {
    moved: () => { if (fail) throw new Error('simulated commit failure'); },
  });
  const batch = store.hold(findLeftovers([f.root]));
  assert.ok(batch);
  assert.equal(store.history()[0].items[0].state, 'holding');
  assert.ok(fs.existsSync(batch.items[0].held));
  fail = false;
  store.recoverInterrupted();
  assert.equal(store.history()[0].items[0].state, 'held');
  assert.equal(store.restore(batch.id).restored, 1);
});

test('journal write failure leaves the source untouched', (t) => {
  const f = organizationFixture(t);
  const note = f.file('downloaded-from.txt');
  const store = createCleanupStore(() => f.database, path.join(f.directory, 'holding'), { beforeHold: () => { throw new Error('database unavailable'); } });
  assert.throws(() => store.hold(findLeftovers([f.root])), /database unavailable/);
  assert.ok(fs.existsSync(note));
});

test('hidden and newly added content is never swept with a clutter folder', (t) => {
  const f = organizationFixture(t);
  f.file('extras/downloaded-from.txt');
  const hidden = f.file('extras/.reference');
  const unknown = f.file('extras/notes.txt');
  const candidates = findLeftovers([f.root]);
  const video = f.file('extras/new-video.mkv');
  assert.ok(candidates.every((candidate) => fs.statSync(candidate.path).isFile()));
  const store = createCleanupStore(() => f.database, path.join(f.directory, 'holding'));
  store.hold(candidates);
  assert.ok(fs.existsSync(video));
  assert.ok(fs.existsSync(hidden));
  assert.ok(fs.existsSync(unknown));
});

test('a changed candidate is left in place', (t) => {
  const f = organizationFixture(t);
  const file = f.file('downloaded-from.txt');
  const candidates = findLeftovers([f.root]);
  fs.writeFileSync(file, 'changed file');
  const store = createCleanupStore(() => f.database, path.join(f.directory, 'holding'));
  assert.equal(store.hold(candidates), null);
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed file');
});

test('transfer recovery handles the crash window with both paths present', (t) => {
  const f = organizationFixture(t);
  const from = f.file('downloaded-from.txt', 'original');
  const to = path.join(f.directory, 'holding', 'note.txt');
  const transfer = planFileTransfer(from, to);
  assert.throws(() => resumeFileTransfer(transfer, () => { if (transfer.phase === 'published') throw new Error('crash'); }), /crash/);
  assert.ok(fs.existsSync(from));
  assert.ok(fs.existsSync(to));
  resumeFileTransfer(transfer, () => undefined);
  assert.equal(fs.existsSync(from), false);
  assert.equal(fs.readFileSync(to, 'utf8'), 'original');
});

test('an occupied transfer destination is never overwritten', (t) => {
  const f = organizationFixture(t);
  const from = f.file('original.txt', 'original');
  const to = f.file('occupied.txt', 'occupied');
  assert.throws(() => resumeFileTransfer(planFileTransfer(from, to), () => undefined), /occupied/);
  assert.equal(fs.readFileSync(from, 'utf8'), 'original');
  assert.equal(fs.readFileSync(to, 'utf8'), 'occupied');
});

test('subtitle policy requires the same known language and purpose', async (t) => {
  const f = organizationFixture(t);
  f.file('Movie.mkv');
  f.file('Movie.en.srt');
  f.file('Movie.es.srt');
  f.file('Movie.srt');
  f.file('Movie.en.sdh.srt');
  f.file('Movie.en.hi.srt');
  f.file('Movie.en.forced.srt');
  const track: EmbeddedTrack = { index: 2, codec: 'ass', language: 'eng', title: 'Full dialogue', forced: false };
  const tools = { probe: async () => [track], convert: async () => '', extract: async () => '' };
  assert.deepEqual((await findRedundantSubtitles([f.root], tools)).map((candidate) => path.basename(candidate.path)), ['Movie.en.srt']);
  track.title = 'Signs & Songs';
  assert.deepEqual(await findRedundantSubtitles([f.root], tools), []);
  track.title = '';
  assert.deepEqual(await findRedundantSubtitles([f.root], tools), [], 'uncertain coverage keeps external files');
});

test('changed video invalidates a subtitle removal candidate', async (t) => {
  const f = organizationFixture(t);
  const video = f.file('Movie.mkv');
  const subtitle = f.file('Movie.en.srt');
  const candidates = await findRedundantSubtitles([f.root], { probe: async () => [{ index: 2, codec: 'ass', language: 'eng', title: 'Full', forced: false }], convert: async () => '', extract: async () => '' });
  assert.equal(candidates[0].stamp, fileStamp(subtitle));
  fs.writeFileSync(video, 'replacement without subtitles');
  const store = createCleanupStore(() => f.database, path.join(f.directory, 'holding'));
  assert.equal(store.hold(candidates), null);
  assert.ok(fs.existsSync(subtitle));
});
