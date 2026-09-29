import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../mobileDownloads.ts', import.meta.url), 'utf8');

// Minimal stand-in for expo-file-system's File: a path, a size, and move().
class FakeFile {
  constructor(...parts) { this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri || 'file:///documents/attempt')).join('/'); }
  get size() { return 1; }
  get exists() { return true; }
  move(destination) { this.uri = destination.uri; }
  delete() {}
}

function loadDownloads(overrides) {
  const context = vm.createContext({ Paths: { document: 'file:///documents' }, File: FakeFile, URL, ...overrides });
  vm.runInContext(`${stripTypeScriptTypes(source).replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')}\nglobalThis.api = { saveMobileDownload, clearMobileDownloads, mobileDownloadFileName };`, context);
  return context.api;
}

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
    File: FakeFile,
    createDownloadResumable: () => ({ downloadAsync: () => { started(); return transfer; }, cancelAsync: async () => {} }),
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
  finish({ uri: 'file:///documents/download.part', status: 200, headers: {} });
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

test('aborting a download stops the transfer without waiting for it to finish', async () => {
  let cancelled = false;
  let deleted = false;
  let committed = false;
  let resolveTransfer;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  class Directory { exists = true; create() {} delete() { deleted = true; } }
  const api = loadDownloads({
    Directory,
    createDownloadResumable: () => ({
      downloadAsync: () => { started(); return new Promise((resolve) => { resolveTransfer = resolve; }); },
      // Like expo-file-system, cancelling resolves the pending download with undefined.
      cancelAsync: async () => { cancelled = true; resolveTransfer(undefined); },
    }),
    SQLite: { openDatabaseAsync: async () => ({
      execAsync: async () => {}, getFirstAsync: async () => null, getAllAsync: async () => [],
      runAsync: async (sql) => { if (sql.includes('INSERT INTO')) committed = true; },
    }) },
  });
  const controller = new AbortController();
  const saving = api.saveMobileDownload({
    hostDeviceId: 'host', profileId: 'profile', title: 'Movie', contentUrl: 'https://server/download', signal: controller.signal,
    capability: { mediaId: 'movie', sizeBytes: 1, credential: { scheme: 'LoomDownload', id: 'id', secret: 'secret' } },
  });
  await entered;
  controller.abort();
  await assert.rejects(saving, /cancelled/);
  assert.equal(cancelled, true, 'the network transfer must be cancelled');
  assert.equal(deleted, true, 'the partial download must be removed');
  assert.equal(committed, false);
});

test('a finished download takes the file name the server sent', async () => {
  let savedUri = '';
  class Directory { exists = true; uri = 'file:///documents/attempt'; create() {} delete() {} }
  const api = loadDownloads({
    Directory,
    createDownloadResumable: (_url, fileUri) => ({
      downloadAsync: async () => ({ uri: fileUri, status: 200, headers: { 'Content-Disposition': 'attachment; filename="The Film (2020).mkv"' } }),
      cancelAsync: async () => {},
    }),
    SQLite: { openDatabaseAsync: async () => ({
      execAsync: async () => {}, getFirstAsync: async () => null, getAllAsync: async () => [],
      runAsync: async (sql, ...values) => { if (sql.includes('INSERT INTO')) savedUri = values[4]; },
    }) },
  });
  const saved = await api.saveMobileDownload({
    hostDeviceId: 'host', profileId: 'profile', title: 'Movie', contentUrl: 'https://server/download',
    capability: { mediaId: 'movie', sizeBytes: 1, credential: { scheme: 'LoomDownload', id: 'id', secret: 'secret' } },
  });
  assert.match(saved.uri, /The Film \(2020\)\.mkv$/);
  assert.equal(savedUri, saved.uri);
});

test('download file names keep their extension and cannot leave the directory', () => {
  const { mobileDownloadFileName: name } = loadDownloads({ Directory: class {}, createDownloadResumable: () => ({}), SQLite: {} });
  assert.equal(name({ 'content-disposition': 'attachment; filename="Movie.mp4"' }, 'https://server/x'), 'Movie.mp4');
  assert.equal(name({ 'Content-Disposition': "attachment; filename*=UTF-8''Caf%C3%A9.mkv" }, 'https://server/x'), 'Café.mkv');
  assert.equal(name({ 'Content-Disposition': 'attachment; filename="../../etc/passwd"' }, 'https://server/x'), 'passwd');
  assert.equal(name({}, 'https://server/api/v1/downloads/abc/content'), 'content');
  assert.equal(name({ 'Content-Disposition': 'attachment; filename=".."' }, 'https://server/'), 'media');
});
