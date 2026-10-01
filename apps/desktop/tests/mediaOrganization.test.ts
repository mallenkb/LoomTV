import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planRenames } from '../src/main/fileRename/renamePlanner.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';
import { createMetadataItemBuilders, type MetadataItemBuilderDependencies } from '../src/main/metadataItemBuilders.ts';
function fixture(t: { after: (fn: () => void) => void }) {
 const root = mkdtempSync(path.join(os.tmpdir(), 'loom-organize-'));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const file = (name: string) => { const target = path.join(root, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, 'video'); return target; };
 const item = (overrides: Partial<MediaItem>): MediaItem => ({ id: 'one', type: 'movie', title: 'Runner', year: 2026, poster: '', backdrop: '', summary: '', rating: 0, genres: [], filePath: '', providerIds: { tmdbId: '1377237' }, ...overrides } as MediaItem);
 const plan = (items: MediaItem[], recent?: (file: string) => boolean) => planRenames({ items, libraryRoots: [root], movieFolders: true, isLocked: () => false, sameDrive: () => true, isRecentlyModified: recent, listDirectory: (dir) => { try { return readdirSync(dir); } catch { return null; } } });
 return { root, file, item, plan };
}
const episode = (season: number, title: string) => ({ season, number: 1, title, summary: '', still: '', rating: 0, airDate: '' });
test('loose movie gets its title and year folder', (t) => {
 const f = fixture(t); const source = f.file('Runner.2026.1080p.WEB-DL.mkv');
 assert.equal(f.plan([f.item({ filePath: source })]).entries[0]?.to, path.join(f.root, 'Runner (2026)/Runner (2026).mkv'));
});
test('loose anime creates show and season folders', (t) => {
 const f = fixture(t); const source = f.file('The_Prince_of_Tennis_II_-_1_SUB_1080p.mp4');
 const plan = f.plan([f.item({ type: 'anime', title: 'The Prince of Tennis II', filePath: source, providerIds: { malId: '62534' }, episodeFiles: [{ season: 1, episode: 1, filePath: source }], episodes: [episode(1, 'Episode 1')] })]);
 assert.equal(plan.entries[0]?.to, path.join(f.root, 'The Prince of Tennis II (2026)/Season 01/S01E01 - Episode 1.mp4'));
});
test('season two stays season two when season one is absent', (t) => {
 const f = fixture(t); const source = f.file('VINLAND SAGA (2019)/Season 02/S01E01 - Somewhere Not Here.mkv');
 const plan = f.plan([f.item({ type: 'anime', title: 'VINLAND SAGA', year: 2019, filePath: path.dirname(path.dirname(source)), episodeFiles: [{ season: 2, episode: 1, filePath: source }], episodes: [episode(2, 'Slave')] })]);
 assert.ok(plan.entries.some((entry) => entry.to.endsWith('/Season 02/S02E01 - Slave.mkv')));
 assert.ok(plan.entries.every((entry) => !entry.to.includes('Season 01')));
});
test('existing movie folder prevents duplicate creation or overwrite', (t) => {
 const f = fixture(t); const source = f.file('Runner.2026.1080p.mkv'); f.file('Runner (2026)/Runner (2026).mkv');
 assert.equal(f.plan([f.item({ filePath: source })]).entries.length, 0);
});
test('unfinished episodes block parent folder changes', (t) => {
 const f = fixture(t); f.file('Ride or Die/Season 1/Ride.or.Die.S01E02.mkv.fdmdownload'); const source = f.file('Ride or Die/Season 1/Ride.or.Die.S01E01.mkv');
 const plan = f.plan([f.item({ type: 'tv', title: 'Ride or Die', filePath: path.join(f.root, 'Ride or Die'), episodeFiles: [{ season: 1, episode: 1, filePath: source }] })]);
 assert.equal(plan.entries.length, 0); assert.match(plan.skipped[0].reason, /still downloading/);
});
test('recently copied children block parent renames', (t) => {
 const f = fixture(t); const source = f.file('Runner/Runner.2026.mkv'); const plan = f.plan([f.item({ filePath: source })], () => true);
 assert.equal(plan.entries.length, 0); assert.ok(plan.skipped.some((skip) => /10 minutes/.test(skip.reason)));
});
function metadataDeps(): MetadataItemBuilderDependencies {
 const none = async () => null;
 return {
 extractSeasons: async () => [], scanEpisodeFiles: async () => [], probeMediaFile: async () => ({}),
 fetchAniListAnimeMetadata: none, fetchJikanEpisodesForLocalAnimeSeasons: async () => ({ episodes: [], malIdBySeason: {} }), fetchJikanMetadata: none,
 fetchOMDbMetadata: none, fetchOMDbMetadataById: none, fetchOMDbSeasonEpisodes: async () => [],
 fetchTMDBMovieMetadata: none, fetchTMDBMovieMetadataById: none, fetchTMDBTVMetadata: none, fetchTMDBTVMetadataById: none,
 fetchTVDBMetadata: none, fetchTVDBMetadataById: none, fetchTVMetadata: none,
 fetchFanartMovieLogos: async () => [], fetchFanartTVLogos: async () => [],
 getEmbeddedArtworkUrl: () => '', getLocalFolderArtworkUrl: () => '', getLocalMovieArtworkUrl: () => '', getLocalThumbnailUrl: () => '',
 orderedArtworkCandidates: (...urls) => urls.filter((url): url is string => !!url),
 };
}
test('same-named OMDb movie cannot supply a TV show year or plot', async () => {
 const deps = metadataDeps(); let requestedType: string | undefined;
 deps.fetchOMDbMetadata = async (_title, _year, _key, type) => { requestedType = type; return { Title: 'Ride or Die', Year: '2021', Type: 'movie', Plot: 'Wrong movie plot', Response: 'True' }; };
 deps.fetchTVMetadata = async () => ({ title: 'Ride or Die', year: 2026, summary: 'Correct series plot', providerIds: { tvmazeId: '91854' } });
 const item = await createMetadataItemBuilders(deps).buildTVItemFromFolder({ fullPath: '/nonexistent/Ride or Die', entryName: 'Ride or Die', cleanTitle: 'Ride or Die', id: 'show', subtitles: [], year: 2021 });
 assert.equal(requestedType, 'series'); assert.equal(item?.year, 2026); assert.equal(item?.summary, 'Correct series plot');
});

test('existing show folder is reused for a loose episode', (t) => {
 const f = fixture(t); const source = f.file('VINLAND.SAGA.S02E01.mkv'); mkdirSync(path.join(f.root, 'VINLAND SAGA (2019)/Season 02'), { recursive: true });
 const plan = f.plan([f.item({ type: 'anime', title: 'VINLAND SAGA', year: 2019, filePath: source, episodeFiles: [{ season: 2, episode: 1, filePath: source }], episodes: [episode(2, 'Slave')] })]);
 assert.equal(plan.entries[0]?.to, path.join(f.root, 'VINLAND SAGA (2019)/Season 02/S02E01 - Slave.mkv'));
});

test('rename and undo retain original names in durable history', async (t) => {
 const { DatabaseSync } = await import('node:sqlite');
 const { createRenameExecutor } = await import('../src/main/fileRename/renameExecutor.ts');
 const f = fixture(t); const source = f.file('Runner.2026.1080p.mkv');
 const db = new DatabaseSync(path.join(f.root, 'history.sqlite')); t.after(() => db.close());
 db.exec(`
 CREATE TABLE media_rename_batches(id TEXT PRIMARY KEY, created_at INTEGER, undone_at INTEGER, operations_json TEXT);
 CREATE TABLE media_rename_journal(id TEXT PRIMARY KEY, batch_id TEXT, direction TEXT, operations_json TEXT, completed INTEGER, created_at INTEGER);
 CREATE TABLE media_rename_locks(file_path TEXT PRIMARY KEY, rejected_name TEXT, created_at INTEGER);
 CREATE TABLE playback_progress(file_path TEXT);
 CREATE TABLE playback_track_preferences(scope TEXT);
 CREATE TABLE custom_artwork(media_id TEXT, target TEXT, data_url TEXT);
 `);
 for (const table of ['media_segments', 'media_fingerprints', 'media_auxiliary_fingerprints', 'segment_analysis_inventory', 'segment_analysis_jobs', 'media_segment_candidates', 'segment_analysis_state']) db.exec(`CREATE TABLE ${table}(file_path TEXT, file_revision TEXT, media_id TEXT)`);
 const database = { prepare: db.prepare.bind(db), transaction: (fn: () => void) => () => { db.exec('SAVEPOINT mutation'); try { fn(); db.exec('RELEASE mutation'); } catch (error) { db.exec('ROLLBACK TO mutation; RELEASE mutation'); throw error; } } };
 let library = { movies: [f.item({ filePath: source })], tvShows: [], animeShows: [], libraryFolders: [f.root] } as import('../src/main/appContracts.ts').LibraryData;
 const executor = createRenameExecutor({ getDatabase: () => database as unknown as import('better-sqlite3').Database, loadLibrary: () => library, saveLibraryMutation: (next) => { library = next; }, remapMediaIds: () => { /* No separate watch-list store in this fixture. */ }, isScanRunning: () => false, libraryRoots: () => [f.root] });
 const deferred = executor.plan({ automatic: true });
 assert.equal(deferred.waitingFiles, 1);
 assert.ok((deferred.retryAfterMs || 0) > 0);
 const { batchId } = executor.apply(executor.plan().entries.map((entry) => entry.id));
 assert.equal(library.movies[0].filePath, path.join(f.root, 'Runner (2026)/Runner (2026).mkv'));
 assert.ok(executor.record(batchId)?.operations.some((operation) => operation.from === source));
 executor.undo(batchId);
 assert.equal(library.movies[0].filePath, source);
 assert.ok(executor.record(batchId)?.undoneAt);
 assert.ok(executor.history()[0].operations.some((operation) => operation.from === source));
 assert.equal(executor.history(20, 1).length, 0);
 assert.equal(executor.plan().entries.length, 0);
});
