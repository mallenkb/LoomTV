import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isCanonicalSetupRequired } from 'loom-media-server-headless/runtime';
import { startDesktopPresentation } from '../src/main/desktopStartup.ts';
import type { UnifiedDesktopServerState } from '../src/shared/desktopProtocol.ts';

const ready: UnifiedDesktopServerState = { enabled: true, ready: true, ownerConfigured: true };

test('desktop opens before canonical startup and refreshes consumers when it settles', async () => {
  const events: string[] = [];
  let resolve!: (state: UnifiedDesktopServerState) => void;
  const server = new Promise<UnifiedDesktopServerState>((done) => { resolve = done; });
  const startup = startDesktopPresentation({
    waitForSetup: false,
    presentWindow: () => { events.push('window'); },
    startServer: () => { events.push('server'); return server; },
    serverSettled: (state) => { assert.equal(state, ready); events.push('refresh'); },
  });
  assert.deepEqual(events, ['window']);
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(events, ['window', 'server']);
  resolve(ready);
  await startup;
  assert.deepEqual(events, ['window', 'server', 'refresh']);
});

test('unified onboarding waits for the setup response before presenting a window', async () => {
  const events: string[] = [];
  let resolve!: (state: UnifiedDesktopServerState) => void;
  const server = new Promise<UnifiedDesktopServerState>((done) => { resolve = done; });
  const startup = startDesktopPresentation({
    waitForSetup: true,
    presentWindow: () => { events.push('window'); },
    startServer: () => { events.push('server'); return server; },
    serverSettled: () => { events.push('refresh'); },
  });
  assert.deepEqual(events, ['server']);
  resolve({ ...ready, ownerConfigured: false });
  await startup;
  assert.deepEqual(events, ['server', 'refresh', 'window']);
});

test('canonical failure leaves the desktop usable and reports the final state', async () => {
  for (const waitForSetup of [false, true]) {
    let presented = 0;
    const failed = { ...ready, ready: false, error: 'Port is unavailable.' };
    let settled: UnifiedDesktopServerState | undefined;
    await startDesktopPresentation({
      waitForSetup,
      presentWindow: () => { presented += 1; },
      startServer: async () => failed,
      serverSettled: (state) => { settled = state; },
    });
    assert.equal(presented, 1);
    assert.equal(settled, failed);
  }
});

for (const [name, owner, record, required] of [
  ['fresh setup', false, null, true],
  ['legacy owner', true, null, false],
  ['completed setup', true, { completedAt: 123 }, false],
  ['unfinished setup', true, { completedAt: null }, true],
  ['missing owner', false, { completedAt: 123 }, true],
] as const) {
  test(`setup preflight preserves the canonical decision for ${name}`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-setup-preflight-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, 'loomtv-canonical.sqlite');
    const database = new DatabaseSync(target);
    database.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE owner_account (singleton INTEGER PRIMARY KEY, account_id TEXT NOT NULL);');
    if (owner) database.prepare('INSERT INTO owner_account VALUES (1, ?)').run('owner-1');
    if (record) database.prepare('INSERT INTO meta VALUES (?, ?)').run('setup.state', JSON.stringify(record));
    database.close();
    const before = await fs.readFile(target);
    assert.equal(await isCanonicalSetupRequired(directory), required);
    assert.deepEqual(await fs.readFile(target), before);
  });
}

test('missing canonical state waits for setup without creating a database', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-setup-preflight-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(await isCanonicalSetupRequired(directory), true);
  assert.deepEqual(await fs.readdir(directory), []);
});
