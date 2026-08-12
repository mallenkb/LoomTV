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

function isPackagedMpvPath(value) {
  return /(?:^|[\\/])(?:mpv(?:[-_.][^\\/]*)?|libmpv(?:[-_.][^\\/]*)?)(?:$|[\\/])/i.test(value);
}

function findPackagedMpvFiles(rootPath) {
  const matches = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (isPackagedMpvPath(candidate)) matches.push(candidate);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(candidate);
    }
  }
  return matches;
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

const prohibitedMpvEntries = [
  ...[...appFiles].filter(isPackagedMpvPath),
  ...findPackagedMpvFiles(packageDir),
];
if (prohibitedMpvEntries.length > 0) {
  fail(`Packaged mpv files are prohibited by the external-mpv distribution policy:\n${[...new Set(prohibitedMpvEntries)].join('\n')}`);
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
const libVlcPilotNotice = path.join(resources, 'libvlc', 'NOTICE.md');

const runtimeManifestPath = path.join(resources, 'ffmpeg', 'runtime-provenance.json');
let runtimeManifest = null;
if (!exists(runtimeManifestPath)) {
  fail(`Missing FFmpeg runtime provenance manifest. Checked ${runtimeManifestPath}`);
} else {
  try {
    runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'));
  } catch (error) {
    fail(`Invalid FFmpeg runtime provenance manifest ${runtimeManifestPath}: ${String(error)}`);
  }
}

const manifestComponents = runtimeManifest && Array.isArray(runtimeManifest.components)
  ? runtimeManifest.components
  : [];
if (
  !runtimeManifest
  || runtimeManifest.manifestVersion !== 1
  || runtimeManifest.application?.license !== 'MIT'
  || runtimeManifest.pathsAreRelativeTo !== 'resources'
  || runtimeManifest.distributionPolicy?.mpvBundled !== false
  || runtimeManifest.distributionPolicy?.mpvDownloadedByLoomTV !== false
  || runtimeManifest.distributionPolicy?.mpvLinkedByLoomTV !== false
  || manifestComponents.length === 0
) {
  fail(`FFmpeg runtime provenance manifest is missing required fields: ${runtimeManifestPath}`);
}

const manifestFiles = manifestComponents.flatMap((component) => (
  Array.isArray(component.files)
    ? component.files.map((file) => ({ ...file, componentId: component.id }))
    : []
));
for (const file of manifestFiles) {
  if (!Object.prototype.hasOwnProperty.call(file, 'sha256') || typeof file.hashStatus !== 'string') {
    fail(`Runtime manifest file entry must declare sha256 and hashStatus: ${file.path || '<unknown>'}`);
  }
  if (file.sha256 !== null && !/^[a-f0-9]{64}$/i.test(file.sha256)) {
    fail(`Runtime manifest has an invalid SHA-256 value: ${file.path || '<unknown>'}`);
  }
}

const currentPlatformManifestFiles = manifestFiles.filter((file) => file.platform === platform);
const declaredFfmpegFiles = new Set(currentPlatformManifestFiles.map((file) => file.path));
if (platform === 'darwin' || platform === 'win32') {
  for (const name of ['ffmpeg', 'ffprobe']) {
    const expectedPath = `ffmpeg/${platformFolder()}/${binaryName(name)}`;
    if (!declaredFfmpegFiles.has(expectedPath)) {
      fail(`Runtime manifest does not declare the authoritative ${name} binary for ${platform}: ${expectedPath}`);
    }
  }
}
if (declaredFfmpegFiles.has(`ffmpeg/${platformFolder()}/${binaryName('ffmpeg')}`) && !exists(bundledFfmpeg)) {
  fail(`Missing authoritative bundled ffmpeg. Checked ${bundledFfmpeg}`);
}
if (declaredFfmpegFiles.has(`ffmpeg/${platformFolder()}/${binaryName('ffprobe')}`) && !exists(bundledFfprobe)) {
  fail(`Missing authoritative bundled ffprobe. Checked ${bundledFfprobe}`);
}

if (!exists(bundledFpcalc)) {
  fail(`Missing bundled fpcalc. Checked ${bundledFpcalc}`);
}

if (!exists(fpcalcNotice)) {
  fail(`Missing fpcalc distribution notice. Checked ${fpcalcNotice}`);
}

if (!exists(libVlcPilotNotice)) {
  fail(`Missing LibVLC pilot status notice. Checked ${libVlcPilotNotice}`);
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
