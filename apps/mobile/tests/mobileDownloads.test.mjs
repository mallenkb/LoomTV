import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../mobileDownloads.ts', import.meta.url), 'utf8');

test('host cleanup waits for an uncancellable transfer and prevents its commit', async () => {
  let finish;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const transfer = new Promise((resolve) => { finish = resolve; });
  let committed = false;
  let deleted = false;
  const db = {
    execAsync: async () => {}, getFirstAsync: async () => null, getAllAsync: async () => [],
    runAsync: async (sql) => { if (sql.includes('INSERT INTO')) committed = true; },
  };
  class Directory {
    exists = true;
    create() {}
    delete() { deleted = true; }
  }
  const context = vm.createContext({
    Directory, Paths: { document: 'file:///documents' },
    File: { downloadFileAsync: () => { started(); return transfer; } },
    SQLite: { openDatabaseAsync: async () => db },
  });
  vm.runInContext(`${stripTypeScriptTypes(source).replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')}\nglobalThis.api = { saveMobileDownload, clearMobileDownloads };`, context);
  const saving = context.api.saveMobileDownload({
    hostDeviceId: 'host', profileId: 'profile', title: 'Movie', contentUrl: 'https://server/download',
    capability: { mediaId: 'movie', sizeBytes: 1, credential: { scheme: 'LoomDownload', id: 'id', secret: 'secret' } },
  });
  const rejected = assert.rejects(saving, /cancelled/);
  await entered;
  let cleared = false;
  const cleanup = context.api.clearMobileDownloads('host').then(() => { cleared = true; });
  await Promise.resolve();
  assert.equal(cleared, false);
  finish({ uri: 'file:///documents/movie', size: 1 });
  await Promise.all([rejected, cleanup]);
  assert.equal(committed, false);
  assert.equal(deleted, true);
});

test('mobile download capabilities stay in Authorization headers', () => {
  assert.match(source, /`LoomDownload \$\{capability\.credential\.id\}\.\$\{capability\.credential\.secret\}`/);
  assert.doesNotMatch(source, /searchParams\.set\([^\n]*secret/);
});

test('mobile downloads use document storage and remove missing database rows', () => {
  assert.match(source, /Paths\.document/);
  assert.match(source, /if \(file\.exists\) available\.push/);
  assert.match(source, /DELETE FROM mobile_downloads/);
});

test('mobile download paths discard traversal and separator characters', () => {
  assert.match(source, /replace\(\/\[\^a-zA-Z0-9\._-\]\/g, '_'/);
});
