'use strict';

// The libmpv render bridge is LoomTV source, so builds compile it rather than
// take the copy inside the downloaded libmpv runtime archive. That copy is only
// as new as the archive: 2.0.19 shipped a version 1 bridge from runtimes-2026-09
// after the host moved to version 2, and packaged builds lost libmpv.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const BRIDGE_ROOT = path.join(DESKTOP_ROOT, 'native', 'libmpv', 'render-bridge');
const BRIDGE_NAME = 'libloomtv_mpv_bridge.dylib';
const INVENTORY_NAME = 'libmpv-inventory.json';

function expectedBridgeVersion() {
  const header = fs.readFileSync(path.join(BRIDGE_ROOT, 'bridge.h'), 'utf8');
  const match = /^#define LOOM_MPV_BRIDGE_VERSION (\d+)u?$/m.exec(header);
  if (!match) throw new Error('bridge.h does not define LOOM_MPV_BRIDGE_VERSION.');
  return Number(match[1]);
}

function sourceFiles(directory = BRIDGE_ROOT) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'build' ? [] : sourceFiles(candidate);
    return /\.(?:h|m|mjs)$/.test(entry.name) ? [candidate] : [];
  }).sort();
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceDigest() {
  const hash = crypto.createHash('sha256');
  for (const file of sourceFiles()) {
    hash.update(path.relative(BRIDGE_ROOT, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

function minimumMacOS(libraryDirectory) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(libraryDirectory, INVENTORY_NAME), 'utf8')).minimumMacOS;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

// Compiles the bridge into libraryDirectory unless stampPath records a build of
// the current sources that is still the file on disk. Returns true if it built.
function ensureBridge(libraryDirectory, arch, stampPath) {
  const output = path.join(libraryDirectory, BRIDGE_NAME);
  const minimum = minimumMacOS(libraryDirectory);
  const wanted = { source: sourceDigest(), arch, minimumMacOS: minimum };
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (stamp.source === wanted.source && stamp.arch === arch && stamp.minimumMacOS === minimum
      && fs.existsSync(output) && sha256(output) === stamp.output) return false;
  } catch {}

  const result = spawnSync(process.execPath, [path.join(BRIDGE_ROOT, 'build.mjs'), output], {
    encoding: 'utf8',
    env: { ...process.env, LIBMPV_BRIDGE_ARCH: arch, ...(minimum ? { LIBMPV_BRIDGE_MIN_MACOS: minimum } : {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`The libmpv bridge did not build:\n${result.stderr || result.stdout}`);
  const digest = sha256(output);

  const inventoryPath = path.join(libraryDirectory, INVENTORY_NAME);
  if (fs.existsSync(inventoryPath)) {
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    inventory.bridge = { file: BRIDGE_NAME, sha256: digest, version: expectedBridgeVersion() };
    fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  }
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, `${JSON.stringify({ ...wanted, output: digest }, null, 2)}\n`);
  return true;
}

function expectedBridgeExports() {
  const header = fs.readFileSync(path.join(BRIDGE_ROOT, 'bridge.h'), 'utf8');
  return [...new Set([...header.matchAll(/\b(loom_mpv_\w+)\s*\(/g)].map((match) => match[1]))].sort();
}

function exportedSymbols(file) {
  const result = spawnSync('nm', ['-gU', file], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`nm could not read ${file}: ${result.stderr}`);
  return new Set(result.stdout.split('\n').map((line) => line.trim().split(/\s+/).pop()?.replace(/^_/, '')).filter(Boolean));
}

// Checks a libmpv payload directory without loading anything: the inventory
// must record a bridge of the version bridge.h declares, and the bridge must
// export every function bridge.h declares. There is no hash check because
// signing a package rewrites every dylib.
function bridgeProblems(libraryDirectory, listExports = exportedSymbols) {
  const bridgePath = path.join(libraryDirectory, BRIDGE_NAME);
  if (!fs.existsSync(bridgePath)) return [`Missing libmpv bridge: ${bridgePath}`];
  const problems = [];
  const expected = expectedBridgeVersion();
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(path.join(libraryDirectory, INVENTORY_NAME), 'utf8')).bridge;
  } catch (error) {
    problems.push(`Could not read ${INVENTORY_NAME}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (recorded?.version !== expected) {
    problems.push(`The libmpv bridge is version ${recorded?.version ?? 'unknown'}; the host requires ${expected}. Build it from native/libmpv/render-bridge (fetch-native-runtimes.cjs does this).`);
  }
  const exported = listExports(bridgePath);
  const missing = expectedBridgeExports().filter((name) => !exported.has(name));
  if (missing.length > 0) problems.push(`The libmpv bridge does not export ${missing.join(', ')}.`);
  return problems;
}

module.exports = { BRIDGE_NAME, bridgeProblems, ensureBridge, expectedBridgeExports, expectedBridgeVersion };
