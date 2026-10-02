import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../mobileDownloads.ts', import.meta.url), 'utf8');
const controllerSource = fs.readFileSync(new URL('../useMobileDownloadsController.ts', import.meta.url), 'utf8');

function downloadHarness({ task, previous = null, runAsync = async () => {} } = {}) {
  const deletedDirectories = [];
  const deletedFiles = [];
  const requests = [];
  const writes = [];
  const db = {
    execAsync: async () => {}, getFirstAsync: async () => previous, getAllAsync: async () => [],
    runAsync: async (sql, ...args) => { writes.push({ sql, args }); await runAsync(sql, args); },
  };
  class Directory {
    exists = true;
    constructor(...parts) { this.uri = parts.join('/'); }
    create() {}
    delete() { deletedDirectories.push(this.uri); this.exists = false; }
  }
  class File {
    exists = true;
    size = 1;
    constructor(path, name) { this.uri = name ? `${path.uri}/${name}` : path; }
    move(destination) { this.uri = destination.uri; }
    delete() { deletedFiles.push(this.uri); }
  }
  const context = vm.createContext({
    AbortController, Directory, File, URL, Paths: { document: 'file:///documents' },
    createDownloadResumable: (url, fileUri, options) => {
      requests.push({ url, fileUri, options });
      return task ?? { downloadAsync: async () => ({ uri: fileUri, status: 200 }), cancelAsync: async () => {} };
    },
    SQLite: { openDatabaseAsync: async () => db },
  });
  vm.runInContext(`${stripTypeScriptTypes(source).replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')}\nglobalThis.api = { saveMobileDownload, clearMobileDownloads, mobileDownloadFileName };`, context);
  return { api: context.api, requests, writes, deletedDirectories, deletedFiles };
}

const input = (signal) => ({
  hostDeviceId: 'host', profileId: 'profile', title: 'Movie', contentUrl: 'https://server/download', signal,
  capability: { id: 'lease', mediaId: 'movie', sizeBytes: 1, credential: { scheme: 'LoomDownload', id: 'id', secret: 'secret' } },
});

test('finished downloads retain the server-provided filename and extension', async () => {
  const harness = downloadHarness({ task: {
    downloadAsync: async () => ({ status: 200, headers: { 'Content-Disposition': 'attachment; filename="The Film (2020).mkv"' } }),
    cancelAsync: async () => {},
  } });
  const saved = await harness.api.saveMobileDownload(input());
  assert.match(saved.uri, /The Film \(2020\)\.mkv$/);
  assert.equal(harness.writes.find(({ sql }) => sql.includes('INSERT INTO')).args[4], saved.uri);
});

test('download filenames keep their extension without leaving the download directory', () => {
  const name = downloadHarness().api.mobileDownloadFileName;
  assert.equal(name({ 'content-disposition': 'attachment; filename="Movie.mp4"' }, 'https://server/x'), 'Movie.mp4');
  assert.equal(name({ 'Content-Disposition': "attachment; filename*=UTF-8''Caf%C3%A9.mkv" }, 'https://server/x'), 'Café.mkv');
  assert.equal(name({ 'Content-Disposition': 'attachment; filename="../../etc/passwd"' }, 'https://server/x'), 'passwd');
  assert.equal(name({}, 'https://server/api/v1/downloads/abc/content'), 'content');
  assert.equal(name({ 'Content-Disposition': 'attachment; filename=".."' }, 'https://server/'), 'media');
});

test('host cleanup cancels native work without waiting for the original transfer to finish', async () => {
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let cancelled = 0;
  const harness = downloadHarness({
    task: {
      downloadAsync: () => { started(); return new Promise(() => {}); },
      cancelAsync: async () => { cancelled += 1; },
    },
  });
  const saving = harness.api.saveMobileDownload(input());
  const rejected = assert.rejects(saving, /cancelled/);
  await entered;
  await Promise.all([rejected, harness.api.clearMobileDownloads('host')]);
  assert.equal(cancelled, 1);
  assert.equal(harness.writes.some(({ sql }) => sql.includes('INSERT INTO')), false);
  assert.equal(harness.deletedDirectories.length, 1);
});

test('profile cancellation aborts active native work and frees the host for another download', async () => {
  const controller = new AbortController();
  let started;
  let cancelled = 0;
  let completed = false;
  const entered = new Promise((resolve) => { started = resolve; });
  const harness = downloadHarness({
    task: {
      downloadAsync: () => {
        if (completed) return Promise.resolve({ status: 200 });
        started(); return new Promise(() => {});
      },
      cancelAsync: async () => { cancelled += 1; completed = true; },
    },
  });
  const saving = harness.api.saveMobileDownload(input(controller.signal));
  const rejected = assert.rejects(saving, /cancelled/);
  await entered;
  controller.abort();
  await rejected;
  const saved = await harness.api.saveMobileDownload({ ...input(), profileId: 'other-profile' });
  assert.equal(cancelled, 1);
  assert.equal(saved.profileId, 'other-profile');
  assert.equal(harness.deletedDirectories.length, 1);
});

test('a cancelled queued download never creates a native task', async () => {
  let started;
  let finish;
  const entered = new Promise((resolve) => { started = resolve; });
  const controller = new AbortController();
  const harness = downloadHarness({
    task: {
      downloadAsync: () => { started(); return new Promise((resolve) => { finish = resolve; }); },
      cancelAsync: async () => {},
    },
  });
  const first = harness.api.saveMobileDownload(input());
  await entered;
  const queued = harness.api.saveMobileDownload({ ...input(controller.signal), profileId: 'other-profile' });
  const rejected = assert.rejects(queued, /cancelled/);
  controller.abort();
  finish({ status: 200 });
  await Promise.all([first, rejected]);
  assert.equal(harness.requests.length, 1);
});

test('cancellation during the database write restores the previous copy', async () => {
  const controller = new AbortController();
  const previous = { title: 'Old title', uri: 'file:///old-copy', size_bytes: 4, created_at: 123 };
  const harness = downloadHarness({
    previous,
    runAsync: async (sql) => { if (sql.includes('INSERT INTO')) controller.abort(); },
  });
  await assert.rejects(harness.api.saveMobileDownload(input(controller.signal)), /cancelled/);
  const restoration = harness.writes.find(({ sql }) => sql.startsWith('UPDATE mobile_downloads'));
  assert.ok(restoration);
  assert.deepEqual(Array.from(restoration.args.slice(0, 4)), ['Old title', 'file:///old-copy', 4, 123]);
  assert.equal(harness.deletedFiles.includes(previous.uri), false);
  assert.equal(harness.deletedDirectories.length, 1);
});

test('HTTP download failures cannot become offline media', async () => {
  const harness = downloadHarness({ task: { downloadAsync: async () => ({ status: 403 }), cancelAsync: async () => {} } });
  await assert.rejects(harness.api.saveMobileDownload(input()), /could not complete/);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.deletedDirectories.length, 1);
});

test('failed metadata restoration retains the file referenced by the database', async () => {
  const controller = new AbortController();
  const harness = downloadHarness({
    previous: { title: 'Old', uri: 'file:///old-copy', size_bytes: 4, created_at: 123 },
    runAsync: async (sql) => {
      if (sql.includes('INSERT INTO')) controller.abort();
      if (sql.startsWith('UPDATE mobile_downloads')) throw new Error('Storage failed');
    },
  });
  await assert.rejects(harness.api.saveMobileDownload(input(controller.signal)), /Storage failed/);
  assert.equal(harness.deletedDirectories.length, 0);
  assert.equal(harness.deletedFiles.length, 0);
});

function operationHarness(revoke) {
  const context = vm.createContext({ AbortController });
  const helper = stripTypeScriptTypes(controllerSource).split('export function createMobileDownloadOperation')[1].split('export function mediaIdForPlayTarget')[0];
  vm.runInContext(`globalThis.createOperation = function createMobileDownloadOperation${helper}`, context);
  return context.createOperation(revoke);
}

test('scope cancellation revokes the capability while native cancellation is pending', async () => {
  const revoked = [];
  const operation = operationHarness(async (id) => { revoked.push(id); });
  operation.setCapability('lease');
  await operation.cancel();
  assert.equal(operation.signal.aborted, true);
  assert.deepEqual(revoked, ['lease']);
  await operation.release();
  assert.deepEqual(revoked, ['lease'], 'finally must not revoke twice');
});

test('a capability created after scope cancellation is revoked immediately', async () => {
  const revoked = [];
  const operation = operationHarness(async (id) => { revoked.push(id); });
  await operation.cancel();
  operation.setCapability('late-lease');
  await operation.release();
  assert.deepEqual(revoked, ['late-lease']);
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
