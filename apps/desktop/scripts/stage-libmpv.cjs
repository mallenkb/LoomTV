'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') process.exit(0);

const desktopRoot = path.resolve(__dirname, '..');
const library = process.env.LOOMTV_LIBMPV_PATH?.trim()
  || ['/opt/homebrew/lib/libmpv.dylib', '/usr/local/lib/libmpv.dylib'].find(fs.existsSync);
const include = process.env.LIBMPV_INCLUDE_DIR?.trim()
  || ['/opt/homebrew/include', '/usr/local/include'].find((candidate) => fs.existsSync(path.join(candidate, 'mpv/client.h')));

if (!library || !include) {
  console.warn('[libmpv] Local library or headers are unavailable; keeping any existing staged runtime.');
  process.exit(0);
}

const destination = path.join(desktopRoot, 'resources', 'mpv', 'lib');
fs.mkdirSync(destination, { recursive: true });
const stagedLibrary = path.join(destination, 'libmpv.dylib');
fs.copyFileSync(fs.realpathSync(library), stagedLibrary);
fs.chmodSync(stagedLibrary, fs.statSync(stagedLibrary).mode | 0o200);

const bridgeOutput = path.join(destination, 'libloomtv_mpv_bridge.dylib');
const build = spawnSync(process.execPath, [
  path.join(desktopRoot, 'native', 'libmpv', 'draft-render-bridge', 'build.mjs'),
  bridgeOutput,
], {
  env: { ...process.env, LIBMPV_INCLUDE_DIR: include },
  stdio: 'inherit',
});
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`The libmpv bridge build failed with status ${build.status}.`);
console.log('[libmpv] Staged the in-process Electron runtime.');
