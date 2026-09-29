'use strict';

// Download the native playback runtimes listed in native-runtimes.json,
// check each archive's SHA-256, and extract it under resources/.
//
// Archives are cached outside the repository, so a clean checkout or a wiped
// resources folder re-extracts without downloading again. A stamp per runtime
// records which archive is installed; a matching stamp skips the runtime.
//
// Environment:
//   LOOMTV_SKIP_NATIVE_RUNTIME_FETCH=1   keep whatever is in resources/ (local runtime work)
//   LOOMTV_NATIVE_RUNTIME_PLATFORM       fetch for another platform (darwin, win32, linux)
//   LOOMTV_NATIVE_RUNTIME_CACHE          archive cache directory

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const RESOURCES_ROOT = path.join(DESKTOP_ROOT, 'resources');
const MANIFEST_PATH = path.join(DESKTOP_ROOT, 'native-runtimes.json');
const STAMP_ROOT = path.join(RESOURCES_ROOT, '.native-runtime-stamps');
const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

function environmentValue(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cacheDirectory() {
  return environmentValue('LOOMTV_NATIVE_RUNTIME_CACHE')
    || path.join(os.homedir(), '.cache', 'loom-native-runtimes');
}

function readManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest.manifestVersion !== 1 || !Array.isArray(manifest.runtimes) || !/^https:\/\//.test(manifest.baseUrl || '')) {
    throw new Error(`Unsupported native runtime manifest: ${MANIFEST_PATH}`);
  }
  for (const runtime of manifest.runtimes) {
    if (!/^[a-z0-9-]+$/.test(runtime.id)
      || !/^[a-f0-9]{64}$/.test(runtime.sha256)
      || !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(runtime.archive)
      || !Number.isInteger(runtime.size)
      || !Array.isArray(runtime.requiredFiles)) {
      throw new Error(`Invalid native runtime entry: ${JSON.stringify(runtime)}`);
    }
    const destination = path.resolve(RESOURCES_ROOT, runtime.destination);
    if (!destination.startsWith(`${RESOURCES_ROOT}${path.sep}`)) {
      throw new Error(`Native runtime ${runtime.id} must extract inside resources/.`);
    }
  }
  return manifest;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function stampPath(runtime) {
  return path.join(STAMP_ROOT, `${runtime.id}.json`);
}

function isInstalled(runtime) {
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath(runtime), 'utf8'));
    if (stamp.sha256 !== runtime.sha256) return false;
  } catch {
    return false;
  }
  const destination = path.join(RESOURCES_ROOT, runtime.destination);
  return runtime.requiredFiles.every((file) => fs.existsSync(path.join(destination, file)));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function download(url, target, label) {
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) {
        const error = new Error(`Could not download ${label}: HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw error;
      }
      fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt === DOWNLOAD_ATTEMPTS) throw error;
      const delay = 1_000 * (2 ** (attempt - 1));
      console.warn(`[native-runtimes] Download attempt ${attempt} for ${label} failed; retrying in ${delay} ms.`);
      await sleep(delay);
    }
  }
  throw lastError;
}

async function verifiedArchive(manifest, runtime) {
  const cache = cacheDirectory();
  fs.mkdirSync(cache, { recursive: true });
  const cached = path.join(cache, `${runtime.sha256}-${runtime.archive}`);
  if (fs.existsSync(cached) && sha256File(cached) === runtime.sha256) return cached;

  const partial = `${cached}.${process.pid}.partial`;
  try {
    console.log(`[native-runtimes] Downloading ${runtime.archive} (${Math.round(runtime.size / 1_048_576)} MB).`);
    await download(`${manifest.baseUrl}${runtime.archive}`, partial, runtime.archive);
    const size = fs.statSync(partial).size;
    if (size !== runtime.size) throw new Error(`${runtime.archive} is ${size} bytes; expected ${runtime.size}.`);
    const digest = sha256File(partial);
    if (digest !== runtime.sha256) throw new Error(`Checksum mismatch for ${runtime.archive}: got ${digest}.`);
    fs.renameSync(partial, cached);
    return cached;
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

function tarCommand() {
  // Windows ships bsdtar in System32. Resolving it explicitly avoids picking up
  // Git's GNU tar, which cannot handle drive-letter paths.
  if (process.platform === 'win32') return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return 'tar';
}

function runTar(args) {
  const result = spawnSync(tarCommand(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function assertSafeEntries(archive) {
  for (const entry of runTar(['-tzf', archive]).split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`Refusing archive entry outside its destination: ${entry}`);
    }
  }
}

function copyInto(source, destination) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyInto(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, fs.statSync(from).mode & 0o7777);
    } else {
      throw new Error(`Unsupported archive entry: ${from}`);
    }
  }
}

function install(runtime, archive) {
  const destination = path.join(RESOURCES_ROOT, runtime.destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), `.native-runtime-${runtime.id}-`));
  try {
    assertSafeEntries(archive);
    const extracted = path.join(staging, 'payload');
    fs.mkdirSync(extracted);
    runTar(['-xzf', archive, '-C', extracted]);
    for (const file of runtime.requiredFiles) {
      if (!fs.existsSync(path.join(extracted, file))) throw new Error(`${runtime.archive} does not contain ${file}.`);
    }
    if (runtime.replaceDestination) {
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(extracted, destination);
    } else {
      fs.mkdirSync(destination, { recursive: true });
      copyInto(extracted, destination);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  fs.mkdirSync(STAMP_ROOT, { recursive: true });
  fs.writeFileSync(stampPath(runtime), `${JSON.stringify({ id: runtime.id, archive: runtime.archive, sha256: runtime.sha256 }, null, 2)}\n`);
}

async function main() {
  if (environmentValue('LOOMTV_SKIP_NATIVE_RUNTIME_FETCH') === '1') {
    console.log('[native-runtimes] LOOMTV_SKIP_NATIVE_RUNTIME_FETCH=1; leaving resources/ unchanged.');
    return;
  }
  const manifest = readManifest();
  const platform = environmentValue('LOOMTV_NATIVE_RUNTIME_PLATFORM') || process.platform;
  const runtimes = manifest.runtimes.filter((runtime) => runtime.platform === platform);
  if (runtimes.length === 0) {
    console.log(`[native-runtimes] No bundled native runtimes for ${platform}.`);
    return;
  }
  for (const runtime of runtimes) {
    if (isInstalled(runtime)) continue;
    const archive = await verifiedArchive(manifest, runtime);
    install(runtime, archive);
    console.log(`[native-runtimes] Installed ${runtime.id} into resources/${runtime.destination}.`);
  }
  console.log(`[native-runtimes] ${runtimes.length} runtime(s) for ${platform} match ${manifest.release}.`);
}

main().catch((error) => {
  console.error(`[native-runtimes] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
