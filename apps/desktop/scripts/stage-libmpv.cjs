'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stageMacClosure, stageLinuxClosure } = require('./libmpv-dependencies.cjs');

const required = process.argv.includes('--required');
const desktopRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(desktopRoot, '../..');
const destination = path.join(desktopRoot, 'resources', 'mpv', 'lib');
const platform = process.platform;
const libraryName = platform === 'darwin' ? 'libmpv.dylib' : platform === 'win32' ? 'mpv-2.dll' : 'libmpv.so';
const bridgeName = platform === 'darwin' ? 'libloomtv_mpv_bridge.dylib'
  : platform === 'win32' ? 'loomtv_mpv_bridge.dll' : 'libloomtv_mpv_bridge.so';

function file(candidate) {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

function candidates() {
  const configured = process.env.LOOMTV_LIBMPV_PATH?.trim();
  if (configured) return [configured];
  if (platform === 'darwin') return ['/opt/homebrew/lib/libmpv.dylib', '/usr/local/lib/libmpv.dylib'];
  if (platform === 'win32') {
    return [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'mpv', 'mpv-2.dll'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'mpv', 'mpv-2.dll'),
    ].filter(Boolean);
  }
  const triplet = process.arch === 'x64' ? 'x86_64-linux-gnu'
    : process.arch === 'arm64' ? 'aarch64-linux-gnu' : '';
  return [
    triplet && `/usr/lib/${triplet}/libmpv.so.2`,
    triplet && `/usr/lib/${triplet}/libmpv.so`,
    '/usr/local/lib/libmpv.so.2', '/usr/local/lib/libmpv.so',
    '/usr/lib64/libmpv.so.2', '/usr/lib64/libmpv.so',
    '/usr/lib/libmpv.so.2', '/usr/lib/libmpv.so',
  ].filter(Boolean);
}

function run(binary, arguments_, options = {}) {
  const result = spawnSync(binary, arguments_, { cwd: workspaceRoot, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed with status ${result.status}.`);
}

function copyLibrary(source) {
  fs.mkdirSync(destination, { recursive: true });
  const stagedLibrary = path.join(destination, libraryName);
  const canonicalSource = fs.realpathSync(source);
  if (path.resolve(canonicalSource) !== path.resolve(stagedLibrary)) {
    fs.copyFileSync(canonicalSource, stagedLibrary);
  }
  fs.chmodSync(stagedLibrary, fs.statSync(stagedLibrary).mode | 0o200);

  // Windows libmpv distributions commonly keep codec and graphics DLLs beside
  // mpv-2.dll. Keep that local dependency set together when staging a release.
  if (platform === 'win32') {
    const sourceDirectory = path.dirname(source);
    if (path.resolve(sourceDirectory) !== path.resolve(destination)) {
      for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.dll$/i.test(entry.name) || entry.name.toLowerCase() === bridgeName.toLowerCase()) continue;
        const staged = path.join(destination, entry.name);
        if (path.resolve(path.join(sourceDirectory, entry.name)) !== path.resolve(staged)) {
          fs.copyFileSync(path.join(sourceDirectory, entry.name), staged);
        }
      }
    }
  }
}

function buildBridge() {
  fs.mkdirSync(destination, { recursive: true });
  const bridgeOutput = path.join(destination, bridgeName);
  if (platform === 'darwin') {
    const include = process.env.LIBMPV_INCLUDE_DIR?.trim()
      || ['/opt/homebrew/include', '/usr/local/include']
        .find((candidate) => file(path.join(candidate, 'mpv', 'client.h')));
    if (!include) {
      if (file(bridgeOutput)) return;
      throw new Error('libmpv headers are missing. Set LIBMPV_INCLUDE_DIR to the directory containing mpv/client.h.');
    }
    run(process.execPath, [
      path.join(desktopRoot, 'native', 'libmpv', 'draft-render-bridge', 'build.mjs'), bridgeOutput,
    ], { env: { ...process.env, LIBMPV_INCLUDE_DIR: include } });
    return;
  }

  if (platform !== 'win32' && platform !== 'linux') {
    throw new Error(`No libmpv bridge build exists for ${platform}.`);
  }
  run(process.env.CARGO || 'cargo', ['build', '--locked', '--release', '-p', 'loomtv-mpv-bridge']);
  const built = path.join(workspaceRoot, 'target', 'release', bridgeName);
  if (!file(built)) throw new Error(`The Rust libmpv bridge did not produce ${built}.`);
  fs.copyFileSync(built, bridgeOutput);
}

const source = candidates().find(file);
const stagedLibrary = path.join(destination, libraryName);
if (!source && !file(stagedLibrary)) {
  const message = `[libmpv] Missing ${libraryName}. Set LOOMTV_LIBMPV_PATH to a reviewed local libmpv build.`;
  if (required) throw new Error(message);
  console.warn(`${message} Native libmpv remains unavailable on this host.`);
  process.exit(0);
}

if (source) copyLibrary(source);
buildBridge();
if (required && platform === 'darwin') {
  const count = stageMacClosure(source || stagedLibrary, destination, libraryName);
  console.log(`[libmpv] Bundled ${count} macOS dylibs with local loader paths.`);
}
if (required && platform === 'linux') {
  const count = stageLinuxClosure(source || stagedLibrary, destination, libraryName);
  console.log(`[libmpv] Bundled ${count} Linux shared libraries with $ORIGIN loader paths.`);
}
console.log(`[libmpv] Staged ${platform}/${process.arch} runtime in ${destination}.`);
