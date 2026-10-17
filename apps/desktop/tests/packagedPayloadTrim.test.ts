import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));
const { thinMacUniversalBinaries, pruneUnpackedNativeModules } = require('../scripts/ensure-update-config.cjs') as {
  thinMacUniversalBinaries: (resources: string, platform: string, arch: string) => void;
  pruneUnpackedNativeModules: (resources: string, platform: string, arch: string) => void;
};

function scratchResources(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-payload-'));
}

const universalFpcalc = path.join(directory, '..', 'resources', 'fpcalc', 'mac', 'fpcalc');
const canThin = process.platform === 'darwin' && fs.existsSync(universalFpcalc)
  && execFileSync('/usr/bin/lipo', ['-archs', universalFpcalc], { encoding: 'utf8' }).trim().split(/\s+/).length > 1;

test('a Mac package keeps only its own slice of universal runtime binaries', { skip: !canThin && 'needs macOS and the universal fpcalc' }, () => {
  const resources = scratchResources();
  try {
    const target = path.join(resources, 'fpcalc', 'mac', 'fpcalc');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(universalFpcalc, target);
    fs.chmodSync(target, 0o755);
    thinMacUniversalBinaries(resources, 'darwin', 'arm64');
    assert.equal(execFileSync('/usr/bin/lipo', ['-archs', target], { encoding: 'utf8' }).trim(), 'arm64');
    assert.notEqual(fs.statSync(target).mode & 0o111, 0);
    assert.ok(fs.statSync(target).size < fs.statSync(universalFpcalc).size);
    // A second pass sees a thin binary and leaves it alone.
    thinMacUniversalBinaries(resources, 'darwin', 'arm64');
    assert.equal(execFileSync('/usr/bin/lipo', ['-archs', target], { encoding: 'utf8' }).trim(), 'arm64');
  } finally {
    fs.rmSync(resources, { recursive: true, force: true });
  }
});

test('thinning ignores other platforms and missing binaries', () => {
  const resources = scratchResources();
  try {
    assert.doesNotThrow(() => thinMacUniversalBinaries(resources, 'darwin', 'arm64'));
    assert.doesNotThrow(() => thinMacUniversalBinaries(resources, 'win32', 'x64'));
  } finally {
    fs.rmSync(resources, { recursive: true, force: true });
  }
});

test('a Mac package drops the other architecture\'s native packages and better-sqlite3 build inputs', () => {
  const resources = scratchResources();
  const modules = path.join(resources, 'app.asar.unpacked', 'node_modules');
  const touch = (relative: string) => {
    const file = path.join(modules, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  };
  try {
    for (const relative of [
      '@img/sharp-darwin-arm64/lib/sharp.node',
      '@img/sharp-darwin-x64/lib/sharp.node',
      '@img/sharp-libvips-darwin-arm64/lib/libvips.dylib',
      '@img/sharp-libvips-darwin-x64/lib/libvips.dylib',
      '@img/colour/index.js',
      '@koromix/koffi-darwin-arm64/koffi.node',
      '@koromix/koffi-darwin-x64/koffi.node',
      'better-sqlite3/build/Release/better_sqlite3.node',
      'better-sqlite3/build/Release/test_extension.node',
      'better-sqlite3/build/Release/obj/gen/sqlite3/sqlite3.c',
      'better-sqlite3/build/deps/sqlite3.Makefile',
    ]) touch(relative);

    pruneUnpackedNativeModules(resources, 'darwin', 'arm64');

    const exists = (relative: string) => fs.existsSync(path.join(modules, relative));
    assert.equal(exists('@img/sharp-darwin-arm64'), true);
    assert.equal(exists('@img/sharp-libvips-darwin-arm64'), true);
    assert.equal(exists('@img/colour'), true);
    assert.equal(exists('@koromix/koffi-darwin-arm64'), true);
    assert.equal(exists('better-sqlite3/build/Release/better_sqlite3.node'), true);
    assert.equal(exists('@img/sharp-darwin-x64'), false);
    assert.equal(exists('@img/sharp-libvips-darwin-x64'), false);
    assert.equal(exists('@koromix/koffi-darwin-x64'), false);
    assert.equal(exists('better-sqlite3/build/Release/test_extension.node'), false);
    assert.equal(exists('better-sqlite3/build/Release/obj'), false);
    assert.equal(exists('better-sqlite3/build/deps'), false);
  } finally {
    fs.rmSync(resources, { recursive: true, force: true });
  }
});

test('desktop packaging ships only the English Chromium locale', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(directory, '..', 'package.json'), 'utf8')) as {
    build?: { electronLanguages?: string[] };
  };
  assert.deepEqual(packageJson.build?.electronLanguages, ['en']);
});
