import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';

import { migrateDatabase } from '../src/main/databaseMigrations.ts';

function tablesClearedByReset(): Set<string> {
  const source = readFileSync(new URL('../src/main/database.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export function clearDatabase'));
  const statement = body.slice(0, body.indexOf('`))();'));
  return new Set([...statement.matchAll(/DELETE FROM (\w+)/g)].map((match) => match[1]));
}

test('clearing app data removes Live TV sources, channels, guide, favorites and recents', () => {
  const database = new BetterSqlite3(':memory:');
  migrateDatabase(database);
  const tables = new Set((database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'iptv_%'")
    .all() as Array<{ name: string }>).map((row) => row.name));
  database.close();

  const cleared = tablesClearedByReset();
  assert.ok(tables.size >= 6);
  for (const table of tables) assert.ok(cleared.has(table), `${table} must be cleared`);
});
