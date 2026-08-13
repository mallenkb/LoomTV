import * as SQLite from 'expo-sqlite';

import {
  MOBILE_DIAGNOSTIC_MAX_BYTES,
  createMobileDiagnosticEvent,
  mobileDiagnosticIdsToDelete,
  mobileDiagnosticEventBytes,
  type MobileDiagnosticEvent,
} from './mobileDiagnosticPolicy';

const DATABASE_NAME = 'loomtv-mobile-diagnostics.db';
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

type DiagnosticRow = { id: string; createdAt: number; payload: string };

async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync(DATABASE_NAME).then(async (database) => {
      await database.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS mobile_diagnostics (
          id TEXT PRIMARY KEY NOT NULL,
          created_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mobile_diagnostics_created_at
          ON mobile_diagnostics(created_at);
      `);
      return database;
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function pruneDiagnostics(database: SQLite.SQLiteDatabase, now: number): Promise<void> {
  const rows = await database.getAllAsync<DiagnosticRow>(
    'SELECT id, created_at AS createdAt, payload FROM mobile_diagnostics ORDER BY created_at DESC',
  );
  const deleteIds = mobileDiagnosticIdsToDelete(
    rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      bytes: new TextEncoder().encode(row.payload).length,
    })),
    now,
  );
  for (const id of deleteIds) await database.runAsync('DELETE FROM mobile_diagnostics WHERE id = ?', id);
}

export async function recordMobileDiagnostic(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>,
): Promise<void> {
  const event = createMobileDiagnosticEvent(scope, error, context);
  if (mobileDiagnosticEventBytes(event) > MOBILE_DIAGNOSTIC_MAX_BYTES) return;
  const database = await openDatabase();
  await database.runAsync(
    'INSERT OR REPLACE INTO mobile_diagnostics (id, created_at, payload) VALUES (?, ?, ?)',
    event.id,
    event.createdAt,
    JSON.stringify(event),
  );
  await pruneDiagnostics(database, event.createdAt);
}

export function reportNonFatal(scope: string, error: unknown, context?: Record<string, unknown>): void {
  writeQueue = writeQueue
    .catch(() => {})
    .then(() => recordMobileDiagnostic(scope, error, context))
    .catch(() => {});
}

export async function listMobileDiagnostics(): Promise<MobileDiagnosticEvent[]> {
  await writeQueue.catch(() => {});
  const database = await openDatabase();
  await pruneDiagnostics(database, Date.now());
  const rows = await database.getAllAsync<DiagnosticRow>(
    'SELECT id, created_at AS createdAt, payload FROM mobile_diagnostics ORDER BY created_at DESC',
  );
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.payload) as MobileDiagnosticEvent];
    } catch {
      return [];
    }
  });
}

export async function exportMobileDiagnostics(): Promise<string> {
  return JSON.stringify({ exportedAt: Date.now(), events: await listMobileDiagnostics() }, null, 2);
}

export async function clearMobileDiagnostics(): Promise<void> {
  await writeQueue.catch(() => {});
  const database = await openDatabase();
  await database.runAsync('DELETE FROM mobile_diagnostics');
}

export type { MobileDiagnosticEvent } from './mobileDiagnosticPolicy';
