import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createHeadlessAdminService,
  headlessAdminStateFilename,
  loginThrottleDelayMs,
} from '../src/admin-service.js';
import { createBootstrapSecurity } from '../src/secure-bootstrap.js';

const OWNER_PASSWORD = 'correct-horse-battery';
const BOOTSTRAP_SECRET = 'test-bootstrap-secret-32-bytes-minimum';

async function makeService(overrides = {}) {
  const dataDir = overrides.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-admin-'));
  const bootstrapSecurity = createBootstrapSecurity({ dataDir, secret: BOOTSTRAP_SECRET });
  await bootstrapSecurity.initialize({ ownerConfigured: false });
  const service = createHeadlessAdminService({
    dataDir,
    version: '0.0.0-test',
    getRuntimeHealth: async () => ({ media: { state: 'online' } }),
    getSessions: async () => [],
    bootstrapSecurity,
    ...overrides.options,
  });
  return { service, dataDir };
}

function bearer(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function onboardedService(overrides = {}) {
  const { service, dataDir } = await makeService(overrides);
  const session = await service.createOwner({ name: 'Owner', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });
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

function fileSystemError(code) {
  return Object.assign(new Error(code), { code });
}

function storageCheck(health) {
  return health.checks.find((entry) => entry.name === 'Persistent storage');
}

test('admin storage health verifies a writable directory and removes its probe file', async () => {
  const { service, dataDir } = await makeService({
    options: {
      storageFileSystem: {
        statfs: async () => ({ blocks: 1_000_000, bsize: 1_024, bavail: 900_000 }),
      },
    },
  });

  const health = await service.getHealth(null);
  assert.deepEqual(health.storage, {
    path: dataDir,
    available: true,
    writable: true,
    state: 'writable',
    totalBytes: 1_024_000_000,
    freeBytes: 921_600_000,
  });
  assert.equal(storageCheck(health)?.state, 'pass');
  assert.equal((await fs.readdir(dataDir)).some((name) => name.startsWith('.loomtv-storage-probe-')), false);

  const publicSummary = await service.getHealth(null, { summary: true });
  assert.equal(Object.hasOwn(publicSummary, 'storage'), false);
  assert.equal(storageCheck(publicSummary), undefined);
});

test('admin storage health distinguishes permission-denied and read-only directories from missing paths', async (t) => {
  for (const [errorCode, expectedState] of [['EACCES', 'permission-denied'], ['EROFS', 'read-only']]) {
    await t.test(errorCode, async () => {
      let accessMode;
      let probeCalled = false;
      const { service } = await makeService({
        options: {
          storageFileSystem: {
            access: async (_targetPath, mode) => {
              accessMode = mode;
              throw fileSystemError(errorCode);
            },
            statfs: async () => ({ blocks: 100, bsize: 4_096, bavail: 50 }),
          },
          storageWriteProbe: async () => { probeCalled = true; },
        },
      });

      const health = await service.getHealth(null);
      assert.equal(accessMode, fsConstants.W_OK);
      assert.equal(probeCalled, false);
      assert.equal(health.storage.available, true);
      assert.equal(health.storage.writable, false);
      assert.equal(health.storage.state, expectedState);
      assert.equal(storageCheck(health)?.state, 'warn');
    });
  }

  await t.test('ENOENT', async () => {
    let postStatCall = false;
    const { service } = await makeService({
      options: {
        storageFileSystem: {
          stat: async () => { throw fileSystemError('ENOENT'); },
          statfs: async () => { postStatCall = true; },
          access: async () => { postStatCall = true; },
        },
        storageWriteProbe: async () => { postStatCall = true; },
      },
    });

    const health = await service.getHealth(null);
    assert.equal(postStatCall, false);
    assert.deepEqual(health.storage, {
      path: health.storage.path,
      available: false,
      writable: false,
      state: 'missing',
    });
    assert.equal(storageCheck(health)?.message, 'Data directory is missing.');
  });
});

test('admin storage health reports a mocked disk write error after closing and cleaning the probe', async () => {
  const calls = [];
  const { service } = await makeService({
    options: {
      storageFileSystem: {
        statfs: async () => ({ blocks: 100, bsize: 4_096, bavail: 50 }),
        open: async (probePath, flags, mode) => {
          calls.push(['open', path.basename(probePath), flags, mode]);
          return {
            writeFile: async () => {
              calls.push(['write']);
              throw fileSystemError('ENOSPC');
            },
            sync: async () => { calls.push(['sync']); },
            close: async () => { calls.push(['close']); },
          };
        },
        rm: async (probePath, options) => { calls.push(['rm', path.basename(probePath), options]); },
      },
    },
  });

  const health = await service.getHealth(null);
  assert.equal(health.storage.available, true);
  assert.equal(health.storage.writable, false);
  assert.equal(health.storage.state, 'write-failed');
  assert.deepEqual(calls.map(([operation]) => operation), ['open', 'write', 'close', 'rm']);
  assert.equal(calls[0][2], 'wx');
  assert.equal(calls[0][3], 0o600);
  assert.deepEqual(calls[3][2], { force: true });
});

test('admin storage health bounds an injected hanging write probe', async () => {
  let probeCalls = 0;
  const { service } = await makeService({
    options: {
      storageFileSystem: {
        statfs: async () => ({ blocks: 100, bsize: 4_096, bavail: 50 }),
      },
      storageProbeTimeoutMs: 20,
      storageWriteProbe: async () => {
        probeCalls += 1;
        return new Promise(() => {});
      },
    },
  });

  const startedAt = Date.now();
  const health = await service.getHealth(null);
  assert.ok(Date.now() - startedAt < 500, 'storage health must return instead of waiting on the hanging probe');
  assert.equal(health.storage.available, true);
  assert.equal(health.storage.writable, false);
  assert.equal(health.storage.state, 'probe-timeout');
  assert.equal(storageCheck(health)?.message, 'Data directory write probe timed out.');

  const repeatedHealth = await service.getHealth(null);
  assert.equal(repeatedHealth.storage.state, 'probe-timeout');
  assert.equal(probeCalls, 1, 'repeated health checks must share a still-running filesystem probe');
});

test('admin storage health surfaces cleanup failure after always attempting rm and unlink', async () => {
  const calls = [];
  const { service } = await makeService({
    options: {
      storageFileSystem: {
        statfs: async () => ({ blocks: 100, bsize: 4_096, bavail: 50 }),
        open: async () => ({
          writeFile: async () => { calls.push('write'); },
          sync: async () => { calls.push('sync'); },
          close: async () => { calls.push('close'); },
        }),
        rm: async () => {
          calls.push('rm');
          throw fileSystemError('EBUSY');
        },
        unlink: async () => {
          calls.push('unlink');
          throw fileSystemError('EBUSY');
        },
      },
    },
  });

  const health = await service.getHealth(null);
  assert.equal(health.storage.available, true);
  assert.equal(health.storage.writable, false);
  assert.equal(health.storage.state, 'cleanup-failed');
  assert.deepEqual(calls, ['write', 'sync', 'close', 'rm', 'unlink']);
  assert.equal(storageCheck(health)?.message, 'Data directory write probe could not clean up its temporary file.');
});

test('owner onboarding issues a usable session and cannot run twice', async () => {
  const { service } = await makeService();
  assert.equal(await service.isOwnerConfigured(), false);

  await assert.rejects(
    () => service.createOwner({ name: 'Owner', password: OWNER_PASSWORD }),
    (error) => error.status === 401 && error.code === 'bootstrap_secret_invalid',
  );
  const session = await service.createOwner({ name: 'Owner', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });
  assert.equal(typeof session.adminToken, 'string');
  assert.equal(session.user.type, 'owner');
  assert.equal(await service.isOwnerConfigured(), true);

  const principal = await service.authenticateRequest(bearer(session.adminToken));
  assert.equal(principal.type, 'owner');
  await assert.rejects(
    () => service.createOwner({ name: 'Second', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET }),
    (error) => error.status === 409,
  );
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

test('shared address failures throttle without hard-locking another identity', async () => {
  const delays = [];
  const { service } = await onboardedService({
    options: { loginDelay: async (milliseconds) => { delays.push(milliseconds); } },
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => service.createSession({
        username: `unknown-${attempt}`,
        password: 'wrong-password',
        address: attempt % 2 === 0 ? '192.0.2.50' : '::ffff:192.0.2.50',
      }),
      (error) => error.code === 'invalid_credentials',
    );
  }

  const valid = await service.createSession({
    username: 'owner',
    password: OWNER_PASSWORD,
    address: '::ffff:192.0.2.50',
  });
  assert.equal(typeof valid.adminToken, 'string');

  await service.createSession({
    username: 'owner',
    password: OWNER_PASSWORD,
    address: '192.0.2.51',
  });
  assert.deepEqual(delays, [250, 250, 250, 250, 250, 500, 250]);
});

test('owner aliases share one per-account lockout bucket', async () => {
  const { service } = await makeService({ options: { loginDelay: async () => {} } });
  await service.createOwner({ name: 'Alice', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(
      () => service.createSession({ username: 'owner', password: `wrong-password-${attempt}` }),
      (error) => error.code === 'invalid_credentials',
    );
  }
  await assert.rejects(
    () => service.createSession({ username: 'Alice', password: 'wrong-password-final' }),
    (error) => error.code === 'login_locked',
  );
  await assert.rejects(
    () => service.createSession({ username: 'owner', password: OWNER_PASSWORD }),
    (error) => error.code === 'login_locked',
  );
});

test('pre-upgrade owner lockouts remain effective across owner aliases', async () => {
  const { service, dataDir } = await makeService({ options: { loginDelay: async () => {} } });
  await service.createOwner({ name: 'Alice', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });
  const statePath = path.join(dataDir, headlessAdminStateFilename);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const now = Date.now();
  state.loginAttempts = [{
    key: createHash('sha256').update('identity:owner').digest('hex'),
    failures: 5,
    firstAttemptAt: now,
    lastAttemptAt: now,
    lockedUntil: now + 60_000,
  }];
  await fs.writeFile(statePath, JSON.stringify(state));

  const { service: reloaded } = await makeService({
    dataDir,
    options: { loginDelay: async () => {} },
  });
  await assert.rejects(
    () => reloaded.createSession({ username: 'Alice', password: OWNER_PASSWORD }),
    (error) => error.code === 'login_locked',
  );
});

test('pre-upgrade owner failures contribute to the stable account bucket', async () => {
  const { service, dataDir } = await makeService({ options: { loginDelay: async () => {} } });
  await service.createOwner({ name: 'Alice', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });
  const statePath = path.join(dataDir, headlessAdminStateFilename);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const now = Date.now();
  state.loginAttempts = [{
    key: createHash('sha256').update('identity:owner').digest('hex'),
    failures: 4,
    firstAttemptAt: now,
    lastAttemptAt: now,
    lockedUntil: 0,
  }];
  await fs.writeFile(statePath, JSON.stringify(state));

  const { service: reloaded } = await makeService({
    dataDir,
    options: { loginDelay: async () => {} },
  });
  await assert.rejects(
    () => reloaded.createSession({ username: 'Alice', password: 'wrong-password-final' }),
    (error) => error.code === 'login_locked',
  );
});

test('shared address throttle delay uses deterministic bounded buckets', () => {
  assert.deepEqual(
    [0, 4, 5, 9, 10, 14, 15, 100].map(loginThrottleDelayMs),
    [250, 250, 500, 500, 1_000, 1_000, 2_000, 2_000],
  );
});

test('revoked and garbage tokens do not authenticate', async () => {
  const { service, token } = await onboardedService();
  await service.revokeRequest(bearer(token));
  assert.equal(await service.authenticateRequest(bearer(token)), null);
  assert.equal(await service.authenticateRequest(bearer('not-a-real-token')), null);
  assert.equal(await service.authenticateRequest({ headers: {} }), null);
});

test('credential resets enforce privilege scope, verify self-service, revoke sessions, and write safe audit details', async () => {
  const { service, dataDir, principal: owner } = await onboardedService();
  const managerPassword = 'manager-password-1';
  const limitedAdminPassword = 'limited-admin-password-1';
  const broadAdminPassword = 'broad-admin-password-1';
  const viewerPassword = 'viewer-password-1';

  const manager = await service.createUser({
    name: 'Manager',
    password: managerPassword,
    role: 'user',
    permissions: ['users.manage', 'account.password'],
    rootIds: null,
  }, owner);
  const limitedAdmin = await service.createUser({
    name: 'Limited admin',
    password: limitedAdminPassword,
    role: 'admin',
    permissions: ['users.manage', 'account.password'],
    rootIds: null,
  }, owner);
  const broadAdmin = await service.createUser({
    name: 'Broad admin',
    password: broadAdminPassword,
    role: 'admin',
    permissions: ['users.manage', 'account.password', 'logs.read'],
    rootIds: null,
  }, owner);
  const viewer = await service.createUser({
    name: 'Viewer',
    password: viewerPassword,
    role: 'viewer',
    rootIds: null,
  }, owner);

  const managerSession = await service.createSession({ username: manager.name, password: managerPassword });
  const managerPrincipal = await service.authenticateRequest(bearer(managerSession.adminToken));
  const limitedAdminSession = await service.createSession({ username: limitedAdmin.name, password: limitedAdminPassword });
  const limitedAdminPrincipal = await service.authenticateRequest(bearer(limitedAdminSession.adminToken));
  const viewerSession = await service.createSession({ username: viewer.name, password: viewerPassword });

  await assert.rejects(
    () => service.changePassword({ userId: broadAdmin.id, newPassword: 'stolen-admin-password-1' }, managerPrincipal),
    (error) => error.status === 403 && error.code === 'permission_denied',
  );
  await assert.rejects(
    () => service.changePassword({ userId: broadAdmin.id, newPassword: 'stolen-peer-password-1' }, limitedAdminPrincipal),
    (error) => error.status === 403 && error.code === 'permission_denied',
  );
  await assert.rejects(
    () => service.changePassword({ userId: owner.id, newPassword: 'stolen-owner-password-1' }, managerPrincipal),
    (error) => error.status === 403 && error.code === 'permission_denied',
  );

  await assert.rejects(
    () => service.changePassword({ newPassword: 'manager-password-2' }, managerPrincipal),
    (error) => error.status === 400 && /current password is required/i.test(error.message),
  );
  await assert.rejects(
    () => service.changePassword({ currentPassword: 'incorrect-password', newPassword: 'manager-password-2' }, managerPrincipal),
    (error) => error.status === 401 && /current password is incorrect/i.test(error.message),
  );
  const changedSelf = await service.changePassword({
    currentPassword: managerPassword,
    newPassword: 'manager-password-2',
  }, managerPrincipal);
  assert.equal(await service.authenticateRequest(bearer(managerSession.adminToken)), null, 'self-change revokes the old session');
  assert.equal((await service.authenticateRequest(bearer(changedSelf.adminToken))).id, manager.id, 'self-change issues one replacement session');

  assert.deepEqual(await service.changePassword({ userId: viewer.id, newPassword: 'viewer-password-2' }, owner), { changed: true });
  assert.equal(await service.authenticateRequest(bearer(viewerSession.adminToken)), null, 'an owner reset revokes target sessions');
  const viewerAfterReset = await service.createSession({ username: viewer.name, password: 'viewer-password-2' });
  assert.equal((await service.authenticateRequest(bearer(viewerAfterReset.adminToken))).id, viewer.id);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, headlessAdminStateFilename), 'utf8'));
  const policyLogs = state.logs.filter((entry) => entry.message === 'Credential-reset policy evaluated.');
  assert.ok(policyLogs.some((entry) => entry.details?.actorId === manager.id
    && entry.details?.targetId === broadAdmin.id
    && entry.details?.policyResult === 'denied'));
  assert.ok(policyLogs.some((entry) => entry.details?.actorId === owner.id
    && entry.details?.targetId === viewer.id
    && entry.details?.policyResult === 'allowed'));
  const serializedLogs = JSON.stringify(state.logs);
  for (const password of [managerPassword, limitedAdminPassword, broadAdminPassword, viewerPassword, 'viewer-password-2']) {
    assert.equal(serializedLogs.includes(password), false, 'security logs must not record credentials');
  }
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
