import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { CANONICAL_STATE_FILENAME, CANONICAL_SCHEMA_VERSION, CANONICAL_MIGRATION_FORMAT } from 'loom-media-server-headless/native-persistence';
import { canonicalVideoConnection, digest, openConsolidatedVideoDatabase, syncDirectory, syncFile } from './consolidatedVideoDatabase.ts';

type MigrationBackup = { id: string; created_at: number; manifest_sha256: string; previous_canonical: number };
export type RecoverySource = { backup: MigrationBackup } | { filename: string };
const artifactNames = new Map([
  ['desktop-sqlite', 'loomtv.sqlite'],
  ['canonical-pre-consolidation', CANONICAL_STATE_FILENAME],
  ['desktop-library-json', 'library.json'],
]);

function isDamaged(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'SQLITE_NOTADB' || Boolean(code?.startsWith('SQLITE_CORRUPT'));
}

export function migrationBackupForRecovery(dataDir: string): MigrationBackup | undefined {
  const database = new BetterSqlite3(path.join(dataDir, CANONICAL_STATE_FILENAME), { readonly: true });
  try {
    const row = database.prepare(`SELECT id,created_at,manifest_sha256,previous_canonical FROM native_storage_migrations
      WHERE id=(SELECT value FROM meta WHERE key='native_video_backup_id')`).get() as MigrationBackup | undefined;
    if (!row || !/^[a-f0-9-]{36}$/i.test(row.id) || !Number.isSafeInteger(row.created_at)) return;
    const { artifacts } = readManifest(dataDir, row);
    return artifacts.length ? row : undefined;
  } finally {
    database.close();
  }
}

function readManifest(dataDir: string, backup: MigrationBackup) {
  const directory = path.join(dataDir, 'video-consolidation-backups', backup.id);
  const file = path.join(directory, 'manifest.json');
  if (digest(file).sha256 !== backup.manifest_sha256) throw new Error('The migration backup manifest has changed.');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.format !== 'loomtv-native-video-backup-v1' || manifest.migrationId !== backup.id || !Array.isArray(manifest.artifacts)) {
    throw new Error('The migration backup manifest is invalid.');
  }
  const artifacts = manifest.artifacts as Array<{ kind: string; fileName: string; sha256: string; sizeBytes: number }>;
  if (artifacts.some(a => !artifactNames.has(a.kind) || artifactNames.get(a.kind) !== a.fileName)
    || new Set(artifacts.map(a => a.kind)).size !== artifacts.length
    || artifacts.some(a => a.kind === 'canonical-pre-consolidation') !== Boolean(backup.previous_canonical)) {
    throw new Error('The migration backup inventory is invalid.');
  }
  return { directory, artifacts };
}

async function stageBackup(dataDir: string, stage: string, source: RecoverySource) {
  if ('filename' in source) {
    const backup = new BetterSqlite3(source.filename, { readonly: true });
    try {
      if (backup.prepare("SELECT value FROM meta WHERE key='native_video_storage_version'").pluck().get() !== '1') {
        throw new Error('Choose a consolidated database saved with Back Up LoomTV Database.');
      }
      const copied = await backup.backup(path.join(stage, CANONICAL_STATE_FILENAME));
      if (!copied.totalPages || copied.remainingPages) throw new Error('SQLite could not read the selected backup.');
    } finally {
      backup.close();
    }
  } else {
    const { directory, artifacts } = readManifest(dataDir, source.backup);
    if (!artifacts.length) throw new Error('This migration has no saved library to restore.');
    for (const artifact of artifacts) {
      const target = path.join(stage, artifact.fileName);
      fs.copyFileSync(path.join(directory, artifact.fileName), target, fs.constants.COPYFILE_EXCL);
      const copy = digest(target);
      if (copy.sha256 !== artifact.sha256 || copy.sizeBytes !== artifact.sizeBytes) {
        throw new Error(`The migration backup of ${artifact.fileName} failed verification.`);
      }
      fs.chmodSync(target, 0o600);
    }
  }
  // Run the normal consolidation on private copies. Its permanent evidence belongs to the live library.
  return canonicalVideoConnection(openConsolidatedVideoDatabase(stage, dataDir));
}

function requireDamagedLibrary(database: BetterSqlite3.Database): void {
  try {
    if (database.pragma('quick_check', { simple: true }) !== 'ok') return;
  } catch (error) {
    if (isDamaged(error)) return;
    throw error;
  }
  throw new Error('The current database now passes its integrity check. Restart LoomTV to open it.');
}

function revokeRestoredAccess(database: BetterSqlite3.Database): void {
  // Preserve accounts and passwords, but require devices to pair and sign in again.
  const exists = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
  database.transaction(() => {
    for (const table of ['offline_download_leases', 'invitation_sessions', 'invitations', 'pairing_requests', 'account_sessions', 'device_credentials']) {
      if (exists.get(table)) database.exec(`DELETE FROM ${table}`);
    }
  })();
}

export async function restoreVideoDatabase(dataDir: string, source: RecoverySource): Promise<string> {
  const livePath = path.join(dataDir, CANONICAL_STATE_FILENAME);
  const recovery = fs.mkdtempSync(path.join(dataDir, 'video-recovery-'));
  const stage = path.join(recovery, 'stage');
  fs.mkdirSync(stage, { mode: 0o700 });
  const saved = path.join(recovery, 'damaged-library.sqlite');
  let live: BetterSqlite3.Database | undefined;
  let candidate: BetterSqlite3.Database | undefined;
  try {
    live = new BetterSqlite3(livePath, { readonly: true });
    const observed = live;
    const version = observed.pragma('data_version', { simple: true });
    const assertUnchanged = () => {
      if (observed.pragma('data_version', { simple: true }) !== version) {
        throw new Error('Another process changed the library. Close its other writers and retry.');
      }
    };
    requireDamagedLibrary(live);
    candidate = await stageBackup(dataDir, stage, source);
    if (!candidate.prepare("SELECT 1 FROM migration_markers WHERE state='committed' AND format=? AND schema_version=?")
      .get(CANONICAL_MIGRATION_FORMAT, CANONICAL_SCHEMA_VERSION)) throw new Error('Unsupported LoomTV backup version.');
    revokeRestoredAccess(candidate);
    if (candidate.pragma('integrity_check', { simple: true }) !== 'ok' || (candidate.pragma('foreign_key_check') as unknown[]).length) {
      throw new Error('The recovered library failed integrity verification.');
    }
    assertUnchanged();
    // SQLite copies committed pages, including the WAL, without traversing the damaged tables.
    const archived = await live.backup(saved);
    if (!archived.totalPages || fs.statSync(saved).size !== archived.totalPages * Number(live.pragma('page_size', { simple: true }))) {
      throw new Error('LoomTV could not save the damaged database.');
    }
    fs.chmodSync(saved, 0o400);
    syncFile(saved);
    syncDirectory(recovery);
    syncDirectory(dataDir);
    assertUnchanged();
    // The first zero-page backup step obtains SQLite's destination write lock before the callback.
    // A writer that committed while the user chose a backup must not be overwritten.
    const restored = await candidate.backup(livePath, { progress: () => { assertUnchanged(); return 256; } });
    if (!restored.totalPages || restored.remainingPages || observed.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new Error('SQLite could not finish restoring the database. Close any other writers and retry.');
    }
    return saved;
  } finally {
    candidate?.close();
    live?.close();
    fs.rmSync(stage, { recursive: true, force: true });
    if (!fs.existsSync(saved)) fs.rmdirSync(recovery);
  }
}
