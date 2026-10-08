import test from 'node:test';
import { serializeMobileDatabaseMutation } from '../mobileDatabaseMutations.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const source = fs.readFileSync(new URL('../mobileDownloads.ts', import.meta.url), 'utf8');
const controllerSource = fs.readFileSync(new URL('../useMobileDownloadsController.ts', import.meta.url), 'utf8');

function downloadHarness({ task, previous = null, runAsync = async () => {}, getAllAsync = async () => [], directories = {} } = {}) {
  const deletedDirectories = [];
  const deletedFiles = [];
  const requests = [];
  const writes = [];
  const db = {
    execAsync: async () => {}, getFirstAsync: async () => previous, getAllAsync,
    runAsync: async (sql, ...args) => { writes.push({ sql, args }); await runAsync(sql, args); },
  };
  class Directory {
    exists = true;
    constructor(...parts) { this.uri = parts.join('/'); }
    create() {}
    list() { return (directories[this.uri] || []).map((uri) => new Directory(uri)); }
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
    serializeMobileDatabaseMutation,
    SQLite: { openDatabaseAsync: async () => db },
  });
  vm.runInContext(`${stripTypeScriptTypes(source).replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')}\nglobalThis.api = { saveMobileDownload, clearMobileDownloads, mobileDownloadFileName, reconcileMobileDownloadDirectories: typeof reconcileMobileDownloadDirectories === 'function' ? reconcileMobileDownloadDirectories : undefined, listMobileDownloads };`, context);
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

test('restart reconciliation removes interrupted attempts and replaced copies but retains committed media', async () => {
  const root = 'file:///documents/loomtv-downloads';
  const media = `${root}/host/profile/movie`;
  const committed = `${media}/attempt-committed`;
  const interrupted = `${media}/attempt-interrupted`;
  const replaced = `${media}/attempt-replaced`;
  const directories = {
    [root]: [`${root}/host`], [`${root}/host`]: [`${root}/host/profile`],
    [`${root}/host/profile`]: [media], [media]: [committed, interrupted, replaced],
  };
  const harness = downloadHarness({ directories, getAllAsync: async () => [{ uri: `${committed}/movie.mp4` }] });
  await harness.api.listMobileDownloads('host', 'profile');
  assert.deepEqual(harness.deletedDirectories.sort(), [interrupted, replaced].sort());
});

test('directory reconciliation preserves an active transfer before publication', async () => {
  let finish;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const root = 'file:///documents/loomtv-downloads';
  const media = `${root}/host/profile/movie`;
  const directories = { [root]: [`${root}/host`], [`${root}/host`]: [`${root}/host/profile`], [`${root}/host/profile`]: [media] };
  const harness = downloadHarness({ directories, task: {
    downloadAsync: () => { entered(); return new Promise((resolve) => { finish = resolve; }); }, cancelAsync: async () => {},
  } });
  const saving = harness.api.saveMobileDownload(input());
  await started;
  const attempt = harness.requests[0].fileUri.replace(/\/media$/, '');
  directories[media] = [attempt];
  await harness.api.reconcileMobileDownloadDirectories();
  assert.deepEqual(harness.deletedDirectories, []);
  finish({ status: 200 });
  await saving;
});

test('snapshot rollback cannot roll back a successful download publication or remove its retained file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-sqlite-regression-'));
  const handles = [];
  let cached;
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const deleted = new Set();
  const SQLite = { openDatabaseAsync: async (_name, options) => {
    if (!options?.useNewConnection && cached) return cached;
    const native = new DatabaseSync(path.join(directory, 'cache.db'));
    handles.push(native);
    const db = {
      execAsync: async (sql) => { native.exec(sql); },
      getFirstAsync: async (sql, ...args) => native.prepare(sql).get(...args),
      getAllAsync: async (sql, ...args) => native.prepare(sql).all(...args),
      runAsync: async (sql, ...args) => {
        const result = native.prepare(sql).run(...args);
        if (sql.includes('INSERT INTO mobile_offline_snapshots')) { entered(); await held; throw new Error('snapshot rollback'); }
        return result;
      },
      withTransactionAsync: async (fn) => {
        native.exec('BEGIN');
        try { await fn(); native.exec('COMMIT'); } catch (error) { native.exec('ROLLBACK'); throw error; }
      },
    };
    cached ??= db;
    return db;
  } };
  class Directory {
    exists = true;
    constructor(...parts) { this.uri = parts.join('/'); }
    create() {}
    delete() { this.exists = false; }
    list() { return []; }
  }
  class File {
    size = 1;
    constructor(dir, name) { this.uri = name ? `${dir.uri}/${name}` : dir; }
    get exists() { return !deleted.has(this.uri); }
    move(next) { this.uri = next.uri; }
    delete() { deleted.add(this.uri); }
  }
  const downloadContext = vm.createContext({ serializeMobileDatabaseMutation, SQLite, File, Directory, URL, AbortController, Paths: { document: 'file:///mock-downloads' },
    createDownloadResumable: () => ({ downloadAsync: async () => ({ status: 200 }), cancelAsync: async () => {} }),
  });
  const cacheContext = vm.createContext({ serializeMobileDatabaseMutation, SQLite, reportNonFatal: () => {}, activeMobileProgressPaths: () => new Set(), sameMobileCatalogIdentity: () => false });
  const execute = (text, context, api) => vm.runInContext(`${stripTypeScriptTypes(text).replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '')};globalThis.api = { ${api} };`, context);
  execute(source, downloadContext, 'saveMobileDownload');
  execute(fs.readFileSync(new URL('../mobileOfflineCache.ts', import.meta.url), 'utf8'), cacheContext, 'saveMobileOfflineSnapshot');
  try {
    await downloadContext.api.saveMobileDownload(input());
    const snapshotSave = cacheContext.api.saveMobileOfflineSnapshot({ hostDeviceId: 'host', activeProfile: null, profiles: [], automaticProfileSignIn: true, library: {}, libraryEtag: '', profileLists: [], progress: {} });
    const failedSnapshot = assert.rejects(snapshotSave, /snapshot rollback/);
    await started;
    const replacing = downloadContext.api.saveMobileDownload(input()).catch(() => null);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await failedSnapshot;
    const replacement = await replacing;
    const owner = handles[0].prepare('SELECT uri FROM mobile_downloads').get();
    assert.equal(deleted.has(owner.uri), false, 'the committed metadata must still reference a retained file');
    if (!replacement) await downloadContext.api.saveMobileDownload(input());
    const finalOwner = handles[0].prepare('SELECT uri FROM mobile_downloads').get();
    assert.equal(deleted.has(finalOwner.uri), false);
  } finally {
    for (const handle of handles) handle.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('download reconciliation starts even before a profile is unlocked', () => {
  let invoked = 0;
  const beginning = controllerSource.indexOf('  useEffect(() => {');
  const ending = controllerSource.indexOf('  useLayoutEffect(() => {', beginning);
  const context = vm.createContext({
    useEffect: (effect) => effect(),
    reconcileMobileDownloadDirectories: async () => { invoked += 1; },
    reportNonFatal: () => {},
  });
  vm.runInContext(controllerSource.slice(beginning, ending), context);
  assert.equal(invoked, 1);
});
