import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createCanonicalMediaAccess,
  profileAllowsCanonicalMedia,
  registerNativeVideoFunctions,
} from '../src/native-video-functions.js';

function fixture(context) {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  registerNativeVideoFunctions(database);
  database.exec(`
    CREATE TABLE profiles(id TEXT PRIMARY KEY);
    CREATE TABLE profile_restrictions(profile_id TEXT PRIMARY KEY,allowed_root_ids_json TEXT);
    CREATE TABLE profile_path_grants(profile_id TEXT,folder_path TEXT);
    CREATE TABLE catalog_items(id TEXT PRIMARY KEY,extension_json TEXT NOT NULL);
    CREATE TABLE media_sources(id TEXT,media_id TEXT,root_id TEXT,locator TEXT,state TEXT);
    INSERT INTO profiles VALUES('viewer');
    INSERT INTO catalog_items VALUES('show','{}'),('allowed','{"seriesId":"show"}'),('denied','{"seriesId":"show"}');
    INSERT INTO media_sources VALUES('allowed-source','allowed','selected','/videos/family/episode-1.mkv','online'),
      ('denied-source','denied','other','/videos/family/episode-2.mkv','online');
  `);
  return database;
}

test('canonical root IDs intersect path grants and scope series playback to its requested episode', (context) => {
  const database = fixture(context);
  database.prepare('INSERT INTO profile_restrictions VALUES(?,?)').run('viewer', '["selected"]');
  database.prepare('INSERT INTO profile_path_grants VALUES(?,?)').run('viewer', '/videos/family');
  const allows = createCanonicalMediaAccess(database, 'viewer');
  assert.equal(allows('show'), true);
  assert.equal(allows('show', '/videos/family/episode-1.mkv'), true);
  assert.equal(allows('show', '/videos/family/episode-2.mkv'), false);
  assert.equal(profileAllowsCanonicalMedia(database, 'viewer', 'show', '/videos/family/episode-2.mkv'), false);
  database.prepare('UPDATE profile_path_grants SET folder_path=?').run('/videos/elsewhere');
  assert.equal(profileAllowsCanonicalMedia(database, 'viewer', 'show'), false);
});

test('empty canonical grants deny every file while absent grants remain unrestricted', (context) => {
  const database = fixture(context);
  assert.equal(profileAllowsCanonicalMedia(database, 'viewer', 'show'), true);
  assert.equal(profileAllowsCanonicalMedia(database, 'missing', 'show'), false);
  database.prepare('INSERT INTO profile_restrictions VALUES(?,?)').run('viewer', '[]');
  assert.equal(profileAllowsCanonicalMedia(database, 'viewer', 'show'), false);
  assert.equal(createCanonicalMediaAccess(database, 'viewer')('allowed', '/videos/family/episode-1.mkv'), false);
});

test('shared preferences respect canonical value limits and retain UI-only values outside their projection', (context) => {
  const database = fixture(context);
  const preferences = {
    appThemeMode: 'light',
    appThemeColor: 'twitch',
    appLoaderStyle: 'logo-mark',
    sidebarNavOrder: Array.from({ length: 33 }, (_, index) => `item-${index}`),
    playbackSkipBackSeconds: 10,
    playbackSkipForwardSeconds: 601,
    playbackRewindOnResumeSeconds: 5,
  };
  const { payload } = database
    .prepare("SELECT loom_preferences(?,'canonical') payload")
    .get(JSON.stringify(preferences));
  assert.deepEqual(JSON.parse(payload), {
    themeMode: 'light',
    themeColor: 'twitch',
    sidebarNavOrder: null,
    skipBackSeconds: 10,
    skipForwardSeconds: null,
    rewindOnResumeSeconds: 5,
  });
  const { payload: native } = database
    .prepare("SELECT loom_preferences(?,'native') payload")
    .get(JSON.stringify({ rewindOnResumeSeconds: 5, themeColor: 'blue', appLoaderStyle: 'logo-mark' }));
  assert.deepEqual(JSON.parse(native), { appThemeColor: 'blue', playbackRewindOnResumeSeconds: 5 });
});

test('logical catalog sources intersect principal scope and report only permitted source availability', (context) => {
  const database = fixture(context);
  database.prepare('INSERT INTO profile_restrictions VALUES(?,?)').run('viewer', '["selected"]');
  const allows = createCanonicalMediaAccess(database, 'viewer');
  assert.deepEqual(allows.projectSources('show', ['denied-source']), { sourceIds: [], available: false },
    'an allowed sibling outside the principal source list cannot authorize its denied source');
  assert.deepEqual(allows.projectSources('show', ['denied-source', 'allowed-source']), {
    sourceIds: ['allowed-source'], available: true,
  });
  database.prepare("UPDATE media_sources SET state='offline' WHERE id='allowed-source'").run();
  assert.deepEqual(createCanonicalMediaAccess(database, 'viewer').projectSources('show', ['denied-source', 'allowed-source']), {
    sourceIds: ['allowed-source'], available: false,
  }, 'an online source denied to the profile cannot make its offline permitted source available');
});
