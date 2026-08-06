'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const RESOURCES_ROOT = path.join(DESKTOP_ROOT, 'resources');
const RUNTIME_PROVENANCE_PATH = path.join(RESOURCES_ROOT, 'ffmpeg', 'runtime-provenance.json');
const ENGINES = ['libvlc', 'mpv'];
const MARKER_NAME = '.loomtv-native-runtime-staging.json';
const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64', 'ia32', 'arm']);

const USAGE = `
Native runtime staging is explicit and offline.

Required source-root layout:
  <source-root>/<platform>-<arch>/mpv/
  <source-root>/darwin-<arch>/libvlc/   # LibVLC is currently macOS-only

Set LOOMTV_NATIVE_RUNTIME_SOURCE_ROOT to an absolute source-root and select
targets with LOOMTV_NATIVE_RUNTIME_TARGETS (comma-separated), or use the
single-target overrides LOOMTV_LIBVLC_SOURCE_DIR and
LOOMTV_MPV_SOURCE_DIR. The MPV override is required; the LibVLC override is
also required for a darwin target. These overrides must be absolute and must
be used with exactly one target.

The output layout is resources/<engine>/<platform>/<arch>, which matches the
existing desktop runtime discovery code. No source is downloaded, executed,
or inferred from PATH/system installation. With no source variables and no
--required flag, this script leaves the development resource tree unchanged.
`;

function valueFromEnvironment(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseArguments(argv) {
  const result = { required: false, target: undefined, targets: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--required') {
      result.required = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    const match = /^(--target|--targets)=(.+)$/.exec(argument);
    if (match) {
      const key = match[1] === '--target' ? 'target' : 'targets';
      if (result[key]) throw new Error(`Only one ${match[1]} value may be provided.`);
      result[key] = match[2].trim();
      continue;
    }
    if (argument === '--target' || argument === '--targets') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value.`);
      index += 1;
      const key = argument === '--target' ? 'target' : 'targets';
      if (result[key]) throw new Error(`Only one ${argument} value may be provided.`);
      result[key] = value.trim();
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.target && result.targets) throw new Error('--target and --targets are mutually exclusive.');
  return result;
}

function normalizeTarget(value) {
  const parts = String(value || '').trim().split('-');
  if (parts.length !== 2 || !SUPPORTED_PLATFORMS.has(parts[0]) || !SUPPORTED_ARCHITECTURES.has(parts[1])) {
    throw new Error(`Invalid native runtime target "${value}". Use <platform>-<arch>, for example darwin-arm64, win32-x64, or linux-x64.`);
  }
  return { platform: parts[0], arch: parts[1], label: `${parts[0]}-${parts[1]}` };
}

function selectedTargets(argumentsConfig) {
  const environmentTargets = valueFromEnvironment('LOOMTV_NATIVE_RUNTIME_TARGETS');
  if ((argumentsConfig.target || argumentsConfig.targets) && environmentTargets) {
    throw new Error('Choose either --target/--targets or LOOMTV_NATIVE_RUNTIME_TARGETS, not both.');
  }

  const rawTargets = argumentsConfig.target
    || argumentsConfig.targets
    || environmentTargets
    || `${valueFromEnvironment('LOOMTV_NATIVE_RUNTIME_PLATFORM') || valueFromEnvironment('npm_config_platform') || process.platform}-${valueFromEnvironment('LOOMTV_NATIVE_RUNTIME_ARCH') || valueFromEnvironment('npm_config_arch') || process.arch}`;
  const values = rawTargets.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error('At least one native runtime target is required.');

  const targets = values.map(normalizeTarget);
  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target.label)) throw new Error(`Duplicate native runtime target: ${target.label}`);
    seen.add(target.label);
  }
  return targets;
}

function absoluteDirectory(value, label) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute directory path.`);
  let stats;
  try {
    stats = fs.lstatSync(value);
  } catch (error) {
    throw new Error(`${label} does not exist: ${value}`, { cause: error });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a file or symlink: ${value}`);
  }
  // macOS commonly aliases /tmp to /private/tmp. Canonicalize the directory
  // before validating internal symlinks so that an ordinary versioned dylib
  // link is not mistaken for a link escaping the supplied source root.
  return path.resolve(fs.realpathSync(value));
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function validatePayload(source, label) {
  const pending = [source];
  let fileCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Could not inspect ${label}: ${current}`, { cause: error });
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        let resolved;
        try {
          resolved = fs.realpathSync(candidate);
        } catch (error) {
          throw new Error(`${label} contains a broken symlink: ${candidate}`, { cause: error });
        }
        if (!isWithin(source, resolved)) {
          throw new Error(`${label} contains a symlink outside its source root: ${candidate}`);
        }
        const linkedStats = fs.statSync(candidate);
        if (linkedStats.isDirectory()) pending.push(candidate);
        else if (linkedStats.isFile()) fileCount += 1;
        else throw new Error(`${label} contains an unsupported symlink target: ${candidate}`);
      } else if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile()) {
        fileCount += 1;
      } else {
        throw new Error(`${label} contains an unsupported filesystem entry: ${candidate}`);
      }
    }
  }
  if (fileCount === 0) throw new Error(`${label} is empty: ${source}`);
}

function filesUnder(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isFile()) files.push(candidate);
      else if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return files.sort();
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

function sourceFor(root, target, engine) {
  return path.join(root, target.label, engine);
}

function copyPayloadDeref(source, destination, sourceRoot) {
  const stats = fs.lstatSync(source);
  if (stats.isSymbolicLink()) {
    const resolved = fs.realpathSync(source);
    if (!isWithin(sourceRoot, resolved)) {
      throw new Error(`Native runtime symlink escapes its source root: ${source}`);
    }
    copyPayloadDeref(resolved, destination, sourceRoot);
    return;
  }

  if (stats.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: stats.mode & 0o7777 });
    for (const entry of fs.readdirSync(source)) {
      copyPayloadDeref(path.join(source, entry), path.join(destination, entry), sourceRoot);
    }
    return;
  }

  if (!stats.isFile()) {
    throw new Error(`Native runtime contains an unsupported filesystem entry: ${source}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, stats.mode & 0o7777);
  fs.utimesSync(destination, stats.atime, stats.mtime);
}

function enginesForTarget(target) {
  // LoomTV's LibVLC surface is currently wired only for macOS. MPV remains
  // the native engine available on the other desktop targets.
  return target.platform === 'darwin' ? ENGINES : ['mpv'];
}

function bundledTargetsByEngine() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(RUNTIME_PROVENANCE_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read native runtime distribution policy: ${RUNTIME_PROVENANCE_PATH}`, { cause: error });
  }

  const configured = manifest?.distributionPolicy?.bundledNativePlaybackTargets;
  const result = new Map();
  for (const engine of ENGINES) {
    const targets = configured?.[engine];
    if (!Array.isArray(targets) || targets.some((target) => typeof target !== 'string')) {
      throw new Error(`Native runtime distribution policy must declare bundledNativePlaybackTargets.${engine} as an array.`);
    }
    result.set(engine, new Set(targets.map((target) => normalizeTarget(target).label)));
  }
  return result;
}

function directSources(targets) {
  const libvlc = valueFromEnvironment('LOOMTV_LIBVLC_SOURCE_DIR');
  const mpv = valueFromEnvironment('LOOMTV_MPV_SOURCE_DIR');
  if (!libvlc && !mpv) return undefined;
  if (!mpv) {
    throw new Error('LOOMTV_MPV_SOURCE_DIR is required when using per-engine source overrides.');
  }
  if (targets.some((target) => target.platform === 'darwin') && !libvlc) {
    throw new Error('LOOMTV_LIBVLC_SOURCE_DIR is required for a darwin target when using per-engine source overrides.');
  }
  if (targets.length !== 1) {
    throw new Error('The per-engine source overrides support exactly one native runtime target.');
  }
  return { libvlc, mpv };
}

function existingGeneratedDestination(destination, engine, target) {
  if (!fs.existsSync(destination)) return;
  let stats;
  try {
    stats = fs.lstatSync(destination);
  } catch (error) {
    throw new Error(`Could not inspect existing staging destination: ${destination}`, { cause: error });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite a non-directory staging destination: ${destination}`);
  }

  const markerPath = path.join(destination, MARKER_NAME);
  if (!fs.existsSync(markerPath)) {
    throw new Error(`Refusing to overwrite unmanaged files in ${destination}. Remove them or choose a clean target.`);
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid staging marker in ${destination}: ${String(error)}`, { cause: error });
  }
  if (marker?.engine !== engine || marker?.target !== target.label) {
    throw new Error(`Staging marker does not match ${engine}/${target.label}: ${destination}`);
  }
}

function stagePayload(source, destination, engine, target, sourceMode) {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const temporaryParent = fs.mkdtempSync(path.join(parent, '.loomtv-native-runtime-'));
  const temporaryPayload = path.join(temporaryParent, 'payload');
  try {
    // Native app bundles commonly use symlinks for versioned dylibs. They are
    // accepted only when they resolve within the explicitly supplied source
    // root, then copied as ordinary files into the deterministic payload.
    copyPayloadDeref(source, temporaryPayload, source);
    fs.writeFileSync(
      path.join(temporaryPayload, MARKER_NAME),
      `${JSON.stringify({
        schemaVersion: 1,
        engine,
        target: target.label,
        layout: `resources/${engine}/${target.platform}/${target.arch}`,
        sourceMode,
      }, null, 2)}\n`,
      'utf8',
    );
    const files = filesUnder(temporaryPayload)
      .filter((candidate) => path.basename(candidate) !== 'runtime-manifest.json')
      .map((candidate) => ({
        path: path.relative(temporaryPayload, candidate).split(path.sep).join('/'),
        sha256: sha256File(candidate),
      }));
    fs.writeFileSync(
      path.join(temporaryPayload, 'runtime-manifest.json'),
      `${JSON.stringify({
        manifestVersion: 1,
        engine,
        platform: target.platform,
        architecture: target.arch,
        files,
      }, null, 2)}\n`,
      'utf8',
    );
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(temporaryPayload, destination);
  } finally {
    fs.rmSync(temporaryParent, { recursive: true, force: true });
  }
}

function main() {
  const argumentsConfig = parseArguments(process.argv.slice(2));
  if (argumentsConfig.help) {
    console.log(USAGE.trim());
    return;
  }

  const sourceRootValue = valueFromEnvironment('LOOMTV_NATIVE_RUNTIME_SOURCE_ROOT');
  const targets = selectedTargets(argumentsConfig);
  const direct = directSources(targets);
  if (sourceRootValue && direct) {
    throw new Error('Choose either LOOMTV_NATIVE_RUNTIME_SOURCE_ROOT or the per-engine source overrides, not both.');
  }
  const sourceMode = sourceRootValue ? 'source-root' : 'per-engine';
  const sourceRoot = sourceRootValue ? absoluteDirectory(sourceRootValue, 'LOOMTV_NATIVE_RUNTIME_SOURCE_ROOT') : undefined;
  if (sourceRoot && isWithin(RESOURCES_ROOT, sourceRoot)) {
    throw new Error(`The native runtime source root must be outside the repository resources tree: ${sourceRoot}`);
  }

  if (!sourceRoot && !direct) {
    if (!argumentsConfig.required) {
      console.log('No native runtime sources configured; leaving the development resource tree unchanged.');
      return;
    }

    const bundledTargets = bundledTargetsByEngine();
    const missing = [];
    const requiredPayloads = [];
    for (const target of targets) {
      for (const engine of enginesForTarget(target)) {
        if (!bundledTargets.get(engine)?.has(target.label)) continue;
        requiredPayloads.push(`${engine}/${target.label}`);
        const destination = path.join(RESOURCES_ROOT, engine, target.platform, target.arch);
        try {
          existingGeneratedDestination(destination, engine, target);
          if (filesUnder(destination).filter((candidate) => path.basename(candidate) !== 'runtime-manifest.json').length === 0) {
            missing.push(`${engine}/${target.label}`);
          }
        } catch {
          missing.push(`${engine}/${target.label}`);
        }
      }
    }
    if (missing.length > 0) {
      throw new Error(`Native runtime sources are required for packaging, and no generated staged payload exists for:\n${missing.join('\n')}\n${USAGE.trim()}`);
    }
    if (requiredPayloads.length === 0) {
      console.log(`No bundled native playback payload is configured for ${targets.map((target) => target.label).join(', ')}; packaging the authorized browser fallback.`);
      return;
    }
    console.log(`No native runtime sources configured; using existing staged payloads for ${requiredPayloads.join(', ')}.`);
    return;
  }

  const jobs = [];
  for (const target of targets) {
    for (const engine of enginesForTarget(target)) {
      const rawSource = sourceRoot ? sourceFor(sourceRoot, target, engine) : direct[engine];
      const source = absoluteDirectory(rawSource, `${engine} source for ${target.label}`);
      if (isWithin(RESOURCES_ROOT, source)) {
        throw new Error(`${engine} source for ${target.label} must be outside the repository resources tree: ${source}`);
      }
      validatePayload(source, `${engine} source for ${target.label}`);
      const destination = path.join(RESOURCES_ROOT, engine, target.platform, target.arch);
      existingGeneratedDestination(destination, engine, target);
      jobs.push({ source, destination, engine, target });
    }
  }

  for (const job of jobs) stagePayload(job.source, job.destination, job.engine, job.target, sourceMode);
  console.log(`Staged native playback payloads for ${targets.map((target) => target.label).join(', ')}.`);
}

try {
  main();
} catch (error) {
  console.error(`[native-runtime-staging] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
