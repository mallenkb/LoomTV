import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 2.0.19 shipped the version 1 bridge from the runtimes-2026-09 archive while
// the host required version 2, so packaged builds reported libmpv unavailable.

const require = createRequire(import.meta.url);
const bridge = require('../scripts/libmpv-bridge.cjs') as {
  BRIDGE_NAME: string;
  bridgeProblems: (directory: string, listExports?: (file: string) => Set<string>) => string[];
  ensureBridge: (directory: string, arch: string, stampPath: string) => boolean;
  expectedBridgeExports: () => string[];
  expectedBridgeVersion: () => number;
};
const desktopRoot = path.resolve(import.meta.dirname, '..');
const hostSource = fs.readFileSync(path.join(desktopRoot, 'src/main/libmpvPlayback.ts'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(desktopRoot, 'native/libmpv/render-bridge/bridge.m'), 'utf8');

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function payload(inventory: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-bridge-test-'));
  fs.writeFileSync(path.join(directory, bridge.BRIDGE_NAME), 'bridge');
  if (inventory !== undefined) fs.writeFileSync(path.join(directory, 'libmpv-inventory.json'), JSON.stringify(inventory));
  return directory;
}

test('the host and the bridge source agree on the bridge version', () => {
  const host = /export const LIBMPV_BRIDGE_VERSION = (\d+);/.exec(hostSource);
  assert.ok(host, 'libmpvPlayback.ts declares LIBMPV_BRIDGE_VERSION');
  assert.equal(Number(host[1]), bridge.expectedBridgeVersion());
  assert.match(bridgeSource, /loom_mpv_bridge_version\(void\) \{ return LOOM_MPV_BRIDGE_VERSION; \}/);
});

test('every bridge function the host binds is declared in bridge.h', () => {
  const bound = [...hostSource.matchAll(/bind\(library, '(loom_mpv_\w+)'/g)].map((match) => match[1]);
  assert.ok(bound.length > 0);
  const declared = bridge.expectedBridgeExports();
  assert.deepEqual(bound.filter((name) => !declared.includes(name)), []);
});

test('bridgeProblems rejects a bridge recorded at another version', () => {
  const all = () => new Set(bridge.expectedBridgeExports());
  const stale = payload({ bridge: { file: bridge.BRIDGE_NAME, sha256: '0'.repeat(64) } });
  const current = payload(undefined);
  try {
    const staleProblems = bridge.bridgeProblems(stale, all);
    assert.ok(staleProblems.some((problem) => /version unknown; the host requires 2/.test(problem)), staleProblems.join('\n'));

    fs.writeFileSync(path.join(current, 'libmpv-inventory.json'), JSON.stringify({
      bridge: { file: bridge.BRIDGE_NAME, sha256: sha256(path.join(current, bridge.BRIDGE_NAME)), version: bridge.expectedBridgeVersion() },
    }));
    assert.deepEqual(bridge.bridgeProblems(current, all), []);
    const missing = bridge.bridgeProblems(current, () => new Set(['loom_mpv_bridge_version']));
    assert.ok(missing.some((problem) => /does not export .*loom_mpv_set_subtitle_blur/.test(problem)), missing.join('\n'));
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
    fs.rmSync(current, { recursive: true, force: true });
  }
});

test('ensureBridge compiles the current bridge over a stale one, then reuses it', { skip: process.platform !== 'darwin' }, () => {
  const directory = payload({ minimumMacOS: '26.0', bridge: { file: bridge.BRIDGE_NAME, sha256: '0'.repeat(64) } });
  const stamp = path.join(directory, 'stamps', 'bridge.json');
  try {
    assert.equal(bridge.ensureBridge(directory, process.arch, stamp), true);
    assert.deepEqual(bridge.bridgeProblems(directory), []);
    const otool = spawnSync('otool', ['-l', path.join(directory, bridge.BRIDGE_NAME)], { encoding: 'utf8' });
    assert.match(otool.stdout, /minos 26\.0\b/);
    assert.equal(bridge.ensureBridge(directory, process.arch, stamp), false);

    // A runtime reinstall puts the archived bridge back; the next run rebuilds it.
    fs.writeFileSync(path.join(directory, bridge.BRIDGE_NAME), 'archived bridge');
    assert.equal(bridge.ensureBridge(directory, process.arch, stamp), true);
    assert.deepEqual(bridge.bridgeProblems(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
