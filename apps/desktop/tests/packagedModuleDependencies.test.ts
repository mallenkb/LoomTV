import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createPackage } = require('@electron/asar') as { createPackage: (source: string, destination: string) => Promise<void> };
const { packagedDependencyProblems } = require('../scripts/verify-packaged-module-dependencies.cjs') as {
  packagedDependencyProblems: (archive: string, roots: string[]) => string[];
};

test('packaged modules resolve nested versions and native archive paths', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-asar-dependencies-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, 'source');
  const archive = path.join(scratch, 'app.asar');
  for (const [directory, metadata] of [
    ['node_modules/player', { name: 'player', version: '1.0.0', dependencies: { codec: '^1.0.0' } }],
    ['node_modules/player/node_modules/codec', { name: 'codec', version: '1.2.0' }],
    ['node_modules/codec', { name: 'codec', version: '2.0.0' }],
  ] as const) {
    fs.mkdirSync(path.join(source, directory), { recursive: true });
    fs.writeFileSync(path.join(source, directory, 'package.json'), JSON.stringify(metadata));
  }
  await createPackage(source, archive);
  assert.deepEqual(packagedDependencyProblems(archive, ['player']), []);
  assert.deepEqual(packagedDependencyProblems(archive, ['missing']), ['Missing packaged runtime module missing.']);
});

test('packaged dependency checks report incompatible versions instead of accepting presence alone', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-asar-versions-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, 'source');
  const archive = path.join(scratch, 'app.asar');
  for (const [name, metadata] of [
    ['player', { name: 'player', version: '1.0.0', dependencies: { codec: '^1.0.0' } }],
    ['codec', { name: 'codec', version: '2.0.0' }],
  ] as const) {
    const directory = path.join(source, 'node_modules', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata));
  }
  await createPackage(source, archive);
  assert.match(packagedDependencyProblems(archive, ['player']).join('\n'), /player requires codec@\^1\.0\.0, but resolves 2\.0\.0/);
});
