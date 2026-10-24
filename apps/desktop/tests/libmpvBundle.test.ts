import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { highestMinimumMacOS, minimumMacOSFromLoadCommands, bridgeBuildEnvironment } = require('../scripts/bundle-libmpv.cjs');
const { bridgeProblems, expectedBridgeExports, BRIDGE_NAME } = require('../scripts/libmpv-bridge.cjs');

test('bundle minimum macOS covers the newest dependency and compares version components numerically', () => {
  assert.equal(highestMinimumMacOS(['14.6', '26.0', '15.7', '26.2.1', '26.10']), '26.10');
  assert.equal(highestMinimumMacOS([null, 'unknown']), null);
  assert.equal(
    minimumMacOSFromLoadCommands('cmd LC_BUILD_VERSION\ncmdsize 32\nplatform 1\nminos 26.0\nsdk 27.0\n'),
    '26.0',
  );
  assert.equal(
    minimumMacOSFromLoadCommands('cmd LC_VERSION_MIN_MACOSX\ncmdsize 16\nversion 12.0\nsdk 13.0\n'),
    '12.0',
  );
});

test('bundle bridge targets the recorded minimum OS and runtime architecture', () => {
  const environment = bridgeBuildEnvironment('/headers', '26.0');
  assert.equal(environment.LIBMPV_INCLUDE_DIR, '/headers');
  assert.equal(environment.LIBMPV_BRIDGE_MIN_MACOS, '26.0');
  assert.equal(environment.LIBMPV_BRIDGE_ARCH, 'arm64');
});

test('bridge verification rejects an inventory without its required version record', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-libmpv-inventory-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, BRIDGE_NAME), 'placeholder');
  fs.writeFileSync(path.join(directory, 'libmpv-inventory.json'), '{}');
  const problems = bridgeProblems(directory, () => new Set(expectedBridgeExports()));
  assert.ok(problems.some((problem: string) => problem.includes('version unknown; the host requires')));
});
