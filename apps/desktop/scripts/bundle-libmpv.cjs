'use strict';

// Maintainer tool: build a self-contained libmpv runtime for macOS arm64.
//
// Homebrew's libmpv links to about 50 other Homebrew libraries by absolute
// path, so a copy of it alone fails to load on a Mac without Homebrew. This
// script copies libmpv and its whole non-system dependency closure into one
// directory, points every reference at a neighbouring file, re-signs the
// results ad hoc, builds LoomTV's render bridge beside them, and verifies that
// loading libmpv touches nothing outside that directory.
//
// The output is packed into the libmpv runtime archive listed in
// native-runtimes.json. Builds download that archive; they never run this.
//
// Usage: node scripts/bundle-libmpv.cjs [output-directory]

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(DESKTOP_ROOT, 'resources', 'mpv', 'lib');
const LIBRARY_NAME = 'libmpv.dylib';
const BRIDGE_NAME = 'libloomtv_mpv_bridge.dylib';
const INVENTORY_NAME = 'libmpv-inventory.json';
const FOREIGN_PREFIXES = ['/opt/homebrew/', '/usr/local/'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function installId(file) {
  const lines = run('otool', ['-D', file]).trim().split('\n');
  return lines.length > 1 ? lines[lines.length - 1].trim() : null;
}

function references(file) {
  const own = installId(file);
  return run('otool', ['-L', file]).split('\n').slice(1)
    .map((line) => line.trim().split(' (')[0])
    .filter((reference) => reference && reference !== own);
}

function rpaths(file) {
  const lines = run('otool', ['-l', file]).split('\n');
  const found = [];
  lines.forEach((line, index) => {
    if (line.includes('cmd LC_RPATH')) found.push(lines[index + 2].trim().split(' ')[1]);
  });
  return found;
}

function isSystem(reference) {
  return reference.startsWith('/usr/lib/') || reference.startsWith('/System/');
}

function resolveReference(reference, from) {
  const directory = path.dirname(from);
  if (reference.startsWith('@loader_path/')) return fs.realpathSync(path.join(directory, reference.slice('@loader_path/'.length)));
  if (reference.startsWith('@rpath/')) {
    const name = reference.slice('@rpath/'.length);
    for (const rpath of [...rpaths(from), '/opt/homebrew/lib']) {
      const candidate = path.join(rpath.replace('@loader_path', directory), name);
      if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    }
    throw new Error(`Could not resolve ${reference} from ${from}`);
  }
  return fs.realpathSync(reference);
}

function dependencyClosure(root) {
  const order = [];
  const seen = new Set();
  const queue = [fs.realpathSync(root)];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    order.push(file);
    for (const reference of references(file)) {
      if (!isSystem(reference)) queue.push(resolveReference(reference, file));
    }
  }
  return order;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function cellarOrigin(file) {
  const match = /\/Cellar\/([^/]+)\/([^/]+)\//.exec(file);
  return match ? { formula: match[1], version: match[2] } : { formula: null, version: null };
}

function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('bundle-libmpv.cjs builds the macOS arm64 runtime and must run on an Apple silicon Mac.');
  }
  const library = process.env.LOOMTV_LIBMPV_PATH?.trim() || '/opt/homebrew/lib/libmpv.dylib';
  const include = process.env.LIBMPV_INCLUDE_DIR?.trim() || '/opt/homebrew/include';
  if (!fs.existsSync(library) || !fs.existsSync(path.join(include, 'mpv', 'client.h'))) {
    throw new Error('Install mpv with Homebrew (brew install mpv) or set LOOMTV_LIBMPV_PATH and LIBMPV_INCLUDE_DIR.');
  }
  const output = path.resolve(process.argv[2] || DEFAULT_OUTPUT);

  const closure = dependencyClosure(library);
  // Every library is stored under the file name its dependents refer to.
  const nameFor = new Map();
  const usedNames = new Set();
  closure.forEach((file, index) => {
    const id = installId(file);
    const name = index === 0 ? LIBRARY_NAME : path.basename(id || file);
    if (usedNames.has(name)) throw new Error(`Two dependencies share the file name ${name}.`);
    usedNames.add(name);
    nameFor.set(file, name);
  });

  const staging = `${output}.bundle-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    const inventory = [];
    for (const source of closure) {
      const name = nameFor.get(source);
      const target = path.join(staging, name);
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o755);
      const changes = references(source)
        .filter((reference) => !isSystem(reference))
        .flatMap((reference) => ['-change', reference, `@loader_path/${nameFor.get(resolveReference(reference, source))}`]);
      const removeRpaths = rpaths(source).flatMap((rpath) => ['-delete_rpath', rpath]);
      run('install_name_tool', ['-id', `@rpath/${name}`, ...changes, ...removeRpaths, target]);
      run('codesign', ['--force', '--sign', '-', target]);
      inventory.push({ file: name, ...cellarOrigin(source), sourceFile: path.basename(source) });
    }

    run(process.execPath, [path.join(DESKTOP_ROOT, 'native', 'libmpv', 'render-bridge', 'build.mjs'), path.join(staging, BRIDGE_NAME)], {
      env: { ...process.env, LIBMPV_INCLUDE_DIR: include },
    });

    verifyBundle(staging, usedNames);

    for (const entry of inventory) entry.sha256 = sha256(path.join(staging, entry.file));
    const minimumMacOS = /minos (\S+)/.exec(run('otool', ['-l', path.join(staging, LIBRARY_NAME)]))?.[1] || null;
    fs.writeFileSync(path.join(staging, INVENTORY_NAME), `${JSON.stringify({
      manifestVersion: 1,
      library: LIBRARY_NAME,
      bridge: { file: BRIDGE_NAME, sha256: sha256(path.join(staging, BRIDGE_NAME)) },
      minimumMacOS,
      files: inventory,
    }, null, 2)}\n`);

    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(staging, output);
    console.log(`[libmpv] Bundled ${closure.length} libraries and the bridge into ${output} (minimum macOS ${minimumMacOS}).`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function verifyBundle(directory, names) {
  for (const name of names) {
    const file = path.join(directory, name);
    for (const reference of references(file)) {
      if (isSystem(reference)) continue;
      const local = reference.startsWith('@loader_path/') ? reference.slice('@loader_path/'.length) : null;
      if (!local || !names.has(local)) throw new Error(`${name} still refers to ${reference}.`);
    }
    if (rpaths(file).length > 0) throw new Error(`${name} still carries LC_RPATH entries.`);
    run('codesign', ['--verify', file]);
  }

  // Load libmpv in a fresh process and record every image dyld maps. System
  // binaries such as /usr/bin/python3 drop DYLD_* variables, so compile a
  // small loader instead.
  const probeDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'loomtv-libmpv-probe-'));
  try {
    const source = path.join(probeDirectory, 'probe.c');
    const binary = path.join(probeDirectory, 'probe');
    fs.writeFileSync(source, [
      '#include <dlfcn.h>',
      '#include <stdio.h>',
      'int main(int argc, char **argv) {',
      '  void *handle = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);',
      '  if (!handle) { fprintf(stderr, "%s\\n", dlerror()); return 1; }',
      '  unsigned long (*version)(void) = (unsigned long (*)(void))dlsym(handle, "mpv_client_api_version");',
      '  if (!version) return 2;',
      '  printf("api %lu\\n", version());',
      '  return 0;',
      '}',
    ].join('\n'));
    run('xcrun', ['clang', '-o', binary, source]);
    const result = spawnSync(binary, [path.join(directory, LIBRARY_NAME)], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', DYLD_PRINT_LIBRARIES: '1' },
    });
    if (result.status !== 0) throw new Error(`The bundled libmpv did not load: ${result.stderr}`);
    const loaded = result.stderr.split('\n').filter((line) => line.includes('.dylib'));
    if (!loaded.some((line) => line.includes(path.join(directory, LIBRARY_NAME)))) {
      throw new Error('dyld did not report loading the bundled libmpv, so the isolation check cannot be trusted.');
    }
    const foreign = loaded.filter((line) => FOREIGN_PREFIXES.some((prefix) => line.includes(prefix)));
    if (foreign.length > 0) throw new Error(`Loading libmpv pulled in libraries outside the bundle:\n${foreign.join('\n')}`);
    if (!/^api \d+/m.test(result.stdout)) throw new Error('The bundled libmpv loaded but did not report an API version.');
  } finally {
    fs.rmSync(probeDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`[libmpv] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
