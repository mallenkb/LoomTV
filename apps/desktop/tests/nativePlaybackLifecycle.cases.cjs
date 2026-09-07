const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { NativeSessionLease } = require('../src/components/VideoPlayer/engines/NativeSessionLease.ts');

const directory = path.resolve(__dirname, '../src/components/VideoPlayer/engines');
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
// Execute the actual engine classes with a fake desktop transport. The native
// libraries, Electron and Tauri are deliberately not involved in these tests.
function compile(name, dependencies) {
  const filename = path.join(directory, `${name}.ts`);
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: f => f, getCurrentDirectory: () => directory, getNewLine: () => '\n',
  }));
  const module = { exports: {} };
  const run = vm.runInThisContext(`(function(require,module,exports){${result.outputText}\n})`, { filename });
  run(id => {
    if (id in dependencies) return dependencies[id];
    throw new Error(`Unexpected test dependency: ${id}`);
  }, module, module.exports);
  return module.exports;
}
function fixture(kind) {
  const starts = [], stops = [], states = [], commands = [], probes = [];
  let receive, unsubscriptions = 0, commandOk = true;
  const port = {
    async availability() { return { available: true, enabled: true, surface: 'composited-window' }; },
    start(source, options) { const d = deferred(); starts.push({ ...d, source, options }); return d.promise; },
    async stop(id) { stops.push(id); return true; },
    async command(id, value) { commands.push({ id, value }); return commandOk; },
    onState(listener) { receive = listener; return () => { unsubscriptions++; }; },
  };
  const desktopApi = {
    mpv: port, libvlc: port,
    media: { async probe(source) { probes.push(source); return { ok: true, data: {} }; } },
  };
  const volume = compile('PlaybackVolumeController', {});
  const name = kind === 'libvlc' ? 'LibVlcPlaybackEngine' : 'MpvPlaybackEngine';
  const Engine = compile(name, {
    '@/lib/desktopApi': { desktopApi },
    './NativeSessionLease': { NativeSessionLease },
    './PlaybackVolumeController': volume,
    '../helpers': { probeTracks: () => [] },
  }).default;
  const engine = new Engine(state => states.push(state));
  return { engine, port, starts, stops, states, commands, probes,
    emit: state => receive(state),
    get unsubscriptions() { return unsubscriptions; },
    set commandOk(value) { commandOk = value; },
  };
}
async function start(f, id = 'active', surface = 'composited-window') {
  const promise = f.engine.load('movie.mkv'); await settle();
  f.starts.at(-1).resolve({ ok: true, sessionId: id, surface });
  return promise;
}
for (const kind of ['libvlc', 'mpv']) {
  test(`${kind}: destroy during start stops a late native session`, async () => {
    const f = fixture(kind); const p = f.engine.load('slow.mkv'); await settle();
    const d = f.engine.destroy(); f.starts[0].resolve({ ok: true, sessionId: 'late', surface: 'composited-window' });
    assert.equal(await p, false); await d; assert.deepEqual(f.stops, ['late']); assert.equal(f.states.length, 0);
    assert.equal(f.unsubscriptions, 1);
  });
  test(`${kind}: destroy before dispatch never starts playback`, async () => {
    const f = fixture(kind); const p = f.engine.load('slow.mkv'); const d = f.engine.destroy();
    assert.equal(await p, false); await d; assert.equal(f.starts.length, 0);
  });
  test(`${kind}: repeated destroy is safe and load after destroy is rejected`, async () => {
    const f = fixture(kind); await start(f); await Promise.all([f.engine.destroy(), f.engine.destroy()]);
    assert.deepEqual(f.stops, ['active']); assert.equal(f.unsubscriptions, 1);
    await assert.rejects(f.engine.load('new.mkv'), /disposed/);
  });
  test(`${kind}: active state and early track patches remain scoped to the returned ID`, async () => {
    const f = fixture(kind); const p = f.engine.load('movie.mkv'); await settle();
    f.emit({ sessionId: 'obsolete', status: 'error' });
    f.emit({ sessionId: 'active', status: 'loading', tracks: [{id: 1, type: 'audio', source: 'embedded', selected: true}] });
    f.emit({ sessionId: 'active', status: 'ready', position: 8 });
    f.starts[0].resolve({ok:true,sessionId:'active',surface:'composited-window'}); await p;
    assert.equal(f.states.length, 1); assert.equal(f.states[0].position, 8); assert.equal(f.states[0].tracks.length, 1);
    await f.engine.destroy();
  });
  test(`${kind}: queued loads are serialized and only the newest survives`, async () => {
    const f = fixture(kind); const a = f.engine.load('a'); await settle();
    const b = f.engine.load('b'), c = f.engine.load('c');
    f.starts[0].resolve({ok:true,sessionId:'a',surface:'composited-window'});
    assert.equal(await a,false); assert.equal(await b,false); await settle();
    assert.deepEqual(f.starts.map(s=>s.source),['a','c']);
    f.starts[1].resolve({ok:true,sessionId:'c',surface:'composited-window'}); assert.equal(await c,true);
    await f.engine.destroy(); assert.deepEqual(f.stops,['a','c']);
  });
  test(`${kind}: a failed pause can be retried`, async () => {
    const f = fixture(kind); await start(f); f.commandOk = false;
    await assert.rejects(f.engine.pause()); f.commandOk = true; await f.engine.pause();
    assert.equal(f.commands.filter(c=>c.value.type==='set-paused').length,2); await f.engine.destroy();
  });
  test(`${kind}: queued seeks are cancelled on destroy`, async () => {
    const f = fixture(kind); await start(f); await f.engine.seek(1); await f.engine.seek(2); await f.engine.seek(3);
    await f.engine.destroy(); const count=f.commands.length; await new Promise(r=>setTimeout(r,30));
    assert.equal(f.commands.length,count);
  });
  test(`${kind}: destroyed engines cannot forward stale seek commands`, async () => {
    const f = fixture(kind); await start(f); await f.engine.destroy(); await f.engine.seek(100);
    assert.equal(f.commands.length,0);
  });
}
test('libvlc: wrong-surface success is rejected and its allocated session reclaimed', async () => {
  const f=fixture('libvlc'); await assert.rejects(start(f,'wrong','external-window'), /not composited/);
  await f.engine.destroy(); assert.deepEqual(f.stops,['wrong']);
});
test('mpv: surface remains truthful until embedded native integration is connected', async () => {
  const f=fixture('mpv'); await start(f,'external','external-window'); assert.equal(f.engine.surface,'external-window');
  await f.engine.destroy();
});
test('mpv: compositor confirmation from the host is preserved', async () => {
  const f=fixture('mpv'); await start(f); assert.equal(f.engine.surface,'composited-window'); await f.engine.destroy();
});
test('libvlc: disposal cancels metadata work scheduled by an early ready event', async () => {
  const f=fixture('libvlc'); const p=f.engine.load('movie.mkv'); await settle();
  f.emit({sessionId:'active',status:'ready'}); f.starts[0].resolve({ok:true,sessionId:'active',surface:'composited-window'}); await p;
  await f.engine.destroy(); await new Promise(r=>setTimeout(r,280)); assert.equal(f.probes.length,0);
});
