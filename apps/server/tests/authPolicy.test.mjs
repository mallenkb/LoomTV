import assert from 'node:assert/strict';
import test from 'node:test';
import { createPairingService } from '../src/pairing-service.js';
import {
  AUTH_PERMISSIONS,
  MAX_DEVICE_IDS,
  canAccessRoot,
  canResetCredentials,
  hasPermission,
  normalizeDeviceIds,
  normalizePermissionList,
  permissionsForRole,
} from '../src/auth-policy.js';

test('permissionsForRole falls back to viewer defaults for unknown roles', () => {
  assert.deepEqual(permissionsForRole('viewer'), ['library.read', 'stream', 'account.password']);
  assert.deepEqual(permissionsForRole('made-up-role'), permissionsForRole('viewer'));
  assert.deepEqual(permissionsForRole('admin'), [...AUTH_PERMISSIONS]);
});

test('permissionsForRole override drops unknown permission names', () => {
  assert.deepEqual(
    permissionsForRole('user', ['stream', 'not-a-permission', 'stream', 'logs.read']),
    ['stream', 'logs.read'],
  );
});

test('normalizePermissionList deduplicates and filters to the known vocabulary', () => {
  assert.deepEqual(normalizePermissionList(['stream', 'stream', 'bogus']), ['stream']);
  assert.deepEqual(normalizePermissionList('not-an-array', ['library.read']), ['library.read']);
});

test('hasPermission grants owners everything and matches user grants exactly', () => {
  assert.equal(hasPermission({ type: 'owner', permissions: [] }, 'users.manage'), true);
  assert.equal(hasPermission({ type: 'user', permissions: ['stream'] }, 'stream'), true);
  assert.equal(hasPermission({ type: 'user', permissions: ['stream'] }, 'users.manage'), false);
  assert.equal(hasPermission(null, 'stream'), false);
});

test('canAccessRoot treats a null root list as unrestricted and an array as an allow-list', () => {
  assert.equal(canAccessRoot({ type: 'user', rootIds: null }, 'root-1'), true);
  assert.equal(canAccessRoot({ type: 'user', rootIds: ['root-1'] }, 'root-1'), true);
  assert.equal(canAccessRoot({ type: 'user', rootIds: ['root-1'] }, 'root-2'), false);
  assert.equal(canAccessRoot({ type: 'owner', rootIds: [] }, 'root-2'), true);
});

test('canResetCredentials contains delegated resets within role, permission, and root scope', () => {
  const owner = { id: 'owner', type: 'owner', role: 'owner', permissions: ['*'], rootIds: null };
  const manager = {
    id: 'manager',
    type: 'user',
    role: 'admin',
    permissions: ['users.manage', 'account.password'],
    rootIds: ['root-1'],
  };
  const subordinate = {
    id: 'subordinate',
    type: 'user',
    role: 'user',
    permissions: ['account.password'],
    rootIds: ['root-1'],
  };

  assert.equal(canResetCredentials(owner, manager), true, 'the owner may reset any account');
  assert.equal(canResetCredentials(manager, manager), true, 'self-service is authorized before password verification');
  assert.equal(canResetCredentials(manager, subordinate), true, 'a manager may reset an account fully within their scope');
  assert.equal(canResetCredentials(manager, owner), false, 'a non-owner may never reset the owner');
  assert.equal(canResetCredentials(manager, { ...subordinate, role: 'owner' }), false, 'a broader role is denied');
  assert.equal(canResetCredentials(manager, {
    ...subordinate,
    role: 'admin',
    permissions: [...subordinate.permissions, 'logs.read'],
  }), false, 'a peer with broader permissions is denied');
  assert.equal(canResetCredentials(manager, {
    ...subordinate,
    role: 'admin',
    rootIds: ['root-1', 'root-2'],
  }), false, 'a peer with broader library-root scope is denied');
  assert.equal(canResetCredentials({ ...manager, permissions: ['account.password'] }, subordinate), false, 'delegated resets require users.manage');
});

test('pairing approval requires device management and authority over the target account', async (t) => {
  const manager = {
    id: 'manager', type: 'user', role: 'user',
    permissions: ['devices.manage', 'users.manage', 'stream'], rootIds: ['root-1'],
  };
  const target = { id: 'viewer', type: 'user', role: 'viewer', permissions: ['stream'], rootIds: ['root-1'] };
  const owner = { id: 'owner', type: 'owner', role: 'owner', permissions: ['*'], rootIds: null };
  for (const [name, actor, account, approved] of [
    ['no approver', null, target, false],
    ['missing devices.manage', { ...manager, permissions: ['users.manage', 'stream'] }, target, false],
    ['missing users.manage', { ...manager, permissions: ['devices.manage', 'stream'] }, target, false],
    ['self still requires explicit management', { ...target, permissions: ['devices.manage', 'stream'] }, target, false],
    ['owner target', manager, owner, false],
    ['higher role', manager, { ...target, role: 'admin' }, false],
    ['broader target permissions', manager, { ...target, permissions: ['stream', 'downloads'] }, false],
    ['different roots', manager, { ...target, rootIds: ['root-2'] }, false],
    ['unrestricted target', manager, { ...target, rootIds: null }, false],
    ['device permission ceiling', { ...owner, devicePermissions: ['devices.manage'] }, target, false],
    ['scoped manager', manager, target, true],
    ['owner', owner, target, true],
    ['self manager', manager, manager, true],
  ]) {
    await t.test(name, async () => {
      let writes = 0;
      const service = createPairingService({
        clock: () => 1_000,
        getAccount: async () => account,
        store: {
          readPairingRequest: () => ({ id: 'request-1', name: 'TV', kind: 'tv', requestedPermissions: ['stream'] }),
          approvePairingRequest: (input) => {
            writes += 1;
            return { deviceId: 'device-1', accountId: input.accountId, permissions: input.permissions, createdAt: input.approvedAt };
          },
        },
      });
      const approve = () => service.approve('request-1', { accountId: account.id, permissions: ['stream'] }, actor);
      if (approved) {
        assert.equal((await approve()).status, 'approved');
        assert.equal(writes, 1);
      } else {
        await assert.rejects(approve, { status: 403, code: 'permission_denied' });
        assert.equal(writes, 0);
      }
    });
  }
});

test('normalizeDeviceIds caps the allow-list length and trims entries', () => {
  const many = Array.from({ length: MAX_DEVICE_IDS + 10 }, (_, index) => ` device-${index} `);
  const normalized = normalizeDeviceIds(many);
  assert.equal(normalized.length, MAX_DEVICE_IDS);
  assert.equal(normalized[0], 'device-0');
  assert.equal(normalizeDeviceIds(null), null);
  assert.equal(normalizeDeviceIds(undefined), null);
});
