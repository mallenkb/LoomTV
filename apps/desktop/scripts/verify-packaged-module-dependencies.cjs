const path = require('node:path').posix;
const asar = require('@electron/asar');
const semver = require('semver');

// Check the versions Node will actually resolve inside the archive. A package
// being present is insufficient when a hoisted dependency has several versions.
function packagedDependencyProblems(archive, roots) {
  const files = new Set(asar.listPackage(archive).map(entry => entry.replace(/\\/g, '/')));
  const manifests = new Map();
  const visited = new Set();
  const problems = [];
  const read = directory => {
    const filename = path.join(directory, 'package.json');
    if (!files.has(filename)) return null;
    if (!manifests.has(directory)) {
      manifests.set(directory, JSON.parse(asar.extractFile(archive, filename.slice(1)).toString('utf8')));
    }
    return manifests.get(directory);
  };
  const resolve = (parent, name) => {
    let directory = parent;
    while (true) {
      if (path.basename(directory) !== 'node_modules') {
        const candidate = path.join(directory, 'node_modules', name);
        if (read(candidate)) return candidate;
      }
      const next = path.dirname(directory);
      if (next === directory) return null;
      directory = next;
    }
  };
  const visit = directory => {
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = read(directory);
    const optional = manifest.optionalDependencies || {};
    for (const [name, range] of Object.entries({ ...manifest.dependencies, ...optional })) {
      const dependency = resolve(directory, name);
      if (!dependency) {
        if (!Object.hasOwn(optional, name)) problems.push(`${manifest.name} requires missing dependency ${name}.`);
        continue;
      }
      const actual = read(dependency).version;
      if (semver.validRange(range) && !semver.satisfies(actual, range)) {
        problems.push(`${manifest.name} requires ${name}@${range}, but resolves ${actual} at ${dependency}.`);
      }
      visit(dependency);
    }
  };
  for (const name of roots) {
    const directory = resolve('/', name);
    if (!directory) problems.push(`Missing packaged runtime module ${name}.`);
    else visit(directory);
  }
  return problems;
}

module.exports = { packagedDependencyProblems };
