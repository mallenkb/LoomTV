'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function capture(binary, arguments_) {
  const result = spawnSync(binary, arguments_, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${binary} ${arguments_.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout;
}

function run(binary, arguments_) {
  const result = spawnSync(binary, arguments_, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed with status ${result.status}.`);
}

function macDependencies(output) {
  return output.split(/\r?\n/).slice(1).map((line) => line.trim().split(' (')[0])
    .filter((dependency) => dependency && dependency !== ':');
}

function macRpaths(output) {
  const lines = output.split(/\r?\n/);
  const paths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*cmd LC_RPATH\s*$/.test(lines[index])) continue;
    const match = /^\s*path (.+?) \(offset \d+\)/.exec(lines[index + 2] || '');
    if (match) paths.push(match[1]);
  }
  return paths;
}

function macSystem(dependency) {
  return dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/');
}

function resolveMac(dependency, source) {
  const directory = path.dirname(source);
  if (path.isAbsolute(dependency)) return fs.existsSync(dependency) ? dependency : null;
  if (dependency.startsWith('@loader_path/')) {
    const candidate = path.resolve(directory, dependency.slice('@loader_path/'.length));
    return fs.existsSync(candidate) ? candidate : null;
  }
  if (dependency.startsWith('@rpath/')) {
    const suffix = dependency.slice('@rpath/'.length);
    const rpaths = macRpaths(capture('otool', ['-l', source]));
    const roots = [...rpaths, directory, '/opt/homebrew/lib', '/usr/local/lib'];
    for (const root of roots) {
      const expanded = root.replaceAll('@loader_path', directory);
      if (expanded.includes('@')) continue;
      const candidate = path.resolve(expanded, suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function stageMacClosure(librarySource, destination, libraryName) {
  const queue = [{ source: fs.realpathSync(librarySource), name: libraryName }];
  const selected = new Map([[libraryName, fs.realpathSync(librarySource)]]);
  const processed = new Set();
  while (queue.length) {
    const { source, name } = queue.shift();
    if (processed.has(name)) continue;
    processed.add(name);
    const staged = path.join(destination, name);
    if (path.resolve(source) !== path.resolve(staged)) fs.copyFileSync(source, staged);
    const dependencies = macDependencies(capture('otool', ['-L', source]));
    const rewrites = [];
    // The first line for a dylib is its own install name.
    for (const dependency of dependencies.slice(1)) {
      if (macSystem(dependency)) continue;
      const resolved = resolveMac(dependency, source);
      if (!resolved) throw new Error(`Unresolved libmpv dependency ${dependency} in ${source}.`);
      const canonical = fs.realpathSync(resolved);
      const childName = path.basename(dependency);
      const previous = selected.get(childName);
      if (previous && previous !== canonical) {
        throw new Error(`Conflicting libmpv dependency ${childName}: ${previous} and ${canonical}.`);
      }
      if (!previous) {
        selected.set(childName, canonical);
        queue.push({ source: canonical, name: childName });
      }
      rewrites.push(dependency, `@loader_path/${childName}`);
    }
    const arguments_ = ['-id', `@loader_path/${name}`];
    for (let index = 0; index < rewrites.length; index += 2) {
      if (rewrites[index] !== rewrites[index + 1]) {
        arguments_.push('-change', rewrites[index], rewrites[index + 1]);
      }
    }
    run('install_name_tool', [...arguments_, staged]);
  }
  for (const name of processed) {
    const staged = path.join(destination, name);
    const dependencies = macDependencies(capture('otool', ['-L', staged]));
    for (const dependency of dependencies) {
      if (macSystem(dependency)) continue;
      if (!dependency.startsWith('@loader_path/')) {
        throw new Error(`External libmpv dependency remains in ${staged}: ${dependency}.`);
      }
      const resolved = path.resolve(destination, dependency.slice('@loader_path/'.length));
      if (!resolved.startsWith(`${path.resolve(destination)}${path.sep}`) || !fs.existsSync(resolved)) {
        throw new Error(`Missing staged libmpv dependency ${dependency} in ${staged}.`);
      }
    }
  }
  // install_name_tool invalidates vendor signatures. Give the staged files a
  // valid local signature; the release signer replaces it during packaging.
  for (const name of processed) {
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(destination, name)]);
  }
  return processed.size;
}

function linuxDependencies(output) {
  const dependencies = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+=>\s+(not found|\/\S+)/.exec(line);
    if (match) dependencies.push({ name: match[1], location: match[2] === 'not found' ? null : match[2] });
  }
  return dependencies;
}

function linuxSystem(name) {
  return /^(?:linux-vdso|ld-linux|ld-musl|libc\.so|libm\.so|libpthread\.so|libdl\.so|librt\.so|libresolv\.so|libutil\.so|libgcc_s\.so|libanl\.so)/.test(name)
    || /^(?:libX|libxcb|libwayland|libEGL|libGL|libOpenGL|libGLES|libvulkan|libdrm|libva|libgbm|libudev|libasound|libpulse|libpipewire|libdbus|libcuda|libnvidia|libvdpau|libxkbcommon)/.test(name);
}

function stageLinuxClosure(librarySource, destination, libraryName) {
  capture('patchelf', ['--version']);
  const queue = [{ source: fs.realpathSync(librarySource), name: libraryName }];
  const selected = new Map([[libraryName, fs.realpathSync(librarySource)]]);
  const processed = new Set();
  while (queue.length) {
    const { source, name } = queue.shift();
    if (processed.has(name)) continue;
    processed.add(name);
    const staged = path.join(destination, name);
    if (path.resolve(source) !== path.resolve(staged)) fs.copyFileSync(source, staged);
    for (const dependency of linuxDependencies(capture('ldd', [source]))) {
      if (linuxSystem(dependency.name)) continue;
      if (!dependency.location) throw new Error(`Unresolved libmpv dependency ${dependency.name} in ${source}.`);
      const canonical = fs.realpathSync(dependency.location);
      const previous = selected.get(dependency.name);
      if (previous && previous !== canonical) {
        throw new Error(`Conflicting libmpv dependency ${dependency.name}: ${previous} and ${canonical}.`);
      }
      if (!previous) {
        selected.set(dependency.name, canonical);
        queue.push({ source: canonical, name: dependency.name });
      }
    }
    run('patchelf', ['--set-rpath', '$ORIGIN', staged]);
  }
  for (const name of processed) {
    const staged = path.join(destination, name);
    for (const dependency of linuxDependencies(capture('ldd', [staged]))) {
      if (linuxSystem(dependency.name)) continue;
      if (!dependency.location) throw new Error(`Missing staged libmpv dependency ${dependency.name} in ${staged}.`);
      if (!path.resolve(dependency.location).startsWith(`${path.resolve(destination)}${path.sep}`)) {
        throw new Error(`External libmpv dependency remains in ${staged}: ${dependency.name} => ${dependency.location}.`);
      }
    }
  }
  return processed.size;
}

module.exports = { macDependencies, macRpaths, linuxDependencies, linuxSystem, stageMacClosure, stageLinuxClosure };
