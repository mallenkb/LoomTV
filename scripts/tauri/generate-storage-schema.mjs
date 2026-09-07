import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { migrateDatabase } from '../../apps/desktop/src/main/databaseMigrations.ts';

// Generate DDL using an ephemeral database. No production store or native Node addon is opened.
const db = new DatabaseSync(':memory:');
const adapter = {
  exec: sql => db.exec(sql),
  prepare: sql => db.prepare(sql),
  pragma(sql, options) {
    const rows = db.prepare(`PRAGMA ${sql}`).all();
    return options?.simple ? Object.values(rows[0] || {})[0] : rows;
  },
  transaction: fn => (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },
};
try {
  migrateDatabase(adapter);
  const definitions = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name").all();
  const output = '-- Generated from Electron databaseMigrations.ts at e5907d2b for fresh stores.\n' + definitions.map(row => `${row.sql};`).join('\n\n') + '\n';
  await writeFile(new URL('../../crates/loomtv-core/src/desktop-schema.sql', import.meta.url), output);
  console.log(`Generated ${definitions.length} fresh-store schema definitions.`);
} finally {
  db.close();
}
