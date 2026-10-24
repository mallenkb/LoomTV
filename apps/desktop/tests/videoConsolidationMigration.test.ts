import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import BetterSqlite3 from 'better-sqlite3';
import { initializeCanonicalSchema, profileAllowsCanonicalMedia } from 'loom-media-server-headless/native-persistence';
import { migrateDatabase } from '../src/main/databaseMigrations.ts';
import { canonicalVideoConnection, openConsolidatedVideoDatabase } from '../src/main/consolidatedVideoDatabase.ts';
import { importLegacyVideoJson } from '../src/main/legacyVideoJson.ts';

const { rollback } = createRequire(import.meta.url)('../../../scripts/rollback-native-video.cjs') as {
  rollback: (args: string[]) => void;
};

type Context = { after: (cleanup: () => void) => void };
function fixture(context: Context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-video-migration-'));
  const legacy = new BetterSqlite3(path.join(directory, 'loomtv.sqlite'));
  migrateDatabase(legacy);
  const owner = legacy.prepare("SELECT id FROM profiles WHERE profile_type='owner'").get() as { id: string };
  legacy.prepare("INSERT INTO library_folders(path,kind,added_at) VALUES('/native','movies',1)").run();
  legacy
    .prepare(`INSERT INTO media_items(id,type,title,year,file_path,summary,added_at,updated_at)
    VALUES('desktop-id','movie','Desktop title',2026,'/native/film.mkv','Desktop summary',1,100)`)
    .run();
  const canonical = new BetterSqlite3(path.join(directory, 'loomtv-canonical.sqlite'));
  context.after(() => {
    if (legacy.open) legacy.close();
    if (canonical.open) canonical.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  initializeCanonicalSchema(canonical as unknown as DatabaseSync);
  canonical.exec(`INSERT INTO accounts(id,name,account_type,role,permissions_json,disabled,created_at,updated_at)
    VALUES('owner','Owner','owner','owner','[]',0,1,1),('viewer','Viewer','user','viewer','[]',0,1,1);
    INSERT INTO owner_account(singleton,account_id) VALUES(1,'owner');
    INSERT INTO library_roots(id,locator,kind,state,created_at) VALUES('server-root','/server','movies','available',1);`);
  canonical
    .prepare(`INSERT INTO profiles(id,name,kind,avatar_key,color_key,has_pin,sort_order,created_at,updated_at)
    VALUES(?,'Owner','adult','glyph-01','ember',0,0,1,1)`)
    .run(owner.id);
  canonical.prepare("INSERT INTO profile_assignments(profile_id,account_id,access,created_at) VALUES(?,'owner','manage',1)").run(owner.id);
  return { directory, legacy, canonical, ownerId: owner.id };
}

test('verified aliases remap only staging and newer canonical progress survives alternate paths', (context) => {
  const { directory, legacy, canonical, ownerId } = fixture(context);
  legacy
    .prepare(`INSERT INTO playback_progress(profile_id,file_path,position,duration,watched,updated_at)
    VALUES(?,'/native/film.mkv',10,100,0,100)`)
    .run(ownerId);
  canonical.exec(`INSERT INTO catalog_items(id,media_type,media_kind,title,year,anime_likely,extension_json,created_at,updated_at)
    VALUES('canonical-id','movie','movie','Canonical title',2026,0,'{"metadata":{"summary":"Canonical summary"}}',1,200);
    INSERT INTO media_sources(id,media_id,root_id,relative_path,locator,state,indexed_at)
    VALUES('native-source','canonical-id','server-root','film.mkv','/native/film.mkv','online',1),
      ('preferred-source','canonical-id','server-root','film.mkv','/server/film.mkv','online',200);
    INSERT INTO media_identity_aliases(namespace,alias,media_id,created_at)
    VALUES('legacy-media-id','desktop-id','canonical-id',1);`);
  canonical
    .prepare(
      'INSERT INTO watch_progress(profile_id,media_id,position_seconds,duration_seconds,watched,updated_at) VALUES(?,?,?,?,?,?)',
    )
    .run(ownerId, 'canonical-id', 80, 100, 0, 200);
  legacy.close();
  canonical.close();
  const connection = openConsolidatedVideoDatabase(directory);
  try {
    const raw = canonicalVideoConnection(connection);
    assert.equal(
      raw.prepare("SELECT title FROM catalog_items WHERE id='canonical-id'").get()?.title,
      'Canonical title',
    );
    assert.equal(
      raw.prepare("SELECT position_seconds FROM watch_progress WHERE media_id='canonical-id'").get()?.position_seconds,
      80,
    );
    assert.equal(raw.prepare("SELECT 1 FROM catalog_items WHERE id='desktop-id'").get(), undefined);
    assert.deepEqual(
      JSON.parse(String(raw.prepare("SELECT root_ids_json FROM accounts WHERE id='viewer'").get()?.root_ids_json)),
      ['server-root'],
    );
    const ledger = raw.prepare('SELECT manifest_path,report_path FROM native_storage_migrations').get() as {
      manifest_path: string;
      report_path: string;
    };
    assert.equal(JSON.parse(fs.readFileSync(ledger.report_path, 'utf8')).accessBounds.identityAliases, 1);
    const extensions = new Set(
      (raw.prepare('SELECT name FROM native_extension_manifest').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    assert.ok(extensions.has('profile_path_grants'));
    for (const authority of [
      'catalog_items',
      'media_sources',
      'profiles',
      'accounts',
      'profile_credentials',
      'native_storage_migrations',
    ])
      assert.equal(extensions.has(authority), false);
    const manifest = JSON.parse(fs.readFileSync(ledger.manifest_path, 'utf8'));
    assert.deepEqual(manifest.artifacts.map((artifact: { kind: string }) => artifact.kind).sort(), [
      'canonical-pre-consolidation',
      'desktop-sqlite',
    ]);
  } finally {
    connection.close();
  }
  const original = new BetterSqlite3(path.join(directory, 'loomtv.sqlite'), { readonly: true });
  try {
    assert.equal(
      original.prepare("SELECT id FROM media_items WHERE file_path='/native/film.mkv'").get()?.id,
      'desktop-id',
    );
  } finally {
    original.close();
  }
});

test('profile security conflicts leave existing canonical and legacy records unchanged', (context) => {
  const { directory, legacy, canonical, ownerId } = fixture(context);
  canonical.prepare("UPDATE profiles SET kind='child' WHERE id=?").run(ownerId);
  legacy.close();
  canonical.close();
  assert.throws(
    () => openConsolidatedVideoDatabase(directory),
    (error: unknown) =>
      error instanceof Error && (error.cause as { code?: string })?.code === 'video_profile_security_conflict',
  );
  const unchanged = new BetterSqlite3(path.join(directory, 'loomtv-canonical.sqlite'), { readonly: true });
  try {
    assert.equal(unchanged.prepare('SELECT kind FROM profiles WHERE id=?').get(ownerId)?.kind, 'child');
    assert.equal(unchanged.prepare("SELECT value FROM meta WHERE key='native_video_storage_version'").get(), undefined);
    assert.equal(unchanged.prepare("SELECT 1 FROM catalog_items WHERE id='desktop-id'").get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('canonical subfolder grants are preserved when the same native profile grants a broader path', (context) => {
  const { directory, legacy, canonical, ownerId } = fixture(context);
  legacy.prepare('INSERT INTO profile_library_access(profile_id,folder_path) VALUES(?,?)').run(ownerId, '/native');
  canonical.exec(`CREATE TABLE profile_path_grants (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,folder_path TEXT NOT NULL,
    PRIMARY KEY(profile_id,folder_path));`);
  canonical
    .prepare('INSERT INTO profile_path_grants(profile_id,folder_path) VALUES(?,?)')
    .run(ownerId, '/native/allowed');
  legacy.close();
  canonical.close();
  const connection = openConsolidatedVideoDatabase(directory);
  try {
    assert.deepEqual(
      canonicalVideoConnection(connection)
        .prepare('SELECT folder_path FROM profile_path_grants WHERE profile_id=?')
        .all(ownerId),
      [{ folder_path: '/native/allowed' }],
    );
  } finally {
    connection.close();
  }
});

test('legacy JSON duplicates fail before any staging records are replaced', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-video-json-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = new BetterSqlite3(':memory:');
  try {
    migrateDatabase(database);
    const movie = { id: 'one-id', type: 'movie', title: 'One film', filePath: '/native/film.mkv' };
    const file = path.join(directory, 'library.json');
    fs.writeFileSync(file, JSON.stringify({ movies: [movie, { ...movie, filePath: '/native/other.mkv' }] }));
    assert.throws(() => importLegacyVideoJson(database, file), /conflicting file identities/);
    assert.equal(database.prepare('SELECT COUNT(*) count FROM media_items').get()?.count, 0);
  } finally {
    database.close();
  }
});

test('rollback verifies the ledger and restores the prior canonical database while archiving the current one', (context) => {
  const { directory, legacy, canonical } = fixture(context);
  legacy.close();
  canonical.close();
  const connection = openConsolidatedVideoDatabase(directory);
  connection.close();
  assert.throws(() => rollback(['--data-dir', directory]), /confirm-stopped/);
  rollback(['--data-dir', directory, '--confirm-stopped']);
  const restored = new BetterSqlite3(path.join(directory, 'loomtv-canonical.sqlite'), { readonly: true });
  try {
    assert.equal(restored.prepare("SELECT value FROM meta WHERE key='native_video_storage_version'").get(), undefined);
    assert.equal(restored.prepare("SELECT 1 FROM catalog_items WHERE id='desktop-id'").get(), undefined);
  } finally {
    restored.close();
  }
  assert.ok(fs.readdirSync(directory).some((file) => file.startsWith('loomtv-canonical.sqlite.before-rollback-')));
});

test('first desktop migration publishes one canonical database and restarts without importing again', (context) => {
  const {directory,legacy,canonical} = fixture(context);
  legacy.close();
  canonical.close();
  fs.unlinkSync(path.join(directory,'loomtv-canonical.sqlite'));
  const connection = openConsolidatedVideoDatabase(directory);
  try {
    const raw = canonicalVideoConnection(connection);
    assert.equal(raw.prepare("SELECT title FROM catalog_items WHERE id='desktop-id'").get()?.title,'Desktop title');
    assert.equal(raw.prepare('SELECT previous_canonical FROM native_storage_migrations').get()?.previous_canonical,0);
    assert.equal(raw.prepare("SELECT state FROM migration_markers").get()?.state,'committed');
    assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_items'").get(),undefined);
  } finally { connection.close(); }
  const reopened = openConsolidatedVideoDatabase(directory);
  try { assert.equal(canonicalVideoConnection(reopened).prepare('SELECT COUNT(*) count FROM native_storage_migrations').get()?.count,1); }
  finally { reopened.close(); }
  assert.ok(!fs.readdirSync(directory).some(name=>name.startsWith('.video-consolidation-')));
});

test('JSON-only migration preserves legacy input and native scan-cache metadata', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'loom-video-json-migration-'));
  context.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file = path.join(directory,'library.json');
  const input = JSON.stringify({
    movies:[{title:'JSON film',filePath:'/native/json.mkv',summary:'Legacy summary'}],
    libraryFolderGroups:{movies:['/native'],tvShows:[],anime:[],others:[]},
    scanCache:{'/native':{folderKind:'movies',signature:'retained-signature',fileCount:1,itemCount:1,scannedAt:123}},
  });
  fs.writeFileSync(file,input);
  const connection = openConsolidatedVideoDatabase(directory);
  try {
    const raw = canonicalVideoConnection(connection);
    assert.equal(raw.prepare("SELECT title FROM catalog_items WHERE title='JSON film'").get()?.title,'JSON film');
    assert.equal(raw.prepare("SELECT signature FROM scan_cache WHERE folder_path='/native'").get()?.signature,'retained-signature');
    const ledger = raw.prepare('SELECT manifest_path FROM native_storage_migrations').get() as {manifest_path:string};
    const manifest = JSON.parse(fs.readFileSync(ledger.manifest_path,'utf8'));
    assert.deepEqual(manifest.artifacts.map((artifact:{kind:string})=>artifact.kind),['desktop-library-json']);
    assert.equal(fs.readFileSync(file,'utf8'),input);
    assert.equal(fs.existsSync(path.join(directory,'loomtv.sqlite')),false);
  } finally { connection.close(); }
  rollback(['--data-dir',directory,'--confirm-stopped']);
  assert.equal(fs.existsSync(path.join(directory,'loomtv-canonical.sqlite')),false);
  assert.equal(fs.readFileSync(file,'utf8'),input);
});

test('rollback rejects changed evidence before archiving or replacing database files', (context) => {
  const {directory,legacy,canonical} = fixture(context);
  legacy.close();
  canonical.close();
  const connection = openConsolidatedVideoDatabase(directory);
  let reportPath: string;
  try {
    reportPath = String(canonicalVideoConnection(connection).prepare('SELECT report_path FROM native_storage_migrations').get()?.report_path);
  } finally { connection.close(); }
  fs.chmodSync(reportPath,0o600);
  fs.appendFileSync(reportPath,' ');
  assert.throws(()=>rollback(['--data-dir',directory,'--confirm-stopped']),/evidence is missing or changed/);
  assert.ok(!fs.readdirSync(directory).some(name=>name.includes('before-rollback-')));
  const unchanged = openConsolidatedVideoDatabase(directory);
  try { assert.equal(canonicalVideoConnection(unchanged).prepare("SELECT title FROM catalog_items WHERE id='desktop-id'").get()?.title,'Desktop title'); }
  finally { unchanged.close(); }
});


test('new native nonowner profiles retain only native roots when canonical server-only roots exist', (context) => {
  const {directory,legacy,canonical} = fixture(context);
  legacy.prepare(`INSERT INTO profiles(id,name,avatar_key,color_key,profile_type,created_at,updated_at)
    VALUES('native-viewer','Native viewer','glyph-01','ember','standard',1,1)`).run();
  canonical.exec(`INSERT INTO catalog_items(id,media_type,media_kind,title,anime_likely,created_at,updated_at)
    VALUES('server-only-film','movie','movie','Server-only film',0,1,1);
    INSERT INTO media_sources(id,media_id,root_id,relative_path,locator,state,indexed_at)
    VALUES('server-only-source','server-only-film','server-root','private.mkv','/server/private.mkv','online',1);`);
  legacy.close();
  canonical.close();
  const connection = openConsolidatedVideoDatabase(directory);
  try {
    const raw = canonicalVideoConnection(connection);
    assert.equal(profileAllowsCanonicalMedia(raw as unknown as DatabaseSync,'native-viewer','desktop-id'),true);
    assert.equal(profileAllowsCanonicalMedia(raw as unknown as DatabaseSync,'native-viewer','server-only-film'),false);
    assert.deepEqual(raw.prepare('SELECT folder_path FROM profile_path_grants WHERE profile_id=?').all('native-viewer'),[{folder_path:'/native'}]);
  } finally { connection.close(); }
});

test('overlapping native metadata uses a private source extension and preserves the canonical probe', (context) => {
  const {directory,legacy,canonical} = fixture(context);
  const nativeMetadata = {fileSize:1024,audioTracks:2};
  const canonicalProbe = JSON.stringify({sourceId:'canonical-source',hdr:false,tracks:[],probedAt:200});
  legacy.prepare("UPDATE media_items SET local_metadata_json=? WHERE id='desktop-id'").run(JSON.stringify(nativeMetadata));
  canonical.exec(`INSERT INTO catalog_items(id,media_type,media_kind,title,anime_likely,created_at,updated_at)
    VALUES('desktop-id','movie','movie','Canonical title',0,1,1);`);
  canonical.prepare(`INSERT INTO media_sources(id,media_id,root_id,relative_path,locator,state,indexed_at,probe_json)
    VALUES('canonical-source','desktop-id','server-root','film.mkv','/native/film.mkv','online',1,?)`).run(canonicalProbe);
  legacy.close();
  canonical.close();
  const connection = openConsolidatedVideoDatabase(directory);
  try {
    const row = canonicalVideoConnection(connection).prepare("SELECT probe_json,extension_json FROM media_sources WHERE id='canonical-source'").get() as {probe_json:string;extension_json:string};
    assert.equal(row.probe_json,canonicalProbe);
    assert.deepEqual(JSON.parse(row.extension_json).nativeLocalMetadata,nativeMetadata);
  } finally { connection.close(); }
});
