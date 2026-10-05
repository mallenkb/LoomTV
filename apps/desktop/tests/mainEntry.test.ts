import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const entry = fs.readFileSync(new URL('../src/mainEntry.cjs', import.meta.url), 'utf8');

function runEntry(override?: string, cacheFails = false) {
  const calls: unknown[] = [];
  vm.runInNewContext(entry, {
    process: { env: { LOOMTV_DATA_DIR: override } },
    require(id: string) {
      if (id === 'node:path') return path;
      if (id === 'electron') return { app: {
        setName: (name: string) => calls.push(['name', name]),
        getPath: (name: string) => { assert.equal(name, 'appData'); return '/data'; },
        setPath: (name: string, value: string) => calls.push(['path', name, value]),
      } };
      if (id === 'node:module') return { enableCompileCache(directory: string) {
        calls.push(['cache', directory]);
        if (cacheFails) throw new Error('Unwritable');
      } };
      assert.equal(id, './main-bundle.js');
      calls.push(['bundle']);
    },
  });
  return calls;
}

test('main bootstrap sets userData and enables the compile cache before loading the bundle', () => {
  assert.deepEqual(runEntry(), [
    ['name', 'LoomTV'], ['path', 'userData', '/data/LoomTV'], ['cache', '/data/LoomTV/v8-compile-cache'], ['bundle'],
  ]);
});

test('main bootstrap resolves trimmed absolute and relative data overrides', () => {
  for (const override of [' /override ', ' relative-data ']) {
    const directory = path.resolve(override.trim());
    assert.deepEqual(runEntry(override).slice(1), [
      ['path', 'userData', directory], ['cache', path.join(directory, 'v8-compile-cache')], ['bundle'],
    ]);
  }
  assert.deepEqual(runEntry('  '), runEntry());
});

test('compile cache failure still loads the application bundle', () => {
  assert.deepEqual(runEntry(undefined, true).at(-1), ['bundle']);
});

test('both packagers include the unchanged main entry and separate bundle inside asar', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.main, '.vite/build/main.js');
  assert.ok(packageJson.build.files.includes('.vite/build/**/*'));
  assert.equal(packageJson.build.asar, true);
  const config = fs.readFileSync(new URL('../vite.main.config.ts', import.meta.url), 'utf8');
  assert.match(config, /fileName: 'main.js'/);
  assert.match(config, /entryFileNames: 'main-bundle.js'/);
  const forge = fs.readFileSync(new URL('../forge.config.ts', import.meta.url), 'utf8');
  assert.match(forge, /entry: 'src\/main.ts',\s+config: 'vite.main.config.ts'/);
});
