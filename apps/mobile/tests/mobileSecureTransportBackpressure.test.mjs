import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const compiler = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });

test('native response buffering bounds in-flight bytes and drains before completion', {
  skip: compiler.status !== 0 ? 'Swift compiler is not available' : false,
  timeout: 60_000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-response-buffer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'response-buffer');
  const sources = [
    fileURLToPath(new URL('../modules/loomtv-secure-transport/ios/LoomTvResponseBuffer.swift', import.meta.url)),
    fileURLToPath(new URL('./fixtures/response-buffer.swift', import.meta.url)),
  ];
  const compiled = spawnSync('swiftc', [...sources, '-o', executable], { encoding: 'utf8', timeout: 45_000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const ran = spawnSync(executable, [], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /Response buffer checks passed/);
});
