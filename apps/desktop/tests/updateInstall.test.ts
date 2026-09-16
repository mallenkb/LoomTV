import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { UpdateState } from '../src/main/autoUpdater.ts';
import type { ZodType } from 'zod';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import vm from 'node:vm';
import * as ts from 'typescript';
import {
  closeServerForUpdateInstall,
  trackServerConnections,
} from '../src/main/updateInstall.ts';

const require = createRequire(import.meta.url);
const updaterSource = fs.readFileSync(new URL('../src/main/autoUpdater.ts', import.meta.url), 'utf8');
const compiledUpdater = ts.transpileModule(updaterSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function updaterFixture({
  installed = 'Identifier=com.mallenkb.loommediaserver\nTeamIdentifier=ABCDE12345',
  downloaded = installed,
  rejectRequirement = false,
  rejectSignature = false,
  rejectDownloadedSignature = false,
  rejectChecksum = false,
  rejectExtraction = false,
  rejectPermission = false,
  rejectHelperWrite = false,
  rejectHelperCleanup = false,
} = {}) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const cleanups: string[] = [];
  const opened: string[] = [];
  const effects: string[] = [];
  const states: UpdateState[] = [];
  const errors: unknown[][] = [];
  const timers: Array<() => void> = [];
  const archivePath = '/pending/LoomTV.zip';
  const helperDir = '/tmp/loomtv-update-install-fixture';
  const archive = Buffer.from('downloaded update archive fixture');
  const sha512 = createHash('sha512').update(archive).digest('base64');
  let menuTemplate: Array<{ label?: string; submenu?: Array<{ label?: string; click?: () => void }> }> = [];
  const execute = async (file: string, args: string[]) => {
    assert.deepEqual(cleanups, []);
    calls.push({ file, args });
    if ((rejectSignature || rejectDownloadedSignature && args.at(-1) !== '/installed.app') && args.includes('--verify')) {
      throw new Error(`code signature failed: ${args.at(-1)}`);
    }
    if (args.includes('-R')) assert.ok(args[args.indexOf('-R') + 1].startsWith('=anchor apple generic'));
    if (rejectRequirement && args.includes('-R')) throw new Error(`signature requirement failed: ${args.at(-1)}`);
    if (file === '/usr/bin/ditto') {
      assert.deepEqual(Array.from(args), ['-x', '-k', archivePath, `${helperDir}/extracted`]);
      if (rejectExtraction) throw new Error(`Cannot extract ${helperDir}`);
    }
    return { stdout: '', stderr: args.includes('--display') ? args.at(-1) === '/installed.app' ? installed : downloaded : '' };
  };
  const execFile = Object.assign(() => undefined, { [promisify.custom]: execute });
  const app = Object.assign(new EventEmitter(), {
    name: 'LoomTV',
    isPackaged: true,
    getVersion: () => '1.0.171',
    getPath: () => '/installed.app/Contents/MacOS/LoomTV',
    quit: () => { effects.push('quit'); },
    exit: () => { effects.push('exit'); },
  });
  const autoUpdater = Object.assign(new EventEmitter(), {
    autoInstallOnAppQuit: true,
    setFeedURL: () => undefined,
    checkForUpdates: async () => undefined,
    quitAndInstall: () => { effects.push('squirrel'); },
  });
  const module = { exports: {} };
  const dependencies: Record<string, unknown> = {
    electron: {
      app,
      autoUpdater: new EventEmitter(),
      BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_channel: string, state: UpdateState) => { states.push(state); } } }] },
      Menu: { buildFromTemplate: (template: typeof menuTemplate) => { menuTemplate = template; return { getMenuItemById: () => undefined }; }, setApplicationMenu: () => undefined },
      shell: { openExternal: async (url: string) => { opened.push(url); } },
    },
    'electron-updater': { autoUpdater },
    'node:child_process': {
      execFile,
      spawn: () => {
        effects.push('spawn');
        const child = Object.assign(new EventEmitter(), { unref: () => undefined });
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    },
    'node:fs': {
      constants: fs.constants,
      existsSync: (file: string) => file === '/resources/app-update.yml',
      createReadStream: (file: string) => {
        assert.equal(file, archivePath);
        return Readable.from([archive]);
      },
      promises: {
        readFile: async (file: string) => {
          assert.equal(file, '/pending/update-info.json');
          return JSON.stringify({ sha512: rejectChecksum ? 'wrong-checksum' : sha512, fileName: 'LoomTV.zip' });
        },
        mkdtemp: async () => helperDir,
        mkdir: async () => undefined,
        readdir: async () => [{ name: 'LoomTV.app', isDirectory: () => true }],
        access: async (file: string, mode: number) => {
          if (rejectPermission && mode === fs.constants.W_OK) throw new Error(`EACCES: ${file}`);
        },
        writeFile: async () => {
          assert.deepEqual(cleanups, []);
          if (rejectHelperWrite) throw new Error(`EACCES: cannot write ${helperDir}/install-update.sh`);
          effects.push('write-helper');
        },
        rm: async (file: string) => {
          assert.equal(file, helperDir);
          effects.push('remove-helper');
          if (rejectHelperCleanup) throw new Error('ENOTEMPTY');
        },
      },
    },
    'node:path': path.posix,
    './transcodeManager': { stopAllTranscodes: () => { cleanups.push('transcodes'); } },
    './lanDiscovery': { destroyLanDiscovery: () => { cleanups.push('discovery'); } },
    './updateAdapter': {
      createUpdateAdapter: ({ configure }: { configure: () => void }) => ({
        start: configure,
        stop: () => { cleanups.push('update timer'); },
      }),
    },
    './safeFetch': {},
    './runtimeValidation.ts': { parseRequiredJson: (raw: string, schema: ZodType) => schema.parse(JSON.parse(raw)) },
    './openSettings': {},
    './ffmpegGovernor': {},
  };
  vm.runInNewContext(compiledUpdater, {
    require: (id: string) => id in dependencies ? dependencies[id] : require(id),
    module,
    exports: module.exports,
    Error,
    process: { platform: 'darwin', arch: 'arm64', pid: 1234, resourcesPath: '/resources', env: {} },
    console: { error: (...args: unknown[]) => { errors.push(args); }, warn: () => undefined },
    setTimeout: (callback: () => void) => { timers.push(callback); return { unref: () => undefined }; },
    clearTimeout: () => undefined,
  });
  const api = module.exports as {
    initAutoUpdater: (deps: { getMainWindow: () => null; stopNativePlayback: () => void; closeMediaServer: () => Promise<void> }) => void;
    startUpdateAdapter: () => void;
    installDownloadedUpdate: () => Promise<UpdateState>;
    getUpdateState: () => UpdateState;
    isUpdateInstalling: () => boolean;
    buildUpdateMenu: () => void;
  };
  api.initAutoUpdater({
    getMainWindow: () => null,
    stopNativePlayback: () => { cleanups.push('native playback'); },
    closeMediaServer: async () => { cleanups.push('media server'); },
  });
  api.startUpdateAdapter();
  const download = (file: string | undefined = archivePath) => {
    autoUpdater.emit('update-downloaded', { downloadedFile: file });
    assert.equal(api.getUpdateState().status, 'downloaded');
    assert.equal(api.getUpdateState().platform, 'darwin');
  };
  return { api, calls, opened, cleanups, effects, states, errors, timers, download, autoUpdater, menu: () => menuTemplate };
}

const adHocIdentity = 'Identifier=com.mallenkb.loommediaserver\nTeamIdentifier=not set\nSignature=adhoc';

async function assertPreflightFailure(fixture: ReturnType<typeof updaterFixture>, message: RegExp) {
  const state = await fixture.api.installDownloadedUpdate();
  assert.equal(state.status, 'error');
  assert.match(state.message ?? '', message);
  assert.equal(state.releaseUrl, 'https://github.com/mallenkb/LoomTV/releases/latest');
  assert.equal(fixture.api.isUpdateInstalling(), false);
  assert.deepEqual(fixture.states.map(({ status }) => status), ['downloaded', 'installing', 'error']);
  assert.deepEqual(fixture.cleanups, []);
  assert.ok(!fixture.effects.some((effect) => ['spawn', 'quit', 'exit', 'squirrel'].includes(effect)));
  assert.deepEqual(fixture.timers, []);
  assert.equal(fixture.errors.length, 1);
  assert.equal(await fixture.api.installDownloadedUpdate(), state);
}

test('legacy ad-hoc install preflight requires a manual Developer ID upgrade without draining cleanup', async () => {
  for (const downloaded of [adHocIdentity, 'Identifier=com.mallenkb.loommediaserver\nTeamIdentifier=OTHER12345']) {
    const fixture = updaterFixture({ installed: adHocIdentity, downloaded });
    fixture.download();
    await assertPreflightFailure(fixture, /Developer ID.*manually/);
    assert.ok(fixture.calls.some(({ args }) => args.includes('--display')));
    assert.ok(!fixture.calls.some(({ file }) => file === '/usr/bin/ditto'));
  }
});

test('verified Developer ID install drains cleanup only after preflight and never uses Squirrel', async () => {
  const fixture = updaterFixture();
  fixture.download();
  assert.equal(fixture.autoUpdater.autoInstallOnAppQuit, false);
  const state = await fixture.api.installDownloadedUpdate();
  assert.equal(state.status, 'installing');
  assert.equal(fixture.api.isUpdateInstalling(), true);
  assert.ok(fixture.calls.some(({ file, args }) => file === '/usr/bin/codesign'
    && args.includes('-R') && args.some((arg) => arg.includes('anchor apple generic'))
    && args.some((arg) => arg.includes('1.2.840.113635.100.6.2.6'))
    && args.some((arg) => arg.includes('1.2.840.113635.100.6.1.13'))
    && args.some((arg) => arg.includes('subject.OU] = "ABCDE12345"'))
    && args.some((arg) => arg.includes('identifier "com.mallenkb.loommediaserver"'))));
  assert.deepEqual(fixture.cleanups, ['transcodes', 'native playback', 'discovery', 'media server', 'update timer']);
  assert.deepEqual(fixture.effects, ['write-helper', 'spawn', 'quit']);
  assert.equal(await fixture.api.installDownloadedUpdate(), state);
  assert.deepEqual(fixture.effects, ['write-helper', 'spawn', 'quit']);
  assert.equal(fixture.timers.length, 1);
  fixture.timers[0]();
  assert.deepEqual(fixture.effects, ['write-helper', 'spawn', 'quit', 'exit']);
});

for (const [label, options] of [
  ['ad-hoc update', { downloaded: adHocIdentity }],
  ['different publisher', { downloaded: 'Identifier=com.mallenkb.loommediaserver\nTeamIdentifier=OTHER12345' }],
  ['different bundle', { downloaded: 'Identifier=wrong.app\nTeamIdentifier=ABCDE12345' }],
  ['Apple signing requirement', { rejectRequirement: true }],
  ['downloaded signature', { rejectDownloadedSignature: true }],
  ['signature with failed temporary cleanup', { rejectDownloadedSignature: true, rejectHelperCleanup: true }],
] as const) {
  test(`${label} fails install preflight without draining cleanup`, async () => {
    const fixture = updaterFixture(options);
    fixture.download();
    await assertPreflightFailure(fixture, /could not be verified and was not installed/);
    assert.ok(fixture.calls.some(({ file }) => file === '/usr/bin/ditto'));
    assert.deepEqual(fixture.effects, ['remove-helper']);
  });
}

for (const [label, options, message] of [
  ['installed signature', { rejectSignature: true }, /could not be verified/],
  ['archive checksum', { rejectChecksum: true }, /could not be verified/],
  ['archive extraction', { rejectExtraction: true }, /couldn’t prepare/],
  ['target permissions', { rejectPermission: true }, /permission to install/],
  ['helper write', { rejectHelperWrite: true }, /permission to install/],
] as const) {
  test(`${label} fails install preflight without draining cleanup`, async () => {
    const fixture = updaterFixture(options);
    fixture.download();
    await assertPreflightFailure(fixture, message);
  });
}

test('missing macOS archive fails closed instead of falling through to Squirrel', async () => {
  const fixture = updaterFixture();
  fixture.autoUpdater.emit('update-downloaded', {});
  await assertPreflightFailure(fixture, /could not be verified/);
  assert.match(String(fixture.errors[0][1]), /archive is missing/);
  assert.ok(!fixture.calls.some(({ file }) => file === '/usr/bin/ditto'));
});

test('install does nothing before an update has downloaded', async () => {
  const fixture = updaterFixture();
  assert.equal((await fixture.api.installDownloadedUpdate()).status, 'idle');
  assert.equal(fixture.api.isUpdateInstalling(), false);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.cleanups, []);
  assert.deepEqual(fixture.effects, []);
  assert.deepEqual(fixture.timers, []);
});

test('manual release download remains available from the updater menu', () => {
  const fixture = updaterFixture();
  fixture.api.buildUpdateMenu();
  const download = fixture.menu().flatMap((item) => item.submenu ?? []).find((item) => item.label === 'Download Latest Release...');
  assert.ok(download?.click);
  download.click();
  assert.deepEqual(fixture.opened, ['https://github.com/mallenkb/LoomTV/releases/latest']);
});

test('macOS update helpers use a private unpredictable temporary directory', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loomtv-update-install-'));
  try {
    if (process.platform !== 'win32') assert.equal((await fs.promises.stat(directory)).mode & 0o777, 0o700);
    assert.notEqual(path.basename(directory), 'loomtv-update-install-');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('update install shutdown force-closes active media server connections', async () => {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      Connection: 'keep-alive',
    });
    res.write('stream-open');
  });
  trackServerConnections(server, sockets);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.ok(address);

  const socket = net.createConnection(address.port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
  await once(socket, 'data');

  assert.equal(sockets.size, 1);
  await closeServerForUpdateInstall(server, sockets, 20);

  assert.equal(server.listening, false);
  assert.equal(sockets.size, 0);
});
