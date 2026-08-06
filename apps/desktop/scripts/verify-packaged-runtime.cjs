const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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

const selectedRuntimePlatform = String(
  process.env.LOOMTV_RUNTIME_PLATFORM || platform,
).trim().toLowerCase();
const selectedRuntimeArch = String(
  process.env.LOOMTV_RUNTIME_ARCH || arch,
).trim().toLowerCase();

function platformToken(value) {
  if (['darwin', 'mac', 'macos'].includes(value)) return 'darwin';
  if (['win32', 'win', 'windows'].includes(value)) return 'win32';
  if (['linux'].includes(value)) return 'linux';
  return value;
}

function architectureToken(value) {
  if (['arm64', 'aarch64'].includes(value)) return 'arm64';
  if (['x64', 'amd64'].includes(value)) return 'x64';
  if (['ia32', 'x86'].includes(value)) return 'ia32';
  if (['arm', 'armv7'].includes(value)) return 'arm';
  return value;
}

function nativeLibraryName(targetPlatform) {
  if (targetPlatform === 'win32') return 'libvlc.dll';
  if (targetPlatform === 'darwin') return 'libvlc.dylib';
  return 'libvlc.so';
}

function nativeExecutableName(targetPlatform) {
  return targetPlatform === 'win32' ? 'mpv.exe' : 'mpv';
}

function regularFile(candidate) {
  try {
    return fs.lstatSync(candidate).isFile();
  } catch {
    return false;
  }
}

function directory(candidate) {
  try {
    return fs.lstatSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function readMagic(candidate) {
  const fd = fs.openSync(candidate, 'r');
  const buffer = Buffer.alloc(4);
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function hasExpectedNativeMagic(candidate, targetPlatform) {
  const magic = readMagic(candidate);
  if (targetPlatform === 'win32') return magic.subarray(0, 2).equals(Buffer.from('MZ'));
  if (targetPlatform === 'linux') return magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));

  // Mach-O thin, fat, and 64-bit variants. This is only a file-format check;
  // the verifier deliberately never loads the library or starts the player.
  return [
    'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
    'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
  ].some((value) => magic.equals(Buffer.from(value, 'hex')));
}

function filesUnder(rootPath) {
  const files = [];
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
      if (entry.isFile()) files.push(candidate);
      else if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(candidate);
    }
  }
  return files;
}

function findNamedFile(rootPath, name) {
  return filesUnder(rootPath).find((candidate) => path.basename(candidate) === name);
}

function sha256File(candidate) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(candidate, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function safeManifestPath(payloadRoot, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    fail(`${label} manifest contains a file entry without a relative path.`);
    return null;
  }
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) {
    fail(`${label} manifest contains an unsafe file path: ${relativePath}`);
    return null;
  }
  const candidate = path.resolve(payloadRoot, ...normalized.split('/'));
  const relative = path.relative(payloadRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} manifest escapes its payload directory: ${relativePath}`);
    return null;
  }
  return candidate;
}

function manifestFileEntries(manifest, label) {
  if (!Object.prototype.hasOwnProperty.call(manifest, 'files')) return [];
  if (Array.isArray(manifest.files)) return manifest.files;
  if (manifest.files && typeof manifest.files === 'object') {
    return Object.entries(manifest.files).map(([filePath, sha256]) => ({ path: filePath, sha256 }));
  }
  fail(`${label} runtime manifest "files" must be an array or object.`);
  return [];
}

function verifyOptionalHashManifest(payloadRoot, label, targetPlatform, targetArch) {
  const manifestPath = path.join(payloadRoot, 'runtime-manifest.json');
  if (!exists(manifestPath)) return;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`Invalid ${label} runtime manifest ${manifestPath}: ${String(error)}`);
    return;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`${label} runtime manifest must contain a JSON object: ${manifestPath}`);
    return;
  }
  if (manifest.manifestVersion !== undefined && manifest.manifestVersion !== 1) {
    fail(`${label} runtime manifest has unsupported manifestVersion: ${manifest.manifestVersion}`);
  }
  const declaredPlatform = manifest.platform ?? manifest.targetPlatform;
  if (declaredPlatform !== undefined && platformToken(String(declaredPlatform).toLowerCase()) !== targetPlatform) {
    fail(`${label} runtime manifest platform does not match ${targetPlatform}: ${declaredPlatform}`);
  }
  const declaredArch = manifest.architecture ?? manifest.arch;
  if (declaredArch !== undefined && architectureToken(String(declaredArch).toLowerCase()) !== targetArch) {
    fail(`${label} runtime manifest architecture does not match ${targetArch}: ${declaredArch}`);
  }

  for (const entry of manifestFileEntries(manifest, label)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${label} runtime manifest contains an invalid file entry.`);
      continue;
    }
    const filePath = safeManifestPath(payloadRoot, entry.path ?? entry.relativePath, label);
    if (!filePath || !regularFile(filePath)) {
      if (filePath) fail(`${label} runtime manifest references a missing file: ${entry.path || entry.relativePath}`);
      continue;
    }
    if (entry.sha256 === undefined || entry.sha256 === null) continue;
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      fail(`${label} runtime manifest has an invalid SHA-256 value: ${entry.path || entry.relativePath}`);
      continue;
    }
    const actual = sha256File(filePath);
    if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
      fail(`${label} SHA-256 mismatch for ${entry.path || entry.relativePath}: expected ${entry.sha256}, got ${actual}`);
    }
  }
}

function nativePayloadRoot(component) {
  return path.join(
    resources,
    component,
    selectedRuntimePlatform,
    selectedRuntimeArch,
  );
}

function verifyNativeFile(candidate, label, targetPlatform, executable) {
  if (!regularFile(candidate)) {
    fail(`Missing ${label}: ${candidate}`);
    return false;
  }
  if (executable && targetPlatform !== 'win32' && (fs.statSync(candidate).mode & 0o111) === 0) {
    fail(`${label} is not marked executable: ${candidate}`);
  }
  try {
    if (!hasExpectedNativeMagic(candidate, targetPlatform)) {
      fail(`${label} does not have the expected ${targetPlatform} binary format: ${candidate}`);
    }
  } catch (error) {
    fail(`Could not inspect ${label}: ${candidate}: ${String(error)}`);
  }
  return true;
}

function pluginDirectories(libraryPath, payloadRoot) {
  const libraryDirectory = path.dirname(libraryPath);
  return [...new Set([
    path.join(libraryDirectory, 'plugins'),
    path.join(libraryDirectory, 'Plugins'),
    path.resolve(libraryDirectory, '..', 'plugins'),
    path.resolve(libraryDirectory, '..', 'Plugins'),
    path.resolve(libraryDirectory, '..', '..', 'plugins'),
    path.resolve(libraryDirectory, '..', '..', 'Plugins'),
    path.join(payloadRoot, 'plugins'),
    path.join(payloadRoot, 'Plugins'),
  ])];
}

function verifyLibVlcPayload(targetPlatform, targetArch) {
  const payloadRoot = nativePayloadRoot('libvlc');
  if (!directory(payloadRoot)) {
    fail(`Missing LibVLC payload directory for ${targetPlatform}/${targetArch}: ${payloadRoot}`);
    return;
  }
  const libraryName = nativeLibraryName(targetPlatform);
  const libraryPath = findNamedFile(payloadRoot, libraryName);
  if (!libraryPath) {
    fail(`Missing bundled LibVLC library for ${targetPlatform}/${targetArch}: ${path.join(payloadRoot, libraryName)}`);
    return;
  }
  verifyNativeFile(libraryPath, 'bundled LibVLC library', targetPlatform, false);

  const pluginsPath = pluginDirectories(libraryPath, payloadRoot).find(directory);
  if (!pluginsPath) {
    fail(`Missing LibVLC plugins directory beside ${libraryPath}. Expected a plugins directory in ${payloadRoot}.`);
  } else {
    const pluginFiles = filesUnder(pluginsPath);
    const extension = targetPlatform === 'win32' ? /\.dll$/i : targetPlatform === 'darwin' ? /\.dylib$/i : /\.so(?:\.|$)/i;
    if (!pluginFiles.some((candidate) => extension.test(candidate))) {
      fail(`LibVLC plugins directory contains no ${targetPlatform} plugin modules: ${pluginsPath}`);
    }
    if (!pluginFiles.some((candidate) => path.basename(candidate).toLowerCase() === 'plugins.dat')) {
      fail(`LibVLC plugins directory is missing plugins.dat: ${pluginsPath}`);
    }
  }
  verifyOptionalHashManifest(payloadRoot, 'LibVLC', targetPlatform, targetArch);
}

function verifyMpvPayload(targetPlatform, targetArch) {
  const payloadRoot = nativePayloadRoot('mpv');
  if (!directory(payloadRoot)) {
    fail(`Missing MPV payload directory for ${targetPlatform}/${targetArch}: ${payloadRoot}`);
    return;
  }
  const executableName = nativeExecutableName(targetPlatform);
  const executablePath = findNamedFile(payloadRoot, executableName);
  if (!executablePath) {
    fail(`Missing bundled MPV executable for ${targetPlatform}/${targetArch}: ${path.join(payloadRoot, executableName)}`);
  } else {
    verifyNativeFile(executablePath, 'bundled MPV executable', targetPlatform, true);
  }
  verifyOptionalHashManifest(payloadRoot, 'MPV', targetPlatform, targetArch);
}

const packageDir = packageDirCandidates().find((candidate) => exists(resourcesDir(candidate))) || packageDirCandidates()[0];
const resources = resourcesDir(packageDir);
const appAsar = path.join(resources, 'app.asar');
const unpacked = path.join(resources, 'app.asar.unpacked');

const targetPlatform = platformToken(selectedRuntimePlatform);
const targetArch = architectureToken(selectedRuntimeArch);
if (!['darwin', 'win32', 'linux'].includes(targetPlatform)) {
  fail(`Unsupported native runtime platform: ${selectedRuntimePlatform}`);
}
if (!['arm64', 'x64', 'ia32', 'arm'].includes(targetArch)) {
  fail(`Unsupported native runtime architecture: ${selectedRuntimeArch}`);
}

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
  '/node_modules/koffi/index.cjs',
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
const libVlcNotice = path.join(resources, 'libvlc', 'NOTICE.md');
const mpvNotice = path.join(resources, 'mpv', 'NOTICE.md');

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
  || runtimeManifest.distributionPolicy?.mpvBundled !== true
  || !Array.isArray(runtimeManifest.distributionPolicy?.bundledNativePlaybackTargets?.libvlc)
  || !Array.isArray(runtimeManifest.distributionPolicy?.bundledNativePlaybackTargets?.mpv)
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

if (!exists(libVlcNotice)) {
  fail(`Missing LibVLC distribution notice. Checked ${libVlcNotice}`);
}

if (!exists(mpvNotice)) {
  fail(`Missing MPV distribution notice. Checked ${mpvNotice}`);
}

// Native payload verification is intentionally filesystem-only. It checks the
// selected platform/architecture, file formats, plugin layout, and optional
// hashes; it never requires, dlopens, or launches LibVLC or MPV.
const selectedNativeRuntimeTarget = `${targetPlatform}-${targetArch}`;
const bundledNativePlaybackTargets = runtimeManifest?.distributionPolicy?.bundledNativePlaybackTargets;
if (bundledNativePlaybackTargets?.libvlc.includes(selectedNativeRuntimeTarget)) {
  verifyLibVlcPayload(targetPlatform, targetArch);
}
if (bundledNativePlaybackTargets?.mpv.includes(selectedNativeRuntimeTarget)) {
  verifyMpvPayload(targetPlatform, targetArch);
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
