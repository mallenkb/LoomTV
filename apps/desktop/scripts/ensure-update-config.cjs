const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildScanner } = require('./build-scanner.cjs');
const { stageDatachannel } = require('./stage-datachannel.cjs');
const { UPDATE_CONFIG } = require('../../../scripts/release-identity.cjs');

function resourcesPath(appOutDir, platform) {
  if (platform === 'darwin') {
    const appBundle = fs.readdirSync(appOutDir, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
    if (!appBundle) throw new Error(`No macOS app bundle found under ${appOutDir}.`);
    return path.join(appOutDir, appBundle.name, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

// libmpv is bundled only for the targets listed in the runtime distribution
// policy. The Mac extraResources copy mpv/lib into every Mac build, so remove it
// from architectures that cannot load it (Intel Macs use LibVLC, then HLS).
function pruneUnsupportedLibMpv(resources, platform, arch) {
  const provenance = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'ffmpeg', 'runtime-provenance.json'), 'utf8'));
  const targets = provenance.distributionPolicy?.bundledNativePlaybackTargets?.mpv || [];
  if (targets.includes(`${platform}-${arch}`)) return;
  const libmpv = path.join(resources, 'mpv', 'lib');
  if (fs.existsSync(libmpv)) {
    fs.rmSync(libmpv, { recursive: true, force: true });
    console.log(`[libmpv] Removed mpv/lib from the ${platform}-${arch} package; libmpv is bundled only for ${targets.join(', ') || 'no targets'}.`);
  }
}

// The FFmpeg and fpcalc archives are universal binaries, but each Mac package
// targets one architecture. Keep only that slice; the other half is ~150 MB of
// x86_64 code an Apple silicon build never runs (and the reverse on Intel).
// This runs before signing, so codesign seals the thinned files.
function thinMacUniversalBinaries(resources, platform, arch) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) return;
  const slice = arch === 'x64' ? 'x86_64' : arch;
  for (const relative of ['ffmpeg/mac/ffmpeg', 'ffmpeg/mac/ffprobe', 'fpcalc/mac/fpcalc']) {
    const binary = path.join(resources, relative);
    if (!fs.existsSync(binary)) continue;
    const archs = execFileSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' }).trim().split(/\s+/);
    if (archs.length < 2) continue;
    if (!archs.includes(slice)) throw new Error(`${relative} has no ${slice} slice (found ${archs.join(', ')}).`);
    const thinned = `${binary}.thin`;
    execFileSync('/usr/bin/lipo', [binary, '-thin', slice, '-output', thinned]);
    fs.chmodSync(thinned, fs.statSync(binary).mode);
    fs.renameSync(thinned, binary);
    console.log(`[runtimes] Thinned ${relative} to ${slice}.`);
  }
}

// pnpm installs the optional native packages for both Mac architectures, and
// better-sqlite3 keeps its compile inputs (a 9 MB sqlite3.c) next to the addon.
// Neither is loaded at runtime.
function pruneUnpackedNativeModules(resources, platform, arch) {
  const modules = path.join(resources, 'app.asar.unpacked', 'node_modules');
  if (!fs.existsSync(modules)) return;
  const removed = [];
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
    const otherArch = arch === 'arm64' ? 'x64' : 'arm64';
    for (const scope of ['@img', '@koromix']) {
      const scopeDirectory = path.join(modules, scope);
      if (!fs.existsSync(scopeDirectory)) continue;
      for (const entry of fs.readdirSync(scopeDirectory)) {
        if (entry.endsWith(`-darwin-${otherArch}`)) removed.push(path.join(scopeDirectory, entry));
      }
    }
  }
  const sqliteBuild = path.join(modules, 'better-sqlite3', 'build');
  removed.push(
    path.join(sqliteBuild, 'Release', 'obj'),
    path.join(sqliteBuild, 'Release', 'test_extension.node'),
    path.join(sqliteBuild, 'deps'),
  );
  for (const target of removed) {
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[native-modules] Removed ${path.relative(modules, target)} from the ${platform}-${arch} package.`);
  }
}

exports.default = async function ensureUpdateConfig(context) {
  const platform = context.electronPlatformName;
  const arch = typeof context.arch === 'string' ? context.arch : { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch];
  const binary = buildScanner(platform, arch);
  const scannerDirectory = path.join(resourcesPath(context.appOutDir, platform), 'scanner', `${platform}-${arch}`);
  fs.mkdirSync(scannerDirectory, { recursive: true });
  fs.copyFileSync(binary, path.join(scannerDirectory, path.basename(binary)));
  fs.chmodSync(path.join(scannerDirectory, path.basename(binary)), 0o755);
  for (const entry of fs.readdirSync(path.dirname(scannerDirectory), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== `${platform}-${arch}`) {
      fs.rmSync(path.join(path.dirname(scannerDirectory), entry.name), { recursive: true, force: true });
    }
  }
  pruneUnsupportedLibMpv(resourcesPath(context.appOutDir, platform), platform, arch);
  thinMacUniversalBinaries(resourcesPath(context.appOutDir, platform), platform, arch);
  pruneUnpackedNativeModules(resourcesPath(context.appOutDir, platform), platform, arch);
  await stageDatachannel(resourcesPath(context.appOutDir, platform), platform, arch);
  const target = path.join(resourcesPath(context.appOutDir, context.electronPlatformName), 'app-update.yml');
  const hadExistingConfig = fs.existsSync(target);
  const actual = hadExistingConfig ? fs.readFileSync(target, 'utf8') : undefined;

  // Electron Builder may emit platform-specific formatting or defaults before
  // this hook runs. The release identity is owned by LoomTV, so normalize the
  // generated file instead of failing the entire package on harmless differences.
  if (actual !== UPDATE_CONFIG) {
    fs.writeFileSync(target, UPDATE_CONFIG, 'utf8');
    console.log(
      `[updates] ${hadExistingConfig ? 'Normalized' : 'Wrote'} packaged update configuration to ${target}`,
    );
  }
};

exports.thinMacUniversalBinaries = thinMacUniversalBinaries;
exports.pruneUnpackedNativeModules = pruneUnpackedNativeModules;
