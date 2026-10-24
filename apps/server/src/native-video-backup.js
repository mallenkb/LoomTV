import { createHash } from 'node:crypto';

/** @typedef {string | number | null | {base64: string}} Value */
/** @typedef {{version: 1, ownerProfileId?: string, ownerPasswordPending?: boolean, tables: Record<string, {schema: string; columns: string[]; rows: Array<Record<string, Value>>}>}} NativeVideoBackup */
const quote = (/** @type {string} */ name) => `"${name.replaceAll('"', '""')}"`;
const fail = () =>
  Object.assign(new Error('Restore this video backup through a desktop application with the same storage schema.'), {
    code: 'native_backup_incompatible',
  });

/** Native LAN credentials are transient, like canonical sessions and pairings.
 * Provider secrets remain in their existing OS-encrypted envelope.
 * @param {string} table @param {string} column @param {Value} value @returns {Value} */
function durableValue(table, column, value) {
  if (table !== 'app_settings' || column !== 'data_json') return value;
  if (typeof value !== 'string') throw fail();
  let settings;
  try {
    settings = JSON.parse(value);
  } catch {
    throw fail();
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw fail();
  return JSON.stringify({ ...settings, localNetworkPairedDevices: [], localNetworkSharingEnabled: false });
}

/** @param {import('node:sqlite').DatabaseSync} database */
function schemas(database) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_extension_manifest'").get())
    return [];
  return /** @type {Array<{name: string; sql: string}>} */ (
    database
      .prepare(`SELECT m.name,m.sql FROM sqlite_master m
    JOIN native_extension_manifest n ON n.name=m.name WHERE m.type='table' ORDER BY m.name`)
      .all()
  );
}

/** @param {import('node:sqlite').DatabaseSync} database @returns {NativeVideoBackup | undefined} */
export function exportNativeVideoBackup(database) {
  const definitions = schemas(database);
  if (!definitions.length) return undefined;
  /** @type {NativeVideoBackup} */
  const backup = { version: 1, tables: {} };
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
    const owner = database.prepare("SELECT value FROM meta WHERE key='native_owner_profile'").get()?.value;
    if (typeof owner === 'string') {
      backup.ownerProfileId = owner;
      backup.ownerPasswordPending =
        database.prepare("SELECT value FROM meta WHERE key='native_owner_password_pending'").get()?.value === '1';
    }
  }
  let bytes = 0;
  let rowCount = 0;
  for (const { name, sql } of definitions) {
    const columns = /** @type {Array<{name: string}>} */ (
      database.prepare(`PRAGMA table_info(${quote(name)})`).all()
    ).map((row) => row.name);
    /** @type {Array<Record<string, Value>>} */
    const rows = [];
    for (const stored of database.prepare(`SELECT * FROM ${quote(name)}`).iterate()) {
      /** @type {Record<string, Value>} */
      const row = {};
      for (const key of columns) {
        const value = stored[key];
        if (value instanceof Uint8Array) row[key] = { base64: Buffer.from(value).toString('base64') };
        else if (value === null || typeof value === 'string' || typeof value === 'number')
          row[key] = durableValue(name, key, value);
        else throw fail();
      }
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > 128 * 1024 * 1024 || ++rowCount > 1_000_000)
        throw Object.assign(
          new Error('Use the desktop SQLite backup for this library. Native records exceed the JSON backup limit.'),
          { code: 'native_backup_too_large' },
        );
      rows.push(row);
    }
    backup.tables[name] = { schema: createHash('sha256').update(sql).digest('hex'), columns, rows };
  }
  return backup;
}

/** Backup files cannot supply executable SQL.
 * @param {import('node:sqlite').DatabaseSync} database @param {NativeVideoBackup | undefined} backup */
export function validateNativeVideoBackup(database, backup) {
  const definitions = schemas(database);
  if (!definitions.length && backup === undefined) return;
  if (!backup || backup.version !== 1 || !backup.tables || typeof backup.tables !== 'object') throw fail();
  if (
    backup.ownerProfileId !== undefined &&
    (typeof backup.ownerProfileId !== 'string' || !backup.ownerProfileId || backup.ownerProfileId.length > 128)
  )
    throw fail();
  if (backup.ownerProfileId !== undefined && typeof backup.ownerPasswordPending !== 'boolean') throw fail();
  if (JSON.stringify(Object.keys(backup.tables).sort()) !== JSON.stringify(definitions.map((row) => row.name)))
    throw fail();
  let bytes = 0;
  let count = 0;
  for (const { name, sql } of definitions) {
    const table = backup.tables[name];
    const columns = /** @type {Array<{name: string}>} */ (
      database.prepare(`PRAGMA table_info(${quote(name)})`).all()
    ).map((row) => row.name);
    if (
      !table ||
      table.schema !== createHash('sha256').update(sql).digest('hex') ||
      JSON.stringify(table.columns) !== JSON.stringify(columns) ||
      !Array.isArray(table.rows)
    )
      throw fail();
    for (const row of table.rows) {
      if (!row || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...columns].sort())) throw fail();
      for (const value of Object.values(row)) {
        if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
          continue;
        if (
          value &&
          typeof value === 'object' &&
          Object.keys(value).length === 1 &&
          typeof value.base64 === 'string' &&
          Buffer.from(value.base64, 'base64').toString('base64') === value.base64
        )
          continue;
        throw fail();
      }
      for (const key of columns) durableValue(name, key, row[key]);
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > 128 * 1024 * 1024 || ++count > 1_000_000) throw fail();
    }
  }
}

/** @param {import('node:sqlite').DatabaseSync} database @param {NativeVideoBackup | undefined} backup */
export function clearNativeVideoBackupTables(database, backup) {
  if (backup) for (const name of Object.keys(backup.tables)) database.exec(`DELETE FROM ${quote(name)}`);
}

/** @param {import('node:sqlite').DatabaseSync} database @param {NativeVideoBackup | undefined} backup */
export function restoreNativeVideoBackup(database, backup) {
  if (!backup) return;
  for (const [name, table] of Object.entries(backup.tables)) {
    const insert = database.prepare(
      `INSERT INTO ${quote(name)}(${table.columns.map(quote).join(',')}) VALUES(${table.columns.map(() => '?').join(',')})`,
    );
    for (const row of table.rows)
      insert.run(
        ...table.columns.map((key) => {
          const value = durableValue(name, key, row[key]);
          return value && typeof value === 'object' ? Buffer.from(value.base64, 'base64') : value;
        }),
      );
  }
}
