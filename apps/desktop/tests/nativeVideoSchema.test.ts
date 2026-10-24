import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { initializeCanonicalSchema, profileAllowsCanonicalMedia } from 'loom-media-server-headless/native-persistence';
import { canonicalVideoConnection, openConsolidatedVideoDatabase } from '../src/main/consolidatedVideoDatabase.ts';
import { loadLibrary, saveLibrary, saveLibraryScanDelta, remapLibraryMediaReferences } from '../src/main/databaseLibraryRepository.ts';
import { createRenameExecutor } from '../src/main/fileRename/renameExecutor.ts';
import { createMediaItemId } from '../src/main/libraryItemHelpers.ts';
import { getAllProgress, getPlaybackTrackPreferences, savePlaybackTrackPreferences, saveProgress } from '../src/main/databasePlaybackRepository.ts';
import {
  createProfile, deleteProfile, getDeviceProfileSelection, getDeviceSelectionRevision, getOwnerProfile,
  getProfileLists, getProfilePreferences, getProfileRestrictions, saveProfilePreferences, saveProfileRestrictions,
  selectDeviceProfile, setProfileListEntry,
} from '../src/main/databaseProfilesRepository.ts';
import { createNativeVideoSchema, nativeVideoSql } from '../src/main/nativeVideoSchema.ts';

function fixture(context: { after: (cleanup: () => void) => void }) {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  initializeCanonicalSchema(database);
  database.exec(`INSERT INTO accounts(id,name,account_type,role,permissions_json,disabled,created_at,updated_at)
    VALUES('owner-account','Owner','owner','owner','[]',0,0,0);
    INSERT INTO owner_account(singleton,account_id) VALUES(1,'owner-account');`);
  createNativeVideoSchema(database as unknown as BetterSqlite3.Database);
  database
    .prepare(nativeVideoSql(`INSERT INTO profiles(id,name,profile_type) VALUES('owner-profile','Owner','owner')`))
    .run();
  database
    .prepare(nativeVideoSql(`INSERT INTO library_folders(path,kind,added_at) VALUES('/library','movies',1)`))
    .run();
  function movie(id = 'movie-1', file = '/library/film.mkv') {
    database
      .prepare(
        nativeVideoSql(`INSERT INTO media_items(id,type,title,year,summary,rating,file_path,genres_json,cast_json,provider_ratings_json,added_at,updated_at)
      VALUES(?,'movie','A film',2026,'Summary',7.5,?,'["Drama"]','[]','{"imdb":{"value":7.5,"scale":10}}',1,2)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title`),
      )
      .run(id, file);
  }
  return { database, movie };
}

test('native catalog and server records are the same rows in both directions', (context) => {
  const { database, movie } = fixture(context);
  movie();
  assert.equal(database.prepare('SELECT title FROM catalog_items WHERE id=?').get('movie-1')?.title, 'A film');
  assert.equal(database.prepare('SELECT COUNT(*) count FROM media_sources').get()?.count, 1);
  database.prepare('UPDATE catalog_items SET title=? WHERE id=?').run('Corrected title', 'movie-1');
  assert.equal(
    database.prepare(nativeVideoSql('SELECT title FROM media_items WHERE id=?')).get('movie-1')?.title,
    'Corrected title',
  );
  assert.equal(database.prepare("SELECT type FROM sqlite_master WHERE name='native_media_items'").get()?.type, 'view');
  assert.equal(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_items'").get(),
    undefined,
  );
});

test('native progress uses canonical media identity and server updates appear immediately', (context) => {
  const { database, movie } = fixture(context);
  movie();
  database
    .prepare(
      nativeVideoSql(`INSERT INTO playback_progress(profile_id,file_path,position,duration,watched,updated_at)
    VALUES('owner-profile','/library/film.mkv',30,600,0,100)`),
    )
    .run();
  assert.equal(database.prepare('SELECT media_id FROM watch_progress').get()?.media_id, 'movie-1');
  database.prepare('UPDATE watch_progress SET position_seconds=90 WHERE media_id=?').run('movie-1');
  assert.equal(database.prepare(nativeVideoSql('SELECT position FROM playback_progress')).get()?.position, 90);
  movie();
  assert.equal(database.prepare('SELECT COUNT(*) count FROM watch_progress').get()?.count, 1);
  assert.equal(database.prepare('SELECT position_seconds FROM watch_progress').get()?.position_seconds, 90);
});

test('parent metadata and each local episode source survive separate writes', (context) => {
  const { database } = fixture(context);
  database
    .prepare(
      nativeVideoSql(
        `INSERT INTO media_items(id,type,title,year,file_path) VALUES('series-1','tv','A series',2026,'/library/series')`,
      ),
    )
    .run();
  database
    .prepare(
      nativeVideoSql(`INSERT INTO episodes(media_id,season,number,title,summary,still,rating,air_date)
    VALUES('series-1',1,1,'Pilot','Episode summary','still.jpg',8,'2026-01-01')`),
    )
    .run();
  database
    .prepare(
      nativeVideoSql(`INSERT INTO episode_files(media_id,season,episode,file_path,title,thumbnail,still,subtitles_json)
    VALUES('series-1',1,1,'/library/series/pilot.mkv','Local pilot','thumb.jpg','still.jpg','[]')`),
    )
    .run();
  const episode = database.prepare("SELECT id FROM catalog_items WHERE media_kind='episode'").get();
  assert.ok(episode);
  assert.equal(
    database.prepare('SELECT media_id FROM media_sources WHERE locator=?').get('/library/series/pilot.mkv')?.media_id,
    episode.id,
  );
  assert.equal(database.prepare(nativeVideoSql('SELECT thumbnail FROM episode_files')).get()?.thumbnail, 'thumb.jpg');
  assert.equal(database.prepare(nativeVideoSql('SELECT summary FROM episodes')).get()?.summary, 'Episode summary');
});

test('canonical and native profile preferences merge without dropping desktop controls', (context) => {
  const { database } = fixture(context);
  database
    .prepare(
      nativeVideoSql(`INSERT INTO profile_preferences(profile_id,preferences_json,revision,updated_at)
    VALUES('owner-profile','{"appPlayerControlStyle":"pill","appThemeMode":"dark"}',1,100)`),
    )
    .run();
  database
    .prepare(
      "UPDATE profile_preferences SET payload_json=json_set(payload_json,'$.themeMode','light') WHERE profile_id='owner-profile'",
    )
    .run();
  const value = database.prepare(nativeVideoSql('SELECT preferences_json FROM profile_preferences')).get();
  const preferences = JSON.parse(String(value?.preferences_json));
  assert.equal(preferences.appPlayerControlStyle, 'pill');
  assert.equal(preferences.appThemeMode, 'light');
});

test('subfolder grants and an explicit empty root grant fail closed for both clients', (context) => {
  const { database, movie } = fixture(context);
  movie('allowed', '/library/allowed/film.mkv');
  movie('denied', '/library/other/film.mkv');
  database
    .prepare("INSERT INTO profile_path_grants(profile_id,folder_path) VALUES('owner-profile','/library/allowed')")
    .run();
  assert.equal(profileAllowsCanonicalMedia(database, 'owner-profile', 'allowed'), true);
  assert.equal(profileAllowsCanonicalMedia(database, 'owner-profile', 'denied'), false);
  database
    .prepare(
      nativeVideoSql(`INSERT INTO profile_restrictions(profile_id,country,maximum_age,allow_unrated,revision,updated_at)
    VALUES('owner-profile','US',18,1,1,100)`),
    )
    .run();
  database.prepare("UPDATE profile_restrictions SET allowed_root_ids_json='[]' WHERE profile_id='owner-profile'").run();
  assert.equal(profileAllowsCanonicalMedia(database, 'owner-profile', 'allowed'), false);
});

test('a series merge preserves source identity and combines episode metadata without an empty duplicate', (context) => {
  const { database } = fixture(context);
  const native = (sql: string) => database.prepare(nativeVideoSql(sql));
  native(
    `INSERT INTO media_items(id,type,title,file_path) VALUES('old-series','tv','Old series','/library/old')`,
  ).run();
  native(
    `INSERT INTO media_items(id,type,title,file_path) VALUES('new-series','tv','New series','/library/new')`,
  ).run();
  database
    .prepare(`INSERT INTO catalog_items(id,media_type,media_kind,title,anime_likely,series_title,series_season,series_episode,extension_json,created_at,updated_at)
    VALUES('canonical-episode','tv','episode','Canonical title',0,'Old series',1,1,
      '{"seriesId":"old-series","summary":"Canonical summary","metadata":{"poster":"poster.jpg"},"provider":{"id":"provider-1"}}',10,20)`)
    .run();
  const root = database.prepare("SELECT id FROM library_roots WHERE locator='/library'").get();
  database
    .prepare(`INSERT INTO media_sources(id,media_id,root_id,relative_path,locator,state,indexed_at,extension_json)
    VALUES('canonical-source','canonical-episode',?,'old/pilot.mkv','/library/old/pilot.mkv','offline',10,'{"retained":true}')`)
    .run(String(root?.id));
  database
    .prepare(`INSERT INTO watch_progress(profile_id,media_id,position_seconds,duration_seconds,watched,updated_at)
    VALUES('owner-profile','canonical-episode',60,600,0,100)`)
    .run();
  native(`INSERT INTO episodes(media_id,season,number,title,summary,still,rating,air_date)
    VALUES('new-series',1,1,'Native title','Native summary','still.jpg',8,'2026-01-01')`).run();
  native(`INSERT OR REPLACE INTO episode_files(media_id,season,episode,file_path,title,thumbnail,still,subtitles_json)
    VALUES('new-series',1,1,'/library/old/pilot.mkv','Local title','thumb.jpg','still.jpg','[{"path":"pilot.srt"}]')`).run();
  const episode = database
    .prepare("SELECT extension_json,series_title FROM catalog_items WHERE id='canonical-episode'")
    .get();
  const extension = JSON.parse(String(episode?.extension_json));
  assert.equal(episode?.series_title, 'New series');
  assert.equal(extension.seriesId, 'new-series');
  assert.equal(extension.summary, 'Canonical summary');
  assert.equal(extension.metadata.poster, 'poster.jpg');
  assert.equal(extension.metadata.still, 'still.jpg');
  assert.equal(extension.provider.id, 'provider-1');
  assert.equal(database.prepare("SELECT COUNT(*) count FROM catalog_items WHERE media_kind='episode'").get()?.count, 1);
  assert.equal(
    database.prepare("SELECT media_id,state FROM media_sources WHERE id='canonical-source'").get()?.media_id,
    'canonical-episode',
  );
  assert.equal(database.prepare('SELECT media_id FROM watch_progress').get()?.media_id, 'canonical-episode');
  assert.equal(database.prepare("SELECT state FROM media_sources WHERE id='canonical-source'").get()?.state, 'offline');
});

test('an episode path update keeps progress identity and the old missing source', (context) => {
  const { database } = fixture(context);
  const native = (sql: string) => database.prepare(nativeVideoSql(sql));
  native(`INSERT INTO media_items(id,type,title,file_path) VALUES('series','tv','Series','/library/series')`).run();
  native(`INSERT INTO episode_files(media_id,season,episode,file_path,title,thumbnail,subtitles_json)
    VALUES('series',1,1,'/library/series/pilot.mkv','Pilot','thumb.jpg','[{"path":"pilot.srt"}]')`).run();
  native(`INSERT INTO playback_progress(profile_id,file_path,position,duration,watched,updated_at)
    VALUES('owner-profile','/library/series/pilot.mkv',90,600,0,100)`).run();
  const original = database
    .prepare("SELECT id,media_id FROM media_sources WHERE locator='/library/series/pilot.mkv'")
    .get();
  native(
    `UPDATE episode_files SET file_path='/library/series/renamed.mkv' WHERE file_path='/library/series/pilot.mkv'`,
  ).run();
  const replacement = database
    .prepare("SELECT media_id,extension_json FROM media_sources WHERE locator='/library/series/renamed.mkv'")
    .get();
  assert.equal(replacement?.media_id, original?.media_id);
  assert.equal(
    database.prepare('SELECT state FROM media_sources WHERE id=?').get(String(original?.id))?.state,
    'missing',
  );
  assert.equal(database.prepare('SELECT media_id FROM watch_progress').get()?.media_id, original?.media_id);
  assert.equal(
    native('SELECT position FROM playback_progress WHERE file_path=?').get('/library/series/renamed.mkv')?.position,
    90,
  );
  assert.equal(JSON.parse(String(replacement?.extension_json)).thumbnail, 'thumb.jpg');
  assert.deepEqual(JSON.parse(String(replacement?.extension_json)).subtitles, [{ path: 'pilot.srt' }]);
  assert.equal(native('SELECT COUNT(*) count FROM episode_files').get()?.count, 1);
});

test('a full native catalog rewrite retains unavailable source state and source evidence', (context) => {
  const { database, movie } = fixture(context);
  movie();
  const source = database.prepare("SELECT id FROM media_sources WHERE locator='/library/film.mkv'").get();
  database.prepare("UPDATE library_roots SET state='offline'").run();
  database.prepare("UPDATE media_sources SET state='unreadable'").run();
  database
    .prepare(
      "INSERT INTO media_identity_evidence(source_id,kind,value,observed_at) VALUES(?,'content-sha256','retained-hash',10)",
    )
    .run(String(source?.id));
  database.exec(nativeVideoSql('DELETE FROM media_items; DELETE FROM library_folders;'));
  database
    .prepare(nativeVideoSql(`INSERT OR REPLACE INTO library_folders(path,kind,added_at) VALUES('/library','movies',1)`))
    .run();
  movie();
  assert.equal(database.prepare('SELECT state FROM library_roots').get()?.state, 'offline');
  assert.equal(
    database.prepare('SELECT state FROM media_sources WHERE id=?').get(String(source?.id))?.state,
    'unreadable',
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) count FROM media_identity_evidence WHERE source_id=?').get(String(source?.id))
      ?.count,
    1,
  );
  assert.equal(database.prepare(nativeVideoSql('SELECT COUNT(*) count FROM media_items')).get()?.count, 1);
});

test('removed and orphaned roots hide movies while offline roots stay visible', (context) => {
  const { database, movie } = fixture(context);
  movie();
  database.prepare("UPDATE library_roots SET state='offline'").run();
  assert.equal(database.prepare(nativeVideoSql('SELECT COUNT(*) count FROM media_items')).get()?.count, 1);
  database.prepare("UPDATE library_roots SET state='removed'").run();
  assert.equal(database.prepare(nativeVideoSql('SELECT COUNT(*) count FROM media_items')).get()?.count, 0);
  database.prepare('DELETE FROM library_roots').run();
  assert.equal(database.prepare(nativeVideoSql('SELECT COUNT(*) count FROM media_items')).get()?.count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM catalog_items').get()?.count, 1);
});

test('restriction updates retain explicit unrestricted age and dedicated root/revision columns', (context) => {
  const { database } = fixture(context);
  database
    .prepare(
      nativeVideoSql(`INSERT INTO profile_restrictions(profile_id,country,maximum_age,allow_unrated,revision,updated_at)
    VALUES('owner-profile','US',12,0,1,100)`),
    )
    .run();
  database.prepare("UPDATE profile_restrictions SET allowed_root_ids_json='[]'").run();
  database
    .prepare(
      nativeVideoSql(`INSERT INTO profile_restrictions(profile_id,country,maximum_age,allow_unrated,revision,updated_at)
    VALUES('owner-profile','GB',NULL,1,1,200) ON CONFLICT(profile_id) DO UPDATE SET maximum_age=excluded.maximum_age`),
    )
    .run();
  const row = database.prepare('SELECT payload_json,allowed_root_ids_json,revision FROM profile_restrictions').get();
  assert.deepEqual(JSON.parse(String(row?.payload_json)), { country: 'GB', maximumAge: null, allowUnrated: true });
  assert.equal(row?.allowed_root_ids_json, '[]');
  assert.equal(row?.revision, 2);
  assert.equal(database.prepare(nativeVideoSql('SELECT updated_at FROM profile_restrictions')).get()?.updated_at, 200);
});

test('SQL translation changes relation identifiers and preserves data, aliases, parameters, and comments', () => {
  for (const conflict of ['ROLLBACK', 'ABORT', 'FAIL', 'IGNORE', 'REPLACE']) {
    assert.equal(
      nativeVideoSql(`UPDATE OR ${conflict} playback_progress SET file_path=? WHERE file_path=?`),
      `UPDATE OR ${conflict} "native_playback_progress" SET file_path=? WHERE file_path=?`,
    );
  }
  const sql = `-- profiles remains a comment
SELECT profiles.name AS episodes, ':profiles media_items' literal, :profiles parameter
FROM [profiles] JOIN \`profile_preferences\` AS prefs ON profiles.id=prefs.profile_id
WHERE profiles.name='ON CONFLICT(id) DO UPDATE SET RETURNING' /* episodes */`;
  const translated = nativeVideoSql(sql);
  assert.match(translated, /SELECT "native_profiles"\.name AS episodes/);
  assert.match(translated, /FROM "native_profiles" JOIN "native_profile_preferences" AS prefs/);
  assert.match(translated, /:profiles parameter/);
  assert.match(translated, /'ON CONFLICT\(id\) DO UPDATE SET RETURNING'/);
  assert.ok(translated.startsWith('-- profiles remains a comment'));
  assert.ok(translated.endsWith('/* episodes */'));
  assert.equal(
    nativeVideoSql('SELECT profiles.profile_id FROM profile_preferences AS profiles'),
    'SELECT profiles.profile_id FROM "native_profile_preferences" AS profiles',
  );
  const insert = nativeVideoSql(`INSERT OR REPLACE INTO media_items(id,title) VALUES('movie','RETURNING ON CONFLICT')
    ON CONFLICT(id) DO UPDATE SET title=excluded.title RETURNING id;`);
  assert.match(insert, /^INSERT\s+INTO "native_media_items"/);
  assert.match(insert, /'RETURNING ON CONFLICT'/);
  assert.ok(insert.endsWith('RETURNING id;'));
  assert.doesNotMatch(insert, /DO UPDATE/);
  assert.equal(
    nativeVideoSql('INSERT INTO scan_cache(folder_path) VALUES(?) ON CONFLICT(folder_path) DO NOTHING'),
    'INSERT INTO scan_cache(folder_path) VALUES(?) ON CONFLICT(folder_path) DO NOTHING',
  );
});

test('native per-file details do not replace a canonical media probe', (context) => {
  const { database, movie } = fixture(context);
  movie();
  const source = database.prepare("SELECT id FROM media_sources WHERE locator='/library/film.mkv'").get();
  const probe = { sourceId: String(source?.id), hdr: false, tracks: [], probedAt: 100, durationSeconds: 600 };
  database.prepare('UPDATE media_sources SET probe_json=? WHERE id=?').run(JSON.stringify(probe), String(source?.id));
  database
    .prepare(
      nativeVideoSql(
        `UPDATE media_items SET local_metadata_json='{"fileSize":123,"audioTracks":2,"videoProfile":"Main"}',last_played=250 WHERE id='movie-1'`,
      ),
    )
    .run();
  const updated = database
    .prepare('SELECT probe_json,extension_json FROM media_sources WHERE id=?')
    .get(String(source?.id));
  assert.deepEqual(JSON.parse(String(updated?.probe_json)), probe);
  assert.deepEqual(JSON.parse(String(updated?.extension_json)).nativeLocalMetadata, {
    fileSize: 123,
    audioTracks: 2,
    videoProfile: 'Main',
  });
  assert.equal(
    database.prepare(nativeVideoSql("SELECT last_played FROM media_items WHERE id='movie-1'")).get()?.last_played,
    250,
  );
});

test('an episode file cannot steal a movie source or move progress to another episode', (context) => {
  const { database, movie } = fixture(context);
  movie();
  const native = (sql: string) => database.prepare(nativeVideoSql(sql));
  native(`INSERT INTO media_items(id,type,title,file_path) VALUES('series','tv','Series','/library/series')`).run();
  assert.throws(
    () =>
      native(`INSERT INTO episode_files(media_id,season,episode,file_path)
    VALUES('series',1,1,'/library/film.mkv')`).run(),
    /another catalog kind/,
  );
  native(`INSERT INTO episode_files(media_id,season,episode,file_path) VALUES('series',1,1,'/library/one.mkv')`).run();
  native(`INSERT INTO episode_files(media_id,season,episode,file_path) VALUES('series',1,2,'/library/two.mkv')`).run();
  assert.throws(
    () => native(`UPDATE episode_files SET file_path='/library/two.mkv' WHERE file_path='/library/one.mkv'`).run(),
    /another media identity/,
  );
  assert.equal(
    database.prepare("SELECT media_id FROM media_sources WHERE locator='/library/film.mkv'").get()?.media_id,
    'movie-1',
  );
  assert.equal(native('SELECT COUNT(*) count FROM episode_files').get()?.count, 2);
});

test('canonical artwork appears in native reads and native artwork edits preserve extra keys', (context) => {
  const { database, movie } = fixture(context);
  movie();
  database
    .prepare(`UPDATE catalog_items SET extension_json=json_set(extension_json,'$.artwork',
    json('{"poster":"canonical-poster.jpg","backdrop":"canonical-backdrop.jpg","banner":"banner.jpg"}')) WHERE id='movie-1'`)
    .run();
  assert.equal(
    database.prepare(nativeVideoSql("SELECT poster FROM media_items WHERE id='movie-1'")).get()?.poster,
    'canonical-poster.jpg',
  );
  database.prepare(nativeVideoSql("UPDATE media_items SET poster='native-poster.jpg' WHERE id='movie-1'")).run();
  const row = database
    .prepare("SELECT json_extract(extension_json,'$.artwork') artwork FROM catalog_items WHERE id='movie-1'")
    .get();
  assert.deepEqual(JSON.parse(String(row?.artwork)), {
    poster: 'native-poster.jpg',
    backdrop: 'canonical-backdrop.jpg',
    banner: 'banner.jpg',
  });
});

test('native selections and revisions exclude remote account state', (context) => {
  const { database } = fixture(context);
  database
    .prepare(`INSERT INTO accounts(id,name,account_type,role,permissions_json,disabled,created_at,updated_at)
      VALUES('remote-account','Remote','user','user','[]',0,0,0)`)
    .run();
  database
    .prepare(`INSERT INTO profile_selections(account_id,device_id,profile_id,revision,automatic_sign_in,selected_at)
      VALUES('remote-account','remote-device','owner-profile',100,1,100)`)
    .run();
  database
    .prepare(
      nativeVideoSql(`INSERT INTO device_profile_selections(device_id,profile_id,selected_at,automatic_sign_in,selection_revision)
      VALUES('desktop-device','owner-profile',10,1,3)`),
    )
    .run();
  const native = (sql: string) => database.prepare(nativeVideoSql(sql));
  assert.equal(
    native("SELECT profile_id FROM device_profile_selections WHERE device_id='remote-device'").get(),
    undefined,
  );
  assert.equal(
    native("SELECT revision FROM device_profile_selection_revisions WHERE device_id='remote-device'").get(),
    undefined,
  );
  native("INSERT INTO device_profile_selection_revisions(device_id,revision) VALUES('remote-device',5)").run();
  assert.equal(
    native("SELECT revision FROM device_profile_selection_revisions WHERE device_id='remote-device'").get()?.revision,
    5,
  );
  assert.equal(
    native("SELECT revision FROM device_profile_selection_revisions WHERE device_id='desktop-device'").get()?.revision,
    3,
  );
  native('UPDATE device_profile_selections SET automatic_sign_in=0').run();
  native('DELETE FROM device_profile_selections').run();
  const remote = database
    .prepare("SELECT profile_id,revision,automatic_sign_in FROM profile_selections WHERE account_id='remote-account'")
    .get();
  assert.equal(remote?.profile_id, 'owner-profile');
  assert.equal(remote?.revision, 100);
  assert.equal(remote?.automatic_sign_in, 1);
  const desktop = database
    .prepare("SELECT profile_id,revision,automatic_sign_in FROM profile_selections WHERE account_id='owner-account'")
    .get();
  assert.equal(desktop?.profile_id, null);
  assert.equal(desktop?.revision, 4);
  assert.equal(desktop?.automatic_sign_in, 0);
});

test('native repositories round-trip library and viewer state through the production canonical facade', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-native-repositories-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = openConsolidatedVideoDatabase(directory);
  context.after(() => database.close());
  const canonical = canonicalVideoConnection(database);
  const data = {
    movies: [{
      id: 'film', type: 'movie' as const, title: 'Film', year: 2026, poster: 'poster.jpg', backdrop: '', logo: '',
      summary: 'Movie summary', rating: 8, genres: ['Drama'], cast: [], filePath: '/library/film.mkv',
      localMetadata: { fileSize: 123, audioTracks: 2 },
    }],
    tvShows: [{
      id: 'show', type: 'tv' as const, title: 'Show', year: 2026, poster: '', backdrop: '', logo: '',
      summary: 'Show summary', rating: 8, genres: [], cast: [], filePath: '/library/show',
      seasons: [{ number: 1, title: 'Season 1', episodeCount: 1 }],
      episodes: [{ season: 1, number: 1, title: 'Pilot', summary: 'Episode summary', still: 'still.jpg', rating: 8, airDate: '2026-01-01' }],
      episodeFiles: [{ season: 1, episode: 1, filePath: '/library/show/pilot.mkv', thumbnail: 'thumb.jpg', localMetadata: { audioTracks: 2 } }],
    }],
    animeShows: [], libraryFolders: ['/library'],
    libraryFolderGroups: { movies: ['/library'], tvShows: [], anime: [], others: [] }, scanCache: {},
  };
  saveLibrary(database, data);
  const first = loadLibrary(database, new Map());
  assert.equal(first?.movies[0]?.localMetadata?.audioTracks, 2);
  assert.equal(first?.tvShows[0]?.episodes?.[0]?.summary, 'Episode summary');
  assert.equal(first?.tvShows[0]?.episodeFiles?.[0]?.thumbnail, 'thumb.jpg');
  assert.equal(first?.tvShows[0]?.episodeFiles?.[0]?.localMetadata?.audioTracks, 2);
  assert.equal(canonical.prepare('SELECT COUNT(*) count FROM catalog_items').get()?.count, 3);
  assert.equal(canonical.prepare('SELECT COUNT(*) count FROM media_sources WHERE probe_json IS NOT NULL').get()?.count, 0);
  const ownerProfile = getOwnerProfile(database);
  assert.ok(ownerProfile);
  const viewer = createProfile(database, { name: 'Viewer', type: 'standard' });
  saveProfilePreferences(database, viewer.id, { appThemeMode: 'light', playbackSkipForwardSeconds: 20 });
  saveProfilePreferences(database, viewer.id, { appPlayerControlStyle: 'pill' });
  assert.equal(getProfilePreferences(database, viewer.id).playbackSkipForwardSeconds, 20);
  assert.deepEqual(getProfilePreferences(database, ownerProfile.id), {});
  saveProfileRestrictions(database, viewer.id, { country: 'GB', maximumAge: null, allowUnrated: true, allowedFolders: ['/library'] });
  assert.deepEqual(getProfileRestrictions(database, viewer.id).allowedFolders, ['/library']);
  setProfileListEntry(database, viewer.id, 'film', 'favorite', true);
  assert.equal(getProfileLists(database, viewer.id)[0]?.mediaId, 'film');
  saveProgress(database, ownerProfile.id, '/library/film.mkv', 30, 600);
  saveProgress(database, viewer.id, '/library/film.mkv', 90, 600);
  savePlaybackTrackPreferences(database, viewer.id, 'film', { audio: { enabled: true, language: 'EN' } });
  assert.deepEqual(getPlaybackTrackPreferences(database, viewer.id, 'film'), { audio: { enabled: true, language: 'en' } });
  saveLibrary(database, data);
  assert.equal(getAllProgress(database, ownerProfile.id)['/library/film.mkv']?.position, 30);
  assert.equal(getAllProgress(database, viewer.id)['/library/film.mkv']?.position, 90);
  selectDeviceProfile(database, 'desktop-test', viewer.id);
  const revision = getDeviceSelectionRevision(database, 'desktop-test');
  selectDeviceProfile(database, 'desktop-test', viewer.id);
  assert.equal(getDeviceSelectionRevision(database, 'desktop-test'), revision + 1);
  assert.equal(getDeviceProfileSelection(database, 'desktop-test'), viewer.id);
  deleteProfile(database, viewer.id);
  assert.equal(getDeviceProfileSelection(database, 'desktop-test'), null);
  assert.equal(getDeviceSelectionRevision(database, 'desktop-test'), revision + 2);
  assert.deepEqual(getAllProgress(database, viewer.id), {});
  assert.equal(getAllProgress(database, ownerProfile.id)['/library/film.mkv']?.position, 30);
});


test('canonical movie organization keeps source identity, progress and lists through rename and undo', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-canonical-rename-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = openConsolidatedVideoDatabase(directory);
  context.after(() => database.close());
  const root = path.join(directory, 'Movies');
  fs.mkdirSync(root);
  const original = path.join(root, 'Tuner.2025.1080p.WEBRip.mkv');
  fs.writeFileSync(original, 'local movie fixture');
  const id = createMediaItemId(original);
  saveLibrary(database, {
    movies: [{ id, type: 'movie', title: 'Tuner', year: 2026, poster: '', backdrop: '',
      summary: '', rating: 7, genres: [], cast: [], filePath: original,
      providerIds: { imdbId: 'tt33296751' } }],
    tvShows: [], animeShows: [], libraryFolders: [root],
    libraryFolderGroups: { movies: [root], tvShows: [], anime: [], others: [] }, scanCache: {},
  });
  const owner = getOwnerProfile(database);
  assert.ok(owner);
  saveProgress(database, owner.id, original, 30, 600);
  setProfileListEntry(database, owner.id, id, 'favorite', true);
  const source = canonicalVideoConnection(database).prepare('SELECT id FROM media_sources WHERE media_id=?').get(id);
  const executor = createRenameExecutor({
    getDatabase: () => database,
    loadLibrary: () => {
      const library = loadLibrary(database, new Map());
      assert.ok(library);
      return library;
    },
    saveLibraryMutation: (data) => { saveLibraryScanDelta(database, [...data.movies, ...data.tvShows, ...data.animeShows], [], data.scanCache || {}); },
    remapMediaIds: (aliases) => remapLibraryMediaReferences(database, aliases),
    isScanRunning: () => false,
    libraryRoots: (data) => data.libraryFolders,
  });
  const entry = executor.plan().entries.find((candidate) => candidate.mediaId === id && candidate.kind === 'file');
  assert.ok(entry);
  const result = executor.apply([entry.id]);
  assert.equal(result.renamed, 1);
  assert.ok(fs.existsSync(entry.to));
  assert.equal(fs.existsSync(original), false);
  assert.equal(loadLibrary(database, new Map())?.movies[0]?.id, id);
  assert.equal(getAllProgress(database, owner.id)[entry.to]?.position, 30);
  assert.equal(getAllProgress(database, owner.id)[original], undefined);
  assert.equal(getProfileLists(database, owner.id)[0]?.mediaId, id);
  assert.deepEqual(canonicalVideoConnection(database).prepare('SELECT id FROM media_sources WHERE media_id=?').get(id), source);
  executor.undo(result.batchId);
  assert.ok(fs.existsSync(original));
  assert.equal(getAllProgress(database, owner.id)[original]?.position, 30);
  assert.equal(getProfileLists(database, owner.id)[0]?.mediaId, id);
});
