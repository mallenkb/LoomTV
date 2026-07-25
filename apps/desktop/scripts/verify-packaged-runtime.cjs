const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');

const root = process.cwd();
const outDir = path.join(root, 'out');
const platform = process.platform;
const arch = process.arch;

function exists(candidate) {
  return fs.existsSync(candidate);
}

function fail(message) {
  console.error(`[runtime-check] ${message}`);
  process.exitCode = 1;
}

function resourcesDir(packageDir) {
  if (platform === 'darwin') {
    return path.join(appBundlePath(packageDir), 'Contents', 'Resources');
  }
  return path.join(packageDir, 'resources');
}

function appBundlePath(packageDir) {
  return ['LoomTV.app', 'Loom Media Server.app']
    .map((name) => path.join(packageDir, name))
    .find(exists) || path.join(packageDir, 'LoomTV.app');
}

function productPath(packageDir, platform, arch) {
  const forgePlatform = platform === 'win32' ? 'win32' : platform;
  return ['LoomTV', 'Loom Media Server']
    .map((name) => path.join(packageDir, `${name}-${forgePlatform}-${arch}`));
}

function mainExecutablePath(appBundle) {
  return ['LoomTV', 'Loom Media Server']
    .map((name) => path.join(appBundle, 'Contents', 'MacOS', name))
    .find(exists) || path.join(appBundle, 'Contents', 'MacOS', 'LoomTV');
}

function codeSigningDetails(target) {
  const result = spawnSync('/usr/bin/codesign', ['-dvvv', target], { encoding: 'utf8' });
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function signingTeam(details) {
  return details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || '';
}

function hasHardenedRuntime(details) {
  return /^CodeDirectory .*flags=.*\bruntime\b/m.test(details);
}

function packageDirCandidates() {
  const builderDir = path.join(outDir, 'builder');
  if (platform === 'darwin') {
    return [
      ...productPath(outDir, platform, arch),
      path.join(builderDir, `mac-${arch}`),
      path.join(builderDir, 'mac'),
    ];
  }

  if (platform === 'win32') {
    return [
      ...productPath(outDir, platform, arch),
      path.join(builderDir, 'win-unpacked'),
    ];
  }

  return [
    ...productPath(outDir, platform, arch),
    path.join(builderDir, 'linux-unpacked'),
  ];
}

function platformFolder() {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

function binaryName(name) {
  return platform === 'win32' ? `${name}.exe` : name;
}

const packageDir = packageDirCandidates().find((candidate) => exists(resourcesDir(candidate))) || packageDirCandidates()[0];
const resources = resourcesDir(packageDir);
const appAsar = path.join(resources, 'app.asar');
const unpacked = path.join(resources, 'app.asar.unpacked');

if (!exists(resources)) fail(`Missing resources directory: ${resources}`);
if (!exists(appAsar)) fail(`Missing app.asar: ${appAsar}`);

if (platform === 'darwin') {
  const appBundle = appBundlePath(packageDir);
  const mainExecutable = mainExecutablePath(appBundle);
  const electronFramework = path.join(
    appBundle,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Electron Framework',
  );
  const signatureCheck = spawnSync('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=2', appBundle,
  ], { encoding: 'utf8' });
  if (signatureCheck.status !== 0) {
    fail(`Invalid macOS app signature.\n${signatureCheck.stderr || signatureCheck.stdout}`);
  }

  const mainDetails = codeSigningDetails(mainExecutable);
  const frameworkDetails = codeSigningDetails(electronFramework);
  const mainTeam = signingTeam(mainDetails);
  const frameworkTeam = signingTeam(frameworkDetails);
  const bothAdHoc = mainTeam === 'not set' && frameworkTeam === 'not set';
  const matchingDeveloperId = Boolean(mainTeam && mainTeam === frameworkTeam && mainTeam !== 'not set');

  if (!matchingDeveloperId && !bothAdHoc) {
    fail(`macOS signing Team ID mismatch: app=${mainTeam || 'missing'}, framework=${frameworkTeam || 'missing'}.`);
  }
  if (bothAdHoc && (hasHardenedRuntime(mainDetails) || hasHardenedRuntime(frameworkDetails))) {
    fail('Ad-hoc macOS bundles must not enable hardened runtime; dyld will reject the Electron Framework Team ID.');
  }
}

const appFiles = exists(appAsar)
  ? new Set(asar.listPackage(appAsar).map((entry) => entry.replace(/\\/g, '/')))
  : new Set();
const requiredAsarEntries = [
  '/node_modules/better-sqlite3/lib/index.js',
  '/node_modules/bindings/bindings.js',
  '/node_modules/builder-util-runtime/out/index.js',
  '/node_modules/electron-updater/out/main.js',
  '/node_modules/file-uri-to-path/index.js',
  '/node_modules/ffmpeg-static/index.js',
  '/node_modules/ffprobe-static/index.js',
  '/node_modules/fs-extra/lib/index.js',
  '/node_modules/js-yaml/index.js',
  '/node_modules/lazy-val/out/main.js',
  '/node_modules/lodash.escaperegexp/index.js',
  '/node_modules/lodash.isequal/index.js',
  '/node_modules/semver/index.js',
  '/node_modules/tiny-typed-emitter/lib/index.js',
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

const sqliteNative = requiredUnpacked[0];
if (exists(sqliteNative)) {
  const checkScript = path.join(os.tmpdir(), `loomtv-native-check-${process.pid}.cjs`);
  fs.writeFileSync(checkScript, `require(${JSON.stringify(sqliteNative)});\n`, 'utf8');

  const result = spawnSync(require('electron'), [checkScript], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  fs.rmSync(checkScript, { force: true });

  if (result.status !== 0) {
    fail(`better-sqlite3 native module is not compatible with Electron ${process.versions.electron || ''}.\n${result.stderr || result.stdout}`);
  }
}

const bundledFfmpeg = path.join(resources, 'ffmpeg', platformFolder(), binaryName('ffmpeg'));
const bundledFfprobe = path.join(resources, 'ffmpeg', platformFolder(), binaryName('ffprobe'));
const bundledFpcalc = path.join(resources, 'fpcalc', platformFolder(), platform === 'win32' ? 'fpcalc.exe' : 'fpcalc');
const fpcalcNotice = path.join(resources, 'fpcalc', 'NOTICE.md');
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

if (!exists(bundledFpcalc)) {
  fail(`Missing bundled fpcalc. Checked ${bundledFpcalc}`);
}

if (!exists(fpcalcNotice)) {
  fail(`Missing fpcalc distribution notice. Checked ${fpcalcNotice}`);
}

// When these are absent the tray silently falls back to the full-colour app
// icon, which macOS then renders as a solid rounded square because a template
// image is drawn from the alpha channel alone.
for (const trayAsset of ['trayIcon.png', 'trayIcon@2x.png']) {
  const trayIconPath = path.join(resources, trayAsset);
  if (!exists(trayIconPath)) {
    fail(`Missing tray icon asset. Checked ${trayIconPath}`);
  }
}

if (process.exitCode) process.exit(process.exitCode);

console.log('[runtime-check] Packaged runtime dependencies are present.');
