import assert from 'node:assert/strict';
import test from 'node:test';
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

test('normalizeDeviceIds caps the allow-list length and trims entries', () => {
  const many = Array.from({ length: MAX_DEVICE_IDS + 10 }, (_, index) => ` device-${index} `);
  const normalized = normalizeDeviceIds(many);
  assert.equal(normalized.length, MAX_DEVICE_IDS);
  assert.equal(normalized[0], 'device-0');
  assert.equal(normalizeDeviceIds(null), null);
  assert.equal(normalizeDeviceIds(undefined), null);
});
