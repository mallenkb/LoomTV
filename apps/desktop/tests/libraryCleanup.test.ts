import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { organizationFixture } from './helpers/organizationFixture.ts';
import { fileStamp } from '../src/main/fileRename/recoverableFileMove.ts';
import {
  CLEANUP_RETENTION_MS,
  createCleanupStore,
  findLeftovers,
  findRedundantSubtitles,
  parseSrtCues,
  sameSubtitles,
  withoutRemovedSubtitles,
  type EmbeddedTrack,
  type SubtitleTools,
} from '../src/main/libraryCleanup.ts';

function library(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (relative: string, content = 'x') => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  return { root, file };
}

const rel = (root: string, candidates: Array<{ path: string; reason: string }>) =>
  candidates.map((candidate) => `${candidate.reason} ${path.relative(root, candidate.path)}`).sort();

test('recognized download notes and site logos are individual leftovers', (t) => {
  const { root, file } = library(t);
  file('Movies/Sound of Freedom (2023)/Sound of Freedom (2023).mkv');
  file('Movies/Sound of Freedom (2023)/[TGx]Downloaded from torrentgalaxy.to .txt');
  file('Movies/Tai Chi Master (1993)/Tai Chi Master (1993).mp4');
  file('Movies/Tai Chi Master (1993)/Tai Chi Master (1993).srt');
  file('Movies/Tai Chi Master (1993)/www.YTS.MX.jpg');
  file('Movies/Tai Chi Master (1993)/poster.jpg');
  file('Movies/Tai Chi Master (1993)/Tai Chi Master (1993)-thumb.jpg');
  file('Movies/Tai Chi Master (1993)/movie.nfo');
  file('TV/Lioness (2023)/Season 01/S01E01 - Sand Paper.mkv');
  file('TV/Lioness (2023)/Season 01/Torrent Downloaded From/Torrent Downloaded From 1337x.to.txt');
  file('TV/Lioness (2023)/Season 01/Torrent Downloaded From/Torrent Downloaded From Glodls.to.txt');
  file('TV/SEAL Team (2017)/Season 05/S05E14.mkv.fdmdownload');
  file('TV/Show (2020)/Season 01/archive.rar');
  file('TV/.hidden/notes.txt');
  file('Movies/Thumbs.db');
  assert.deepEqual(rel(root, findLeftovers([path.join(root, 'Movies'), path.join(root, 'TV')])), [
    'download-note Movies/Sound of Freedom (2023)/[TGx]Downloaded from torrentgalaxy.to .txt',
    'download-note Movies/Thumbs.db',
    'download-note TV/Lioness (2023)/Season 01/Torrent Downloaded From/Torrent Downloaded From 1337x.to.txt',
    'download-note TV/Lioness (2023)/Season 01/Torrent Downloaded From/Torrent Downloaded From Glodls.to.txt',
    'not-artwork Movies/Tai Chi Master (1993)/www.YTS.MX.jpg',
  ]);
});

test('unknown notes are preserved and the library folder is never a leftover', (t) => {
  const { root, file } = library(t);
  file('Empty Library/readme.txt');
  assert.deepEqual(rel(root, findLeftovers([path.join(root, 'Empty Library')])), []);
});

const srt = (lines: Array<[string, string]>) => lines.map(([time, text], index) => `${index + 1}\n${time} --> 00:00:59,000\n${text}\n`).join('\n');

test('subtitles count as the same only with the same lines at the same times', () => {
  const base = parseSrtCues(srt([['00:00:01,000', 'Hello there.'], ['00:00:03,000', 'General Kenobi!'], ['00:00:05,000', '<i>You are a bold one.</i>']]));
  const same = parseSrtCues(srt([['00:00:01,100', 'Hello there'], ['00:00:03,000', 'General Kenobi!'], ['00:00:05,000', 'You are a bold one.']]));
  const shifted = parseSrtCues(srt([['00:00:05,000', 'Hello there.'], ['00:00:07,000', 'General Kenobi!'], ['00:00:09,000', 'You are a bold one.']]));
  const other = parseSrtCues(srt([['00:00:01,000', 'Hi.'], ['00:00:03,000', 'Kenobi.'], ['00:00:05,000', 'Bold.']]));
  assert.equal(sameSubtitles(same, base), true);
  assert.equal(sameSubtitles(shifted, base), false, 'out of sync is kept');
  assert.equal(sameSubtitles(other, base), false, 'a different translation is kept');
});

test('full embedded dialogue covers ordinary sidecars even with a different translation', async (t) => {
  const { root, file } = library(t);
  const lines = srt([['00:00:01,000', 'On that day mankind received a grim reminder.'], ['00:00:04,000', 'Everyone get ready to fight!']]);
  file('Anime/Show/Season 01/S01E01.mkv'); file('Anime/Show/Season 01/S01E01.en.srt', lines);
  file('Anime/Show/Season 01/S01E02.mkv'); file('Anime/Show/Season 01/S01E02.en.srt', lines);
  file('Anime/Show/Season 01/S01E03.mkv'); file('Anime/Show/Season 01/S01E03.en.srt', srt([['00:00:02,000', 'Something only episode three says.']]));
  file('Anime/Show/Season 01/S01E03.en.loomtv-clean-dialogue.ass', 'cleaned');
  file('Anime/Show/Season 01/S01E03.en.forced.srt', lines);
  const filmLines = srt([['00:00:01,000', 'A line only the film has.'], ['00:00:03,000', 'And another one.']]);
  file('Movies/Film/Film.mkv'); file('Movies/Film/Film.en.srt', filmLines);
  file('Movies/Other/Other.mkv'); file('Movies/Other/Other.es.srt', filmLines.replace('film', 'other'));
  const english: EmbeddedTrack = { index: 2, codec: 'subrip', language: 'eng', title: 'English [Full]', forced: false };
  const tools: SubtitleTools = {
    probe: async (video) => (video.includes('Other') ? [english] : video.includes('Film') ? [english] : [english]),
    // Episode three's built-in track is a different translation.
    extract: async (video) => (video.includes('Film') ? filmLines : srt([['00:00:02,000', 'A different translation of that line.']])),
    convert: async (sidecar) => fs.readFileSync(sidecar, 'utf8'),
  };
  assert.deepEqual(rel(root, await findRedundantSubtitles([path.join(root, 'Anime'), path.join(root, 'Movies')], tools)), [
    'embedded-coverage Anime/Show/Season 01/S01E01.en.srt',
    'embedded-coverage Anime/Show/Season 01/S01E02.en.srt',
    'embedded-coverage Anime/Show/Season 01/S01E03.en.srt',
    'embedded-coverage Movies/Film/Film.en.srt',
  ]);
});

test('without a built-in track in that language, copies are kept', async (t) => {
  const { root, file } = library(t);
  const lines = srt([['00:00:01,000', 'Line.']]);
  file('TV/Show/S01E01.mkv'); file('TV/Show/S01E01.en.srt', lines);
  file('TV/Show/S01E02.mkv'); file('TV/Show/S01E02.en.srt', lines);
  const tools: SubtitleTools = { probe: async () => [], extract: async () => '', convert: async () => lines };
  assert.deepEqual(await findRedundantSubtitles([path.join(root, 'TV')], tools), []);
});

test('held files can be put back, are remembered, and expire after 30 days', (t) => {
  const { root, file } = library(t);
  const { database } = organizationFixture(t);
  const holding = path.join(root, '.holding');
  const store = createCleanupStore(() => database, holding);
  const note = file('Movies/Film/notes.txt', 'ad');
  const extra = file('Movies/Film/Downloaded From/a.txt');
  const batch = store.hold([{ path: note, reason: 'download-note', stamp: fileStamp(note) }, { path: extra, reason: 'download-note', stamp: fileStamp(extra) }], 1_000);
  assert.ok(batch);
  assert.equal(fs.existsSync(note), false);
  assert.equal(fs.existsSync(extra), false);
  assert.equal(store.history()[0].items.length, 2);

  fs.writeFileSync(note, 'new file in the same place');
  const result = store.restore(batch.id, 2_000);
  assert.deepEqual(result, { restored: 1, skipped: [note] }, 'something now in its place is never overwritten');
  assert.equal(fs.readFileSync(note, 'utf8'), 'new file in the same place');
  assert.ok(fs.existsSync(extra));
  assert.ok(store.restoredPaths().has(path.resolve(extra)));
  assert.equal(store.history()[0].restoredAt, 0);
  assert.equal(fs.readFileSync(batch.items[0].held, 'utf8'), 'ad');
  fs.unlinkSync(note);
  assert.equal(store.restore(batch.id).restored, 1);

  const later = store.hold([{ path: extra, reason: 'download-note', stamp: fileStamp(extra) }], 3_000);
  assert.ok(later);
  assert.equal(store.purgeExpired(3_000 + CLEANUP_RETENTION_MS - 1), 0);
  assert.equal(store.purgeExpired(3_000 + CLEANUP_RETENTION_MS + 1), 1);
  assert.equal(fs.existsSync(later.items[0].held), false);
});

test('removed subtitles leave the catalog', () => {
  const removed = new Set(['/m/Film/Film.en.srt']);
  const items = [{ subtitles: [{ url: '/subtitle?path=%2Fm%2FFilm%2FFilm.en.srt' }, { url: '/subtitle?path=%2Fm%2FFilm%2FFilm.es.srt' }], episodeFiles: [{ subtitles: [{ url: '/subtitle?path=%2Fm%2FFilm%2FFilm.en.srt' }] }] }];
  const result = withoutRemovedSubtitles(items, removed);
  assert.equal(result.changed, true);
  assert.deepEqual(result.items[0].subtitles?.map((subtitle) => subtitle.url), ['/subtitle?path=%2Fm%2FFilm%2FFilm.es.srt']);
  assert.deepEqual(result.items[0].episodeFiles?.[0].subtitles, []);
});
