import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as ts from 'typescript';
import type { UnifiedDesktopServerState } from '../src/shared/desktopProtocol.ts';

function fixture(required: boolean, flag = '') {
  let reads = 0;
  const dependencies: Record<string, unknown> = {
    electron: { app: { getPath: () => '/saved-library' } },
    'node:crypto': {}, 'node:https': {}, 'node:path': path,
    'node:fs': { existsSync: () => true },
    '@loom-media-server/video-migration': { canonicalStatePath: (directory: string) => path.join(directory, 'loomtv-canonical.sqlite') },
    'loom-media-server-headless/runtime': { isCanonicalSetupRequired: async () => { reads += 1; return required; } },
    './nativeOwnerSession.ts': { createNativeOwnerSession: () => ({}) },
    './canonicalServerHost.ts': {}, './canonicalWindow.ts': {}, './mediaBinaries.ts': {},
    './networkInfo.ts': {}, './lanTlsIdentity.ts': {}, './localSecretStorage.ts': {},
  };
  const source = fs.readFileSync(new URL('../src/main/unifiedDesktopServer.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    process: { env: { LOOMTV_UNIFIED_DESKTOP: flag } },
    require: (id: string) => { assert.ok(id in dependencies, `Unexpected dependency ${id}`); return dependencies[id]; },
  });
  const api = module.exports as {
    requiresUnifiedDesktopSetup: () => Promise<boolean>;
    getUnifiedDesktopServerState: () => UnifiedDesktopServerState;
  };
  return { ...api, reads: () => reads };
}

test('saved owner configuration is available before delayed hosting starts', async () => {
  const f = fixture(false);
  assert.equal(await f.requiresUnifiedDesktopSetup(), false);
  const state = f.getUnifiedDesktopServerState();
  assert.equal(state.enabled, true);
  assert.equal(state.ownerConfigured, true);
  assert.equal(state.ready, false);
  assert.equal(f.reads(), 1);
});

test('explicit first-time setup still requires hosting before its window opens', async () => {
  const f = fixture(true, '1');
  assert.equal(await f.requiresUnifiedDesktopSetup(), true);
  assert.equal(f.getUnifiedDesktopServerState().ownerConfigured, false);
});

test('disabled hosting does not inspect canonical state during startup', async () => {
  const f = fixture(false, '0');
  assert.equal(await f.requiresUnifiedDesktopSetup(), false);
  assert.equal(f.getUnifiedDesktopServerState().enabled, false);
  assert.equal(f.reads(), 0);
});
