const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const root = process.cwd();
const outDir = path.join(root, 'out');
const platform = process.platform;
const arch = process.arch;
const packageDir = path.join(
  outDir,
  `LoomTV-${platform === 'win32' ? 'win32' : platform}-${arch}`,
);

function exists(candidate) {
  return fs.existsSync(candidate);
}

function fail(message) {
  console.error(`[runtime-check] ${message}`);
  process.exitCode = 1;
}

function resourcesDir() {
  if (platform === 'darwin') {
    return path.join(packageDir, 'LoomTV.app', 'Contents', 'Resources');
  }
  return path.join(packageDir, 'resources');
}

function platformFolder() {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

function binaryName(name) {
  return platform === 'win32' ? `${name}.exe` : name;
}

const resources = resourcesDir();
const appAsar = path.join(resources, 'app.asar');
const unpacked = path.join(resources, 'app.asar.unpacked');

if (!exists(resources)) fail(`Missing resources directory: ${resources}`);
if (!exists(appAsar)) fail(`Missing app.asar: ${appAsar}`);

const appFiles = exists(appAsar)
  ? new Set(asar.listPackage(appAsar).map((entry) => entry.replace(/\\/g, '/')))
  : new Set();
const requiredAsarEntries = [
  '/node_modules/better-sqlite3/lib/index.js',
  '/node_modules/bindings/bindings.js',
  '/node_modules/file-uri-to-path/index.js',
  '/node_modules/ffmpeg-static/index.js',
  '/node_modules/ffprobe-static/index.js',
];

for (const entry of requiredAsarEntries) {
  if (!appFiles.has(entry)) fail(`Missing ${entry} in app.asar`);
}

const requiredUnpacked = [
  path.join(unpacked, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
];

for (const candidate of requiredUnpacked) {
  if (!exists(candidate)) fail(`Missing unpacked runtime file: ${candidate}`);
}

const bundledFfmpeg = path.join(resources, 'ffmpeg', platformFolder(), binaryName('ffmpeg'));
const bundledFfprobe = path.join(resources, 'ffmpeg', platformFolder(), binaryName('ffprobe'));
const staticFfmpeg = path.join(
  unpacked,
  'node_modules',
  'ffmpeg-static',
  platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
);
const staticFfprobe = path.join(
  unpacked,
  'node_modules',
  'ffprobe-static',
  'bin',
  platform,
  arch,
  binaryName('ffprobe'),
);

if (!exists(bundledFfmpeg) && !exists(staticFfmpeg)) {
  fail(`Missing bundled ffmpeg. Checked ${bundledFfmpeg} and ${staticFfmpeg}`);
}

if (!exists(bundledFfprobe) && !exists(staticFfprobe)) {
  fail(`Missing bundled ffprobe. Checked ${bundledFfprobe} and ${staticFfprobe}`);
}

if (process.exitCode) process.exit(process.exitCode);

console.log('[runtime-check] Packaged runtime dependencies are present.');
