import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import BetterSqlite3 from 'better-sqlite3';
import {
  CANONICAL_STATE_FILENAME,
  CANONICAL_MIGRATION_FORMAT,
  CANONICAL_SCHEMA_VERSION,
  initializeCanonicalSchema,
  registerNativeVideoFunctions,
} from 'loom-media-server-headless/native-persistence';
import { migrateDatabase } from './databaseMigrations.ts';
import { createNativeVideoSchema, nativeVideoSql, nativeVideoTables } from './nativeVideoSchema.ts';
import { importLegacyVideoJson } from './legacyVideoJson.ts';

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const coreTables = new Set<string>(nativeVideoTables);
type Row = Record<string, string | number | bigint | Buffer | null>;
type SchemaRow = { name: string; type: string; tbl_name: string; sql: string };

function verify(database: BetterSqlite3.Database): void {
  if (database.pragma('quick_check', { simple: true }) !== 'ok')
    throw new Error('Video database integrity verification failed.');
  if ((database.pragma('foreign_key_check') as unknown[]).length)
    throw new Error('Video database reference verification failed.');
  const columns = database.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>;
  if (
    columns.some((column) => column.name === 'has_pin') &&
    database
      .prepare(`SELECT 1 FROM profiles p
    WHERE p.has_pin != EXISTS(SELECT 1 FROM profile_credentials c WHERE c.profile_id=p.id) LIMIT 1`)
      .get()
  ) {
    throw new Error('Video profile PIN state is inconsistent.');
  }
  if (
    columns.some((column) => column.name === 'has_pin') &&
    database
      .prepare(`SELECT 1 FROM meta m
    WHERE m.key='native_owner_profile' AND NOT EXISTS (
      SELECT 1 FROM profiles p JOIN profile_assignments a ON a.profile_id=p.id
      JOIN owner_account o ON o.account_id=a.account_id
      WHERE p.id=m.value AND p.kind='adult' AND a.access='manage'
    ) LIMIT 1`)
      .get()
  ) {
    throw Object.assign(new Error('The desktop owner must retain its owner-account management assignment.'), {
      code: 'video_owner_assignment_conflict',
    });
  }
}

function syncFile(file: string): void {
  const descriptor = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function backup(source: BetterSqlite3.Database, destination: string): void {
  source.prepare('VACUUM INTO ?').run(destination);
  fs.chmodSync(destination, 0o600);
  const copied = new BetterSqlite3(destination, { readonly: true });
  try {
    verify(copied);
  } finally {
    copied.close();
  }
  fs.chmodSync(destination, 0o400);
  syncFile(destination);
}

function digest(file: string): { sha256: string; sizeBytes: number } {
  const hash = createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let sizeBytes = 0;
  try {
    let bytes: number;
    while ((bytes = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
      sizeBytes += bytes;
    }
  } finally {
    fs.closeSync(handle);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

function durableJson(file: string, value: unknown): void {
  const descriptor = fs.openSync(file, 'wx', 0o400);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensureLocalOwner(database: BetterSqlite3.Database): void {
  if (database.prepare('SELECT account_id FROM owner_account WHERE singleton=1').get()) return;
  // This credential is never exposed or used for network login. Desktop owner
  // sessions are issued by the in-process host. Administration can set a password.
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(randomBytes(48).toString('base64url'), salt, 64).toString('base64');
  const now = Date.now();
  database
    .prepare(`INSERT INTO accounts(id,name,account_type,role,permissions_json,disabled,created_at,updated_at)
    VALUES('desktop-owner','Owner','owner','owner','[]',0,?,?)`)
    .run(now, now);
  database
    .prepare(
      "INSERT INTO account_credentials(account_id,password_salt,password_hash,password_algorithm,updated_at) VALUES('desktop-owner',?,?,'scrypt',?)",
    )
    .run(salt, hash, now);
  database.prepare("INSERT INTO owner_account(singleton,account_id) VALUES(1,'desktop-owner')").run();
  database.prepare("INSERT INTO meta(key,value) VALUES('native_owner_password_pending','1')").run();
}

function copyRows(
  source: BetterSqlite3.Database,
  target: BetterSqlite3.Database,
  from: string,
  to = from,
  ignore = false,
  existingProfiles = new Set<string>(),
): void {
  const columns = source.prepare(`PRAGMA table_info(${ident(from)})`).all() as Array<{ name: string }>;
  if (!columns.length) return;
  const available = new Set(
    (target.prepare(`PRAGMA table_info(${ident(to)})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  const fields = columns.map((column) => column.name).filter((name) => available.has(name));
  if (!fields.length) return;
  const insert = target.prepare(
    `INSERT ${ignore ? 'OR IGNORE ' : ''}INTO ${ident(to)}(${fields.map(ident).join(',')}) VALUES(${fields.map(() => '?').join(',')})`,
  );
  const primary = (source.prepare(`PRAGMA table_info(${ident(from)})`).all() as Array<{ name: string; pk: number }>)
    .filter((column) => column.pk && fields.includes(column.name))
    .map((column) => column.name);
  const existing = primary.length
    ? target.prepare(
        `SELECT ${available.has('updated_at') ? 'updated_at' : '1 present'} FROM ${ident(to)} WHERE ${primary.map((field) => `${ident(field)}=?`).join(' AND ')}`,
      )
    : null;
  for (const row of source
    .prepare(`SELECT ${fields.map(ident).join(',')} FROM ${ident(from)}`)
    .iterate() as Iterable<Row>) {
    if (from === 'profile_library_access' && existingProfiles.has(String(row.profile_id))) continue;
    const present =
      from === 'playback_progress'
        ? (target
            .prepare(`SELECT updated_at FROM watch_progress WHERE profile_id=? AND media_id=COALESCE(
          (SELECT media_id FROM media_sources WHERE locator=?),
          (SELECT media_id FROM media_identity_aliases WHERE alias=? LIMIT 1),'native-unresolved:'||loom_root_id(?))`)
            .get(row.profile_id, row.file_path, row.file_path, row.file_path) as { updated_at?: number } | undefined)
        : from === 'episodes'
          ? (target
              .prepare(
                "SELECT 1 present FROM catalog_items WHERE media_kind='episode' AND json_extract(extension_json,'$.seriesId')=? AND series_season=? AND series_episode=?",
              )
              .get(row.media_id, row.season, row.number) as { updated_at?: number } | undefined)
          : from === 'episode_files'
            ? (target.prepare('SELECT 1 present FROM media_sources WHERE locator=?').get(row.file_path) as
                | { updated_at?: number }
                | undefined)
            : from === 'device_profile_selections'
              ? (target.prepare('SELECT 1 present FROM profile_selections WHERE device_id=?').get(row.device_id) as
                  | { updated_at?: number }
                  | undefined)
              : from === 'media_items'
                ? (target.prepare('SELECT updated_at FROM catalog_items WHERE id=?').get(row.id) as
                    | { updated_at?: number }
                    | undefined)
                : from === 'library_folders'
                  ? (target.prepare('SELECT 1 present FROM library_roots WHERE locator=?').get(row.path) as
                      | { updated_at?: number }
                      | undefined)
                  : from === 'profile_preferences'
                    ? (target
                        .prepare('SELECT updated_at FROM profile_preferences WHERE profile_id=?')
                        .get(row.profile_id) as { updated_at?: number } | undefined)
                    : (existing?.get(...primary.map((field) => row[field])) as { updated_at?: number } | undefined);
    if (present && !(from === 'playback_progress' && Number(row.updated_at) > Number(present.updated_at || 0))) {
      if (from === 'profiles') {
        const profile = target.prepare('SELECT kind,guest_device_id FROM profiles WHERE id=?').get(row.id) as {
          kind: string;
          guest_device_id: string | null;
        };
        const expectedKind = row.profile_type === 'kid' ? 'child' : row.profile_type === 'guest' ? 'guest' : 'adult';
        const credential = target
          .prepare('SELECT pin_hash,pin_salt FROM profile_credentials WHERE profile_id=?')
          .get(row.id) as { pin_hash: string; pin_salt: string } | undefined;
        if (
          profile.kind !== expectedKind ||
          (profile.guest_device_id || null) !== (row.guest_device_id || null) ||
          (credential?.pin_hash || null) !== row.pin_hash ||
          (credential?.pin_salt || null) !== row.pin_salt
        ) {
          throw Object.assign(
            new Error('Desktop and server profile security settings conflict. Resolve them before consolidation.'),
            { code: 'video_profile_security_conflict' },
          );
        }
      }
      if (from === 'profile_restrictions') {
        const policy = target
          .prepare('SELECT country,maximum_age,allow_unrated FROM native_profile_restrictions WHERE profile_id=?')
          .get(row.profile_id) as Row;
        if (
          policy.country !== row.country ||
          policy.maximum_age !== row.maximum_age ||
          policy.allow_unrated !== row.allow_unrated
        ) {
          throw Object.assign(
            new Error('Desktop and server age policies conflict. Resolve them before consolidation.'),
            { code: 'video_profile_policy_conflict' },
          );
        }
        target
          .prepare('UPDATE profile_restrictions SET revision=MAX(revision,?)+1 WHERE profile_id=?')
          .run(row.revision, row.profile_id);
      }
      if (from === 'device_profile_selection_revisions')
        target
          .prepare(`INSERT INTO native_selection_revisions(device_id,revision) VALUES(?,?)
        ON CONFLICT(device_id) DO UPDATE SET revision=MAX(native_selection_revisions.revision,excluded.revision)`)
          .run(row.device_id, row.revision);
      // A previously migrated canonical record may have changed on another
      // client. Preserve it and fill only metadata it never carried.
      if (from === 'media_items') {
        const metadata: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(row)) {
          if (
            ['id', 'title', 'year', 'type', 'file_path', 'file_size', 'added_at', 'updated_at', 'last_played'].includes(
              field,
            )
          )
            continue;
          const name = field
            .replace(/_json$/, '')
            .replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
          metadata[name] = field.endsWith('_json') && typeof value === 'string' ? JSON.parse(value) : value;
        }
        target
          .prepare(
            "UPDATE catalog_items SET extension_json=json_patch(json_object('metadata',json(?)),extension_json) WHERE id=?",
          )
          .run(JSON.stringify(metadata), row.id);
        if (Number(row.added_at) > 0)
          target.prepare('UPDATE catalog_items SET created_at=? WHERE id=? AND created_at=0').run(row.added_at, row.id);
        const current = target.prepare('SELECT media_kind FROM catalog_items WHERE id=?').get(row.id) as {
          media_kind: string;
        };
        if (current.media_kind !== (row.type === 'movie' ? 'movie' : 'series'))
          throw Object.assign(new Error('Desktop and server media kinds conflict.'), {
            code: 'video_media_identity_conflict',
          });
        if (row.type !== 'movie')
          target
            .prepare('INSERT OR IGNORE INTO video_series_locations(media_id,locator) VALUES(?,?)')
            .run(row.id, row.file_path);
        else if (row.file_path)
          target
            .prepare(`INSERT INTO media_sources(id,media_id,root_id,relative_path,locator,state,file_extension,size_bytes,indexed_at,last_seen_at,extension_json)
          SELECT ?||':native:'||loom_root_id(?),?,r.id,loom_relative(COALESCE(r.locator,?),?),?,'online',loom_extension(?),?,?,?,json_object('nativeLocalMetadata',json(COALESCE(?,'null')))
          FROM (SELECT 1) LEFT JOIN library_roots r ON r.id=(SELECT id FROM library_roots WHERE state!='removed' AND loom_contains(locator,?) ORDER BY length(locator) DESC LIMIT 1)
          WHERE 1 ON CONFLICT(locator) DO NOTHING`)
            .run(
              row.id,
              row.file_path,
              row.id,
              row.file_path,
              row.file_path,
              row.file_path,
              row.file_path,
              row.file_size,
              row.updated_at || 0,
              row.updated_at || 0,
              row.local_metadata_json,
              row.file_path,
            );
        if (row.type === 'movie' && row.file_path)
          target
            .prepare(`UPDATE media_sources SET
          extension_json=json_patch(json_object('nativeLocalMetadata',json(COALESCE(?,'null'))),extension_json) WHERE locator=?`)
            .run(row.local_metadata_json, row.file_path);
      }
      if (from === 'episode_files') {
        // The source path identifies the existing canonical episode. Keep its
        // current source state and probe, and fill only absent native metadata.
        const metadata = JSON.stringify({
          title: row.title,
          thumbnail: row.thumbnail,
          still: row.still,
          subtitles: typeof row.subtitles_json === 'string' ? JSON.parse(row.subtitles_json) : [],
          nativeLocalMetadata: typeof row.local_metadata_json === 'string' ? JSON.parse(row.local_metadata_json) : null,
        });
        target
          .prepare('UPDATE media_sources SET extension_json=json_patch(json(?),extension_json) WHERE locator=?')
          .run(metadata, row.file_path);
      }
      if (from === 'profile_preferences')
        target
          .prepare(`INSERT INTO native_profile_ui(profile_id,payload_json,revision,updated_at)
        VALUES(?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET payload_json=json_patch(excluded.payload_json,native_profile_ui.payload_json)`)
          .run(row.profile_id, row.preferences_json, row.revision || 0, row.updated_at || 0);
      if (from === 'profile_preferences')
        target
          .prepare(
            "UPDATE profile_preferences SET payload_json=json_patch(loom_preferences(?,'canonical'),payload_json) WHERE profile_id=?",
          )
          .run(row.preferences_json, row.profile_id);
      continue;
    }
    insert.run(...fields.map((field) => row[field]));
  }
}

function installExtensions(schema: BetterSqlite3.Database, target: BetterSqlite3.Database): void {
  const definitions = schema
    .prepare(
      "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type='index',rowid",
    )
    .all() as SchemaRow[];
  const exists = target.prepare('SELECT type FROM sqlite_master WHERE name=?');
  for (const row of definitions) {
    if (coreTables.has(row.tbl_name) || exists.get(row.name)) continue;
    // Foreign keys target the canonical identity/profile rows, not views.
    const sql = row.sql.replace(/REFERENCES\s+media_items\b/gi, 'REFERENCES catalog_items');
    target.exec(sql);
  }
}

function importNativeVideo(
  source: BetterSqlite3.Database,
  target: BetterSqlite3.Database,
): { importedRoots: number; boundedServerAccounts: number; boundedNativeProfiles: number; identityAliases: number } {
  const previousProfiles = new Set(
    (target.prepare('SELECT id FROM profiles').all() as Array<{ id: string }>).map((row) => row.id),
  );
  const previousRoots = (
    target.prepare("SELECT id FROM library_roots WHERE state!='removed'").all() as Array<{ id: string }>
  ).map((row) => row.id);
  const nativeRoots = (source.prepare('SELECT path FROM library_folders').all() as Array<{ path: string }>).map(
    (row) => row.path,
  );
  const canonicalOnlyRoots = target.prepare("SELECT locator FROM library_roots WHERE state!='removed'").all() as Array<{
    locator: string;
  }>;
  const hasServerOnlyRoots = canonicalOnlyRoots.some((row) => !nativeRoots.includes(row.locator));
  // Resolve path identity before importing children and per-profile references.
  // A collision fails the entire transaction rather than choosing a title silently.
  const itemRows = source.prepare('SELECT id,file_path FROM media_items').all() as Array<{
    id: string;
    file_path: string;
  }>;
  const aliases = new Map<string, string>();
  for (const item of itemRows) {
    const existing = target.prepare('SELECT media_id FROM media_sources WHERE locator=?').get(item.file_path) as
      | { media_id: string }
      | undefined;
    if (existing && existing.media_id !== item.id) {
      if (
        !target
          .prepare(
            "SELECT 1 FROM media_identity_aliases WHERE media_id=? AND alias=? AND namespace IN ('desktop-path-hash','legacy-media-id')",
          )
          .get(existing.media_id, item.id)
      ) {
        throw Object.assign(
          new Error('Desktop and server video identities conflict. Resolve them before consolidation.'),
          { code: 'video_media_identity_conflict' },
        );
      }
      aliases.set(item.id, existing.media_id);
    }
  }
  if (aliases.size) {
    source.pragma('foreign_keys=OFF');
    try {
      source.transaction(() => {
        const tables = source
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>;
        for (const [oldId, newId] of aliases) {
          source.prepare('UPDATE media_items SET id=? WHERE id=?').run(newId, oldId);
          for (const { name } of tables) {
            const columns = source.prepare(`PRAGMA table_info(${ident(name)})`).all() as Array<{ name: string }>;
            if (columns.some((column) => column.name === 'media_id'))
              source.prepare(`UPDATE ${ident(name)} SET media_id=? WHERE media_id=?`).run(newId, oldId);
          }
          for (const prefix of ['', 'media:', 'series:'])
            source
              .prepare('UPDATE playback_track_preferences SET scope=? WHERE scope=?')
              .run(prefix + newId, prefix + oldId);
        }
      })();
      verify(source);
    } finally {
      source.pragma('foreign_keys=ON');
    }
  }
  // An existing episode's local path proves its canonical identity. Attach the
  // missing native parent association without replacing canonical title/probe data.
  for (const episode of source.prepare('SELECT * FROM episode_files').iterate() as Iterable<Row>) {
    const current = target
      .prepare(`SELECT c.id,c.media_kind,c.series_season,c.series_episode,
      json_extract(c.extension_json,'$.seriesId') series_id FROM media_sources s JOIN catalog_items c ON c.id=s.media_id WHERE s.locator=?`)
      .get(episode.file_path) as Row | undefined;
    if (!current) continue;
    if (
      current.media_kind !== 'episode' ||
      (current.series_id !== null && current.series_id !== episode.media_id) ||
      (current.series_season !== null && current.series_season !== episode.season) ||
      (current.series_episode !== null && current.series_episode !== episode.episode)
    ) {
      throw Object.assign(new Error('Desktop and server episode identities conflict.'), {
        code: 'video_media_identity_conflict',
      });
    }
    const metadata = source
      .prepare(
        'SELECT title,summary,still,rating,air_date,local_metadata_json FROM episodes WHERE media_id=? AND season=? AND number=?',
      )
      .get(episode.media_id, episode.season, episode.episode) as Row | undefined;
    const nativeMetadata = metadata
      ? {
          summary: metadata.summary,
          still: metadata.still,
          rating: metadata.rating,
          airDate: metadata.air_date,
          localMetadata:
            typeof metadata.local_metadata_json === 'string' ? JSON.parse(metadata.local_metadata_json) : null,
        }
      : {};
    target
      .prepare(`UPDATE catalog_items SET series_season=COALESCE(series_season,?),series_episode=COALESCE(series_episode,?),
      extension_json=json_patch(json_object('seriesId',?,'metadata',json(?)),extension_json) WHERE id=?`)
      .run(episode.season, episode.episode, episode.media_id, JSON.stringify(nativeMetadata), current.id);
  }
  // Profiles, roots, parent titles, episode metadata, then viewer state.
  for (const table of [
    'profiles',
    'library_folders',
    'media_items',
    'seasons',
    'episodes',
    'episode_files',
    'profile_preferences',
    'profile_restrictions',
    'profile_library_access',
    'profile_media_lists',
    'playback_progress',
    'playback_track_preferences',
    'device_profile_selection_revisions',
    'device_profile_selections',
  ]) {
    copyRows(source, target, table, `native_${table}`, false, previousProfiles);
  }
  const importedRoots = (
    target.prepare("SELECT id FROM library_roots WHERE state!='removed'").all() as Array<{ id: string }>
  ).filter((row) => !previousRoots.includes(row.id)).length;
  const boundedServerAccounts = importedRoots
    ? Number(
        target
          .prepare("UPDATE accounts SET root_ids_json=? WHERE account_type!='owner' AND root_ids_json IS NULL")
          .run(JSON.stringify(previousRoots)).changes,
      )
    : 0;
  let boundedNativeProfiles = 0;
  if (hasServerOnlyRoots) {
    for (const profile of source.prepare("SELECT id FROM profiles WHERE profile_type!='owner'").all() as Array<{
      id: string;
    }>) {
      if (previousProfiles.has(profile.id)) continue;
      const explicit = source
        .prepare('SELECT 1 FROM profile_library_access WHERE profile_id=? LIMIT 1')
        .get(profile.id);
      if (explicit) continue;
      boundedNativeProfiles += 1;
      if (nativeRoots.length) {
        const grant = target.prepare('INSERT OR IGNORE INTO profile_path_grants(profile_id,folder_path) VALUES(?,?)');
        for (const folder of nativeRoots) grant.run(profile.id, folder);
      } else {
        target
          .prepare(`INSERT INTO profile_restrictions(profile_id,allowed_root_ids_json,payload_json,revision)
          VALUES(?,'[]',json_object('country','US','maximumAge',NULL,'allowUnrated',json('false')),1)
          ON CONFLICT(profile_id) DO UPDATE SET allowed_root_ids_json='[]'`)
          .run(profile.id);
      }
    }
  }
  target.exec(`UPDATE profile_selections SET revision=MAX(revision,COALESCE((SELECT revision FROM native_selection_revisions n WHERE n.device_id=profile_selections.device_id),0))+1,
    automatic_sign_in=CASE WHEN EXISTS(SELECT 1 FROM profiles p WHERE p.id=profile_selections.profile_id AND p.has_pin=1) THEN 0 ELSE automatic_sign_in END WHERE account_id=(SELECT account_id FROM owner_account WHERE singleton=1);`);
  const nativeOwner = source.prepare("SELECT id FROM profiles WHERE profile_type='owner'").get() as
    | { id: string }
    | undefined;
  if (nativeOwner)
    target.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('native_owner_profile',?)").run(nativeOwner.id);
  const extras = source
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  for (const { name } of extras) if (!coreTables.has(name)) copyRows(source, target, name, name, true);
  return { importedRoots, boundedServerAccounts, boundedNativeProfiles, identityAliases: aliases.size };
}

/** Prepare canonical storage before the native repositories can access it. */
export function openConsolidatedVideoDatabase(dataDir: string): BetterSqlite3.Database {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const canonicalPath = path.join(dataDir, CANONICAL_STATE_FILENAME);
  const legacyPath = path.join(dataDir, 'loomtv.sqlite');
  const isNew = !fs.existsSync(canonicalPath);
  const targetPath = isNew ? path.join(dataDir, `.video-consolidation-${randomUUID()}.stage`) : canonicalPath;
  const database = new BetterSqlite3(targetPath, { fileMustExist: !isNew });
  fs.chmodSync(targetPath, 0o600);
  const nodeConnection = database as unknown as DatabaseSync;
  let schema: BetterSqlite3.Database | null = null;
  let legacy: BetterSqlite3.Database | null = null;
  let stagingLegacy: BetterSqlite3.Database | null = null;
  const migrationId = randomUUID();
  const backupDir = path.join(dataDir, 'video-consolidation-backups', migrationId);
  let canonicalVersion: unknown;
  let stagePath: string | null = null;
  let committed = false;
  let published = !isNew;
  try {
    database.pragma('busy_timeout = 5000');
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    registerNativeVideoFunctions(nodeConnection);
    const already = database.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get()
      ? (database.prepare("SELECT value FROM meta WHERE key='native_video_storage_version'").get() as
          | { value: string }
          | undefined)
      : undefined;
    if (already?.value === '1') {
      verify(database);
      return nativeDatabaseFacade(database);
    }
    if (already) throw new Error('This video storage version requires a newer LoomTV application.');
    const backupsParent = path.dirname(backupDir);
    fs.mkdirSync(backupsParent, { recursive: true, mode: 0o700 });
    fs.mkdirSync(backupDir, { mode: 0o700 });
    syncDirectory(backupsParent);
    syncDirectory(dataDir);
    if (!isNew) {
      verify(database);
      canonicalVersion = database.pragma('data_version', { simple: true });
      backup(database, path.join(backupDir, CANONICAL_STATE_FILENAME));
    } else {
      for (const name of ['headless-admin.json', 'headless-client.sqlite', 'headless-client.json']) {
        if (fs.existsSync(path.join(dataDir, name)))
          throw Object.assign(
            new Error(
              'Legacy server state must be imported through the verified migration tool before desktop consolidation.',
            ),
            { code: 'video_legacy_server_import_required' },
          );
      }
      initializeCanonicalSchema(nodeConnection);
    }
    if (fs.existsSync(legacyPath)) {
      legacy = new BetterSqlite3(legacyPath, { fileMustExist: true });
      verify(legacy);
      const sourceVersion = legacy.pragma('data_version', { simple: true });
      stagePath = path.join(backupDir, 'desktop-staged.sqlite');
      backup(legacy, path.join(backupDir, 'loomtv.sqlite'));
      legacy.exec('BEGIN IMMEDIATE');
      if (legacy.pragma('data_version', { simple: true }) !== sourceVersion)
        throw Object.assign(
          new Error('The desktop library changed during backup. Close its other writers and retry.'),
          { code: 'video_desktop_changed' },
        );
      fs.copyFileSync(path.join(backupDir, 'loomtv.sqlite'), stagePath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(stagePath, 0o600);
      stagingLegacy = new BetterSqlite3(stagePath);
      migrateDatabase(stagingLegacy);
      schema = stagingLegacy;
    } else {
      schema = new BetterSqlite3(':memory:');
      migrateDatabase(schema);
    }
    const source = schema;
    const legacyJson = path.join(dataDir, 'library.json');
    const importJson =
      (source.prepare('SELECT COUNT(*) count FROM media_items').get() as { count: number }).count === 0 &&
      fs.existsSync(legacyJson);
    if (importJson) {
      fs.copyFileSync(legacyJson, path.join(backupDir, 'library.json'), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(backupDir, 'library.json'), 0o400);
      syncFile(path.join(backupDir, 'library.json'));
      importLegacyVideoJson(source, path.join(backupDir, 'library.json'));
    }
    const artifacts = [
      ...(legacy
        ? [{ kind: 'desktop-sqlite', fileName: 'loomtv.sqlite', ...digest(path.join(backupDir, 'loomtv.sqlite')) }]
        : []),
      ...(!isNew
        ? [
            {
              kind: 'canonical-pre-consolidation',
              fileName: CANONICAL_STATE_FILENAME,
              ...digest(path.join(backupDir, CANONICAL_STATE_FILENAME)),
            },
          ]
        : []),
      ...(importJson
        ? [{ kind: 'desktop-library-json', fileName: 'library.json', ...digest(path.join(backupDir, 'library.json')) }]
        : []),
    ];
    const manifestPath = path.join(backupDir, 'manifest.json');
    const reportPath = path.join(backupDir, 'report.json');
    durableJson(manifestPath, { format: 'loomtv-native-video-backup-v1', migrationId, artifacts });
    const manifestDigest = digest(manifestPath);
    database
      .transaction(() => {
        if (!isNew && database.pragma('data_version', { simple: true }) !== canonicalVersion)
          throw Object.assign(
            new Error('The canonical library changed during backup. Close its other writers and retry.'),
            { code: 'video_canonical_changed' },
          );
        database.pragma('defer_foreign_keys = ON');
        ensureLocalOwner(database);
        const canonicalTables = new Set(
          (database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
            (row) => row.name,
          ),
        );
        installExtensions(source, database);
        createNativeVideoSchema(database);
        const accessBounds = importNativeVideo(source, database);
        database.exec(`CREATE TABLE IF NOT EXISTS native_storage_migrations (
        id TEXT PRIMARY KEY,manifest_path TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,
        report_path TEXT NOT NULL,report_sha256 TEXT NOT NULL,previous_canonical INTEGER NOT NULL,created_at INTEGER NOT NULL);`);
        database.exec('CREATE TABLE IF NOT EXISTS native_extension_manifest(name TEXT PRIMARY KEY)');
        const recordExtension = database.prepare('INSERT OR IGNORE INTO native_extension_manifest(name) VALUES(?)');
        for (const row of database
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>) {
          // Recovery evidence stays local and cannot be replaced by a JSON backup.
          if (
            (!canonicalTables.has(row.name) || row.name === 'profile_path_grants') &&
            !['native_extension_manifest', 'native_storage_migrations'].includes(row.name)
          )
            recordExtension.run(row.name);
        }
        const now = Date.now();
        const counts = {
          catalogItems: (database.prepare('SELECT COUNT(*) count FROM catalog_items').get() as { count: number }).count,
          profiles: (database.prepare('SELECT COUNT(*) count FROM profiles').get() as { count: number }).count,
          roots: (database.prepare('SELECT COUNT(*) count FROM library_roots').get() as { count: number }).count,
          progress: (database.prepare('SELECT COUNT(*) count FROM watch_progress').get() as { count: number }).count,
        };
        verify(database);
        durableJson(reportPath, {
          version: 1,
          migrationId,
          createdAt: now,
          commitAuthority: 'SQLite migration ledger',
          legacyPreserved: Boolean(legacy),
          canonicalBackup: !isNew,
          counts,
          accessBounds,
          accessRules: {
            serverAccounts:
              'Previously unrestricted nonowner accounts retain only prior canonical roots when native roots are added.',
            nativeProfiles:
              'New nonowner native profiles without explicit grants retain only prior native roots when server-only roots exist.',
            overlappingProfiles: 'Existing canonical profile grants are preserved.',
          },
        });
        syncDirectory(backupDir);
        const reportDigest = digest(reportPath);
        if (isNew)
          database
            .prepare(`INSERT INTO migration_markers(id,format,schema_version,source_fingerprint,state,
        source_counts_json,reconciliation_json,target_counts_json,created_at,committed_at,
        backup_path,backup_sha256,backup_size_bytes,report_path,report_sha256,report_size_bytes)
        VALUES(?,?,?,?,'committed','{}','{}',?,?,?,?,?,?,?,?,?)`)
            .run(
              migrationId,
              CANONICAL_MIGRATION_FORMAT,
              CANONICAL_SCHEMA_VERSION,
              legacy ? 'desktop-consolidation' : 'fresh-install',
              JSON.stringify(counts),
              now,
              now,
              manifestPath,
              manifestDigest.sha256,
              manifestDigest.sizeBytes,
              reportPath,
              reportDigest.sha256,
              reportDigest.sizeBytes,
            );
        database
          .prepare('INSERT INTO native_storage_migrations VALUES(?,?,?,?,?,?,?)')
          .run(migrationId, manifestPath, manifestDigest.sha256, reportPath, reportDigest.sha256, isNew ? 0 : 1, now);
        database.prepare("INSERT INTO meta(key,value) VALUES('native_video_storage_version','1')").run();
        database.prepare("INSERT INTO meta(key,value) VALUES('native_video_backup_id',?)").run(migrationId);
        verify(database);
      })
      .immediate();
    committed = true;
    database.pragma('wal_checkpoint(TRUNCATE)');
    syncFile(targetPath);
    if (isNew) {
      database.close();
      // Publish without replacing a database another process created meanwhile.
      fs.linkSync(targetPath, canonicalPath);
      published = true;
      fs.unlinkSync(targetPath);
      syncDirectory(dataDir);
      const reopened = new BetterSqlite3(canonicalPath, { fileMustExist: true });
      try {
        reopened.pragma('busy_timeout = 5000');
        reopened.pragma('foreign_keys = ON');
        reopened.pragma('synchronous = FULL');
        registerNativeVideoFunctions(reopened as unknown as DatabaseSync);
        verify(reopened);
        return nativeDatabaseFacade(reopened);
      } catch (error) {
        reopened.close();
        throw error;
      }
    }
    return nativeDatabaseFacade(database);
  } catch (error) {
    if (database.open) database.close();
    if (isNew)
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(`${targetPath}${suffix}`);
        } catch {
          /* No published database is removed. */
        }
      }
    const causeCode = (error as NodeJS.ErrnoException).code;
    const code =
      typeof causeCode === 'string' && /^video_[a-z_]+$/.test(causeCode) ? causeCode : 'video_consolidation_failed';
    try {
      durableJson(path.join(backupDir, 'failure.json'), {
        version: 1,
        migrationId,
        code,
        originalDesktopPreserved: true,
        canonicalCommitted: committed,
        canonicalPublished: published,
      });
      syncDirectory(backupDir);
    } catch {
      /* Preserve the original failure. */
    }
    throw Object.assign(
      new Error(
        committed && published
          ? 'Video consolidation committed, but reopening storage failed. Restart LoomTV to retry. Verified backups were preserved.'
          : 'The video database could not be consolidated. The legacy desktop data and verified backups were preserved.',
        { cause: error },
      ),
      { code },
    );
  } finally {
    if (schema && schema !== stagingLegacy) schema.close();
    stagingLegacy?.close();
    if (legacy?.inTransaction) legacy.exec('ROLLBACK');
    legacy?.close();
  }
}

/** Keep repository contracts while every core query addresses canonical views. */
function nativeDatabaseFacade(database: BetterSqlite3.Database): BetterSqlite3.Database {
  const facade = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          if (/INSERT\s+INTO\s+device_profile_selection_revisions/i.test(sql) && /revision\s*\+\s*1/i.test(sql)) {
            return target.prepare(`INSERT INTO native_selection_revisions(device_id,revision)
            SELECT input.device_id,COALESCE((SELECT revision FROM profile_selections WHERE device_id=input.device_id AND account_id=(SELECT account_id FROM owner_account WHERE singleton=1)),0)+1
            FROM (SELECT ? device_id) input WHERE 1 ON CONFLICT(device_id) DO UPDATE SET revision=MAX(native_selection_revisions.revision,
              COALESCE((SELECT revision FROM profile_selections WHERE device_id=excluded.device_id AND account_id=(SELECT account_id FROM owner_account WHERE singleton=1)),0))+1
            ${/RETURNING/i.test(sql) ? 'RETURNING revision' : ''}`);
          }
          return target.prepare(nativeVideoSql(sql));
        };
      if (property === 'exec') return (sql: string) => target.exec(nativeVideoSql(sql));
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  rawConnections.set(facade, database);
  return facade;
}

export function videoDatabaseRevision(database: BetterSqlite3.Database): string {
  return (
    (
      database.prepare("SELECT value FROM meta WHERE key='native_catalog_revision'").get() as
        | { value: string }
        | undefined
    )?.value || 'empty'
  );
}

const rawConnections = new WeakMap<BetterSqlite3.Database, BetterSqlite3.Database>();
export function canonicalVideoConnection(database: BetterSqlite3.Database): BetterSqlite3.Database {
  return rawConnections.get(database) || database;
}
