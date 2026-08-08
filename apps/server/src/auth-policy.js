/**
 * Headless account policy primitives. Keeping the vocabulary in one module
 * prevents the HTTP, media, and admin surfaces from slowly inventing
 * incompatible permission names.
 */

export const AUTH_PERMISSIONS = Object.freeze([
  'admin.read',
  'library.read',
  'library.manage',
  'stream',
  'transcode',
  'downloads',
  'remote.access',
  'sessions.read',
  'logs.read',
  'backup.read',
  'backup.create',
  'users.read',
  'users.manage',
  'account.password',
  'media.delete',
]);

export const USER_ROLES = Object.freeze(['viewer', 'user', 'admin']);

export const MAX_DEVICE_IDS = 16;
export const MAX_DEVICE_ID_LENGTH = 128;

const DEFAULT_ROLE_PERMISSIONS = {
  viewer: ['library.read', 'stream', 'account.password'],
  user: ['library.read', 'stream', 'transcode', 'account.password'],
  admin: AUTH_PERMISSIONS,
};

export function normalizePermissionList(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return [...new Set(source.filter((permission) => AUTH_PERMISSIONS.includes(permission)))];
}

export function permissionsForRole(role, override) {
  const normalizedRole = USER_ROLES.includes(role) ? role : 'viewer';
  return normalizePermissionList(override, DEFAULT_ROLE_PERMISSIONS[normalizedRole]);
}

export function hasPermission(principal, permission) {
  if (!principal) return false;
  if (!permission) return true;
  return principal.type === 'owner'
    || principal.permissions?.includes('*')
    || principal.permissions?.includes(permission) === true;
}

export function isOwnerPrincipal(principal) {
  return principal?.type === 'owner' || principal?.role === 'owner';
}

const ROLE_RANK = Object.freeze({
  viewer: 0,
  user: 1,
  admin: 2,
  owner: 3,
});

/**
 * Decide whether one account may replace another account's credentials.
 * Password verification for self-service changes remains the caller's
 * responsibility; this function only compares authorization scope.
 */
export function canResetCredentials(actor, target) {
  if (!actor?.id || !target?.id) return false;
  if (isOwnerPrincipal(actor)) return true;
  if (actor.id === target.id) return true;
  if (isOwnerPrincipal(target) || !hasPermission(actor, 'users.manage')) return false;

  const actorRank = ROLE_RANK[actor.role] ?? -1;
  const targetRank = ROLE_RANK[target.role] ?? -1;
  if (targetRank > actorRank) return false;
  if ((target.permissions || []).some((permission) => !hasPermission(actor, permission))) return false;

  if (actor.rootIds === null) return true;
  if (target.rootIds === null || !Array.isArray(actor.rootIds) || !Array.isArray(target.rootIds)) return false;
  return target.rootIds.every((rootId) => actor.rootIds.includes(rootId));
}

export function normalizeRootIds(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((rootId) => typeof rootId === 'string' && rootId.trim()).map((rootId) => rootId.trim().slice(0, 128)))];
}

/**
 * A null device list means that the account may sign in from any device. An
 * explicit list is an allow-list, used by deployments that want to bind an
 * account to known clients without storing device secrets.
 */
export function normalizeDeviceIds(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  return [...new Set(value
    .filter((deviceId) => typeof deviceId === 'string' && deviceId.trim())
    .map((deviceId) => deviceId.trim().slice(0, MAX_DEVICE_ID_LENGTH)))].slice(0, MAX_DEVICE_IDS);
}

export function canAccessRoot(principal, rootId) {
  if (!principal || !rootId) return false;
  if (isOwnerPrincipal(principal) || principal.rootIds === null) return true;
  return principal.rootIds?.includes(rootId) === true;
}

export function principalView(principal) {
  if (!principal) return null;
  return {
    id: principal.id,
    name: principal.name,
    type: principal.type,
    role: principal.role,
    permissions: [...(principal.permissions || [])],
    rootIds: principal.rootIds === null ? null : [...(principal.rootIds || [])],
    deviceIds: principal.deviceIds === null ? null : [...(principal.deviceIds || [])],
    maxSessions: principal.maxSessions ?? null,
  };
}

export function userView(user) {
  return principalView({
    id: user.id,
    name: user.name,
    type: 'user',
    role: user.role,
    permissions: user.permissions,
    rootIds: user.rootIds,
    deviceIds: user.deviceIds,
    maxSessions: user.maxSessions,
  });
}
