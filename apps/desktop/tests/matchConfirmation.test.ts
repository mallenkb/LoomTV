import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  confirmationAnchor,
  confirmationIsFresh,
  evaluateConfirmation,
  gatherConfirmation,
  searchTermsFor,
  type ConfirmationSources,
  type MatchConfirmation,
  type SourceRecord,
} from '../src/main/fileRename/matchConfirmation.ts';
import { planRenames } from '../src/main/fileRename/renamePlanner.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';

const movie = { type: 'movie', title: 'One Night Only', year: 2026, providerIds: { tmdbId: '1433367', imdbId: 'tt37853455' } } as const;
const confirmation = (records: SourceRecord[], item: Pick<MediaItem, 'type' | 'title' | 'year' | 'providerIds'> = movie): MatchConfirmation => ({
  checkedAt: 0, anchor: confirmationAnchor(item), searchedTitle: item.title, asked: ['tmdb', 'omdb', 'tvdb'], records,
});
const tmdb: SourceRecord = { source: 'tmdb', ids: { tmdbId: '1433367', imdbId: 'tt37853455' }, title: 'One Night Only', year: 2026 };
const omdb: SourceRecord = { source: 'omdb', ids: { imdbId: 'tt37853455' }, title: 'One Night Only', year: 2026 };

test('two sources pointing to the same title confirm the match', () => {
  const verdict = evaluateConfirmation(movie, confirmation([tmdb, omdb]));
  assert.equal(verdict.status, 'confirmed');
  assert.deepEqual(verdict.confirmedBy, ['tmdb', 'omdb']);
  assert.equal(verdict.note, 'Confirmed by TMDB and OMDb.');
});

test('one source is not enough', () => {
  const verdict = evaluateConfirmation(movie, confirmation([tmdb]));
  assert.equal(verdict.status, 'waiting');
  assert.match(verdict.note, /Only TMDB confirmed/);
});

test('a source that finds a different title blocks the match', () => {
  const other: SourceRecord = { source: 'tvdb', ids: { imdbId: 'tt0000001' }, title: 'One Night Only', year: 2016 };
  const verdict = evaluateConfirmation(movie, confirmation([tmdb, omdb, other]));
  assert.equal(verdict.status, 'conflict');
  assert.match(verdict.note, /TVDB found "One Night Only" \(2016\)/);
});

test('the same title in a year more than one off is a disagreement', () => {
  const late = { ...omdb, year: 2019 };
  assert.equal(evaluateConfirmation(movie, confirmation([tmdb, late])).status, 'conflict');
});

test('anime databases confirm by title and year when they share no IDs', () => {
  const anime = { type: 'anime', title: 'Attack on Titan', year: 2013, providerIds: { tvdbId: '267440' } } as const;
  const anilist: SourceRecord = { source: 'anilist', ids: { malId: '16498' }, title: 'Shingeki no Kyojin', titles: ['Attack on Titan'], year: 2013 };
  const tvdb: SourceRecord = { source: 'tvdb', ids: { tvdbId: '267440' }, title: 'Attack on Titan', year: 2013 };
  const verdict = evaluateConfirmation(anime, confirmation([anilist, tvdb], anime));
  assert.equal(verdict.status, 'confirmed');
  assert.ok(verdict.knownTitles.includes('Shingeki no Kyojin'));
});

test('sources are searched with the file name, and answers about other titles are ignored', async () => {
  const asked: string[] = [];
  const sources: ConfirmationSources = {
    tmdbMovie: async (title, year) => { asked.push(`tmdb:${title}:${year}`); return { title: 'One Night Only', year: 2026, providerIds: { tmdbId: '1433367', imdbId: 'tt37853455' } }; },
    omdb: async () => ({ Title: 'Something Else Entirely', Year: '2026', imdbID: 'tt9' }),
    tvdb: async () => { throw new Error('offline'); },
  };
  const search = searchTermsFor({ type: 'movie', filePath: '/m/One Night Only 2026 1080p WEB-DL HEVC x265 5.1 BONE.mkv', title: 'One Night Only', year: 2026 }, ['/m']);
  assert.deepEqual(search, { title: 'One Night Only', year: 2026 });
  const result = await gatherConfirmation(movie, search, sources, { now: 5 });
  assert.deepEqual(asked, ['tmdb:One Night Only:2026']);
  assert.deepEqual(result.records.map((record) => record.source), ['tmdb'], 'off-title and failing sources abstain');
  assert.equal(evaluateConfirmation(movie, result).status, 'waiting');
});

test('a loose episode is searched by its series name', () => {
  assert.equal(searchTermsFor({ type: 'tv', filePath: '/tv/SEAL.Team.S05E14.720p.AMZN.WEBRip.mkv', title: 'SEAL Team', year: 2017 }, ['/tv']).title, 'SEAL Team');
});

test('unconfirmed checks are repeated daily; confirmed ones only when the match changes', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(confirmationIsFresh(confirmation([tmdb]), movie, day - 1), true);
  assert.equal(confirmationIsFresh(confirmation([tmdb]), movie, day + 1), false);
  assert.equal(confirmationIsFresh(confirmation([tmdb, omdb]), movie, 365 * day), true);
  assert.equal(confirmationIsFresh(confirmation([tmdb, omdb]), { ...movie, providerIds: { tmdbId: '2' } }, 1), false);
});

test('planned entries carry the verdict, and unchecked ones are marked', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'loom-verify-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (name: string) => { const target = path.join(root, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, 'v'); return target; };
  const item = (id: string, title: string, name: string) => ({
    id, type: 'movie', title, year: 2026, poster: '', backdrop: '', summary: '', rating: 0, genres: [], cast: [], filePath: file(name), providerIds: { tmdbId: id },
  } as MediaItem);
  const items = [item('1', 'Runner', 'Runner.2026.1080p.mkv'), item('2', 'The Uprising', 'The.Uprising.2026.1080p.mkv')];
  const plan = planRenames({
    items, libraryRoots: [root], movieFolders: true, isLocked: () => false, sameDrive: () => true,
    listDirectory: (dir) => { try { return readdirSync(dir); } catch { return null; } },
    verify: (candidate) => candidate.id === '1' ? { status: 'confirmed', note: 'Confirmed by TMDB and OMDb.' } : null,
  });
  const byTitle = new Map(plan.entries.map((entry) => [entry.mediaTitle, entry.verification?.status]));
  assert.equal(byTitle.get('Runner'), 'confirmed');
  assert.equal(byTitle.get('The Uprising'), 'unchecked');
});


test('one matching ID cannot excuse a contradictory provider ID', () => {
  const contradictory: SourceRecord = { ...tmdb, ids: { ...tmdb.ids, imdbId: 'tt9999999' } };
  assert.equal(evaluateConfirmation(movie, confirmation([contradictory, omdb])).status, 'conflict');
});

test('changed title or year invalidates a cached confirmation', () => {
  const stored = confirmation([tmdb, omdb]);
  assert.equal(confirmationIsFresh(stored, { ...movie, year: 2025 }, 1), false);
  assert.equal(confirmationIsFresh(stored, { ...movie, title: 'Another title' }, 1), false);
});
