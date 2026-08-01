import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHeadlessAdminService, headlessAdminStateFilename } from '../src/admin-service.js';

const OWNER_PASSWORD = 'correct-horse-battery';

async function makeService(overrides = {}) {
  const dataDir = overrides.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-admin-'));
  const service = createHeadlessAdminService({
    dataDir,
    version: '0.0.0-test',
    getRuntimeHealth: async () => ({ media: { state: 'online' } }),
    getSessions: async () => [],
    ...overrides.options,
  });
  return { service, dataDir };
}

function bearer(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function onboardedService(overrides = {}) {
  const { service, dataDir } = await makeService(overrides);
  const session = await service.createOwner({ name: 'Owner', password: OWNER_PASSWORD });
  const principal = await service.authenticateRequest(bearer(session.adminToken));
  return { service, dataDir, token: session.adminToken, principal };
}

async function waitForScan(service, principal, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const scan = await service.getScanStatus(principal);
    if (scan.state !== 'scanning') return scan;
    if (Date.now() - start > timeoutMs) throw new Error('Scan did not complete in time.');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

test('owner onboarding issues a usable session and cannot run twice', async () => {
  const { service } = await makeService();
  assert.equal(await service.isOwnerConfigured(), false);

  const session = await service.createOwner({ name: 'Owner', password: OWNER_PASSWORD });
  assert.equal(typeof session.adminToken, 'string');
  assert.equal(session.user.type, 'owner');
  assert.equal(await service.isOwnerConfigured(), true);

  const principal = await service.authenticateRequest(bearer(session.adminToken));
  assert.equal(principal.type, 'owner');
  await assert.rejects(() => service.createOwner({ name: 'Second', password: OWNER_PASSWORD }), (error) => error.status === 409);
});

test('sign-in rejects bad credentials with a generic error and locks out after repeated failures', async () => {
  const { service } = await onboardedService();

  await assert.rejects(
    () => service.createSession({ password: 'wrong-password-1' }),
    (error) => error.status === 401 && error.code === 'invalid_credentials',
  );

  let locked;
  for (let attempt = 0; attempt < 6 && !locked; attempt += 1) {
    try {
      await service.createSession({ password: `wrong-password-${attempt + 2}` });
    } catch (error) {
      if (error.code === 'login_locked') locked = error;
      else assert.equal(error.code, 'invalid_credentials');
    }
  }
  assert.ok(locked, 'repeated failures must lock the account');
  assert.equal(locked.status, 429);
  assert.equal(typeof locked.retryAfter, 'number');

  // The lockout must also block the *correct* password.
  await assert.rejects(
    () => service.createSession({ password: OWNER_PASSWORD }),
    (error) => error.code === 'login_locked',
  );
});

test('revoked and garbage tokens do not authenticate', async () => {
  const { service, token } = await onboardedService();
  await service.revokeRequest(bearer(token));
  assert.equal(await service.authenticateRequest(bearer(token)), null);
  assert.equal(await service.authenticateRequest(bearer('not-a-real-token')), null);
  assert.equal(await service.authenticateRequest({ headers: {} }), null);
});

test('library roots resolve to absolute paths and unauthenticated principals cannot manage them', async () => {
  const { service, principal } = await onboardedService();
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-media-'));

  const root = await service.addLibraryRoot({ path: mediaDir }, principal);
  assert.equal(path.isAbsolute(root.path), true);

  await assert.rejects(
    () => service.addLibraryRoot({ path: mediaDir }, { type: 'user', role: 'viewer', permissions: ['library.read'], rootIds: null }),
    (error) => error.status === 403,
  );
  await assert.rejects(() => service.addLibraryRoot({ path: '' }, principal), (error) => error.status === 400);
});

test('a catalog entry that escapes its root is refused at playback resolution', async () => {
  const { service, dataDir, principal } = await onboardedService();
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-media-'));
  await fs.writeFile(path.join(mediaDir, 'inside.mkv'), 'fake');
  await service.addLibraryRoot({ path: mediaDir }, principal);
  await service.startLibraryScan({}, principal);
  await waitForScan(service, principal);

  const items = await service.listLibraryItems(principal);
  assert.equal(items.length, 1);

  // Tamper with the persisted catalog the way a corrupt or malicious state
  // file would, then reload the service from disk.
  const statePath = path.join(dataDir, headlessAdminStateFilename);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.catalog[0].path = path.join(mediaDir, '..', 'outside-the-root.mkv');
  await fs.writeFile(statePath, JSON.stringify(state));

  const { service: reloaded } = await makeService({ dataDir });
  const reloadedPrincipal = await reloaded.authenticateRequest(bearer((await reloaded.createSession({ password: OWNER_PASSWORD })).adminToken));
  await assert.rejects(
    () => reloaded.resolveMediaPath(state.catalog[0].id, reloadedPrincipal),
    (error) => error.status === 403,
  );
});

test('backup and restore round-trip recovers state and writes a rollback artifact', async () => {
  const clientSnapshots = [];
  let clientState = { profiles: [{ id: 'p1', ownerId: 'user-a', name: 'Viewer' }], progress: {}, selections: {} };
  const { service, principal } = await onboardedService({
    options: {
      getClientState: async () => clientState,
      replaceClientState: async (snapshot) => { clientSnapshots.push(snapshot); clientState = snapshot; },
    },
  });
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-media-'));
  await service.addLibraryRoot({ path: mediaDir }, principal);

  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-backup-'));
  const backup = await service.startBackup({ destination: backupDir }, principal);
  assert.equal(backup.state, 'completed');
  assert.match(backup.checksum, /^[a-f0-9]{64}$/i);
  await fs.access(backup.destination);

  // Mutate live state after the backup, then restore.
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-media-'));
  await service.addLibraryRoot({ path: secondRoot }, principal);
  assert.equal((await service.listLibraryRoots(principal)).length, 2);

  const result = await service.restoreBackup({ path: backup.destination }, principal);
  assert.equal(result.restored, true);
  await fs.access(result.rollbackDestination);
  assert.equal(clientSnapshots.length, 1, 'restore must also replace the hosted client state');

  // Restored state drops sessions, so a fresh sign-in must be required and
  // the pre-backup root list must be back.
  const fresh = await service.createSession({ password: OWNER_PASSWORD });
  const freshPrincipal = await service.authenticateRequest(bearer(fresh.adminToken));
  assert.equal((await service.listLibraryRoots(freshPrincipal)).length, 1);
});

test('a tampered backup is rejected by its checksum', async () => {
  const { service, principal } = await onboardedService();
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-backup-'));
  const backup = await service.startBackup({ destination: backupDir }, principal);

  const envelope = JSON.parse(await fs.readFile(backup.destination, 'utf8'));
  envelope.data.roots = [{ id: 'injected', path: '/etc', kind: 'others', createdAt: Date.now() }];
  await fs.writeFile(backup.destination, JSON.stringify(envelope));

  await assert.rejects(
    () => service.restoreBackup({ path: backup.destination }, principal),
    (error) => /checksum/i.test(error.message) || error.status === 400,
  );
});

test('restore refuses the live state file and non-backup permissions', async () => {
  const { service, dataDir, principal } = await onboardedService();
  await assert.rejects(
    () => service.restoreBackup({ path: path.join(dataDir, headlessAdminStateFilename) }, principal),
    (error) => /live admin state/i.test(error.message),
  );
  await assert.rejects(
    () => service.restoreBackup({ path: '/nonexistent.json' }, { type: 'user', role: 'viewer', permissions: ['library.read'], rootIds: null }),
    (error) => error.status === 403,
  );
});
