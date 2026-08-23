import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup as backupDatabase } from 'node:sqlite';
import { normalizeHeadlessAdminState } from './admin-service.js';
import { normalizeHeadlessClientState } from './client-state.js';
import {
  CANONICAL_MIGRATION_FORMAT,
  createCanonicalImportStage,
  finalizeCanonicalImport,
} from './canonical-state-store.js';

const ADMIN_FILE = 'headless-admin.json';
const CLIENT_SQLITE_FILE = 'headless-client.sqlite';
const CLIENT_JSON_FILE = 'headless-client.json';

export const CANONICAL_MIGRATION_REPORT_FORMAT = 'loomtv-canonical-migration-report-v1';
export const CANONICAL_MIGRATION_REPORT_FIELDS = Object.freeze([
  'format', 'migrationId', 'sourceFingerprint', 'dryRun', 'createdAt', 'sourceKinds', 'sourceCounts',
  'targetCounts', 'reconciliation', 'decisions', 'conflicts', 'warnings', 'backup', 'rollback', 'redactions',
]);

const exists = (target) => fs.access(target).then(() => true, () => false);
const hashText = (value) => createHash('sha256').update(String(value)).digest('hex');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function issue(code, category, count = 1, details = {}) {
  return { code, category, count, ...details };
}

function sourceSummary(fileName) {
  if (fileName === ADMIN_FILE) return 'admin-json';
  if (fileName === CLIENT_SQLITE_FILE) return 'client-sqlite';
  return 'client-json';
}

async function fingerprintFile(target, kind, hash) {
  const handle = await fs.open(target, 'r');
  let sizeBytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      sizeBytes += bytesRead;
    }
  } finally { await handle.close(); }
  hash.update(`${kind}:${sizeBytes}`);
  return sizeBytes;
}

async function fingerprintSources(dataDir, names) {
  const hash = createHash('sha256');
  const parts = [];
  for (const name of [...names].sort()) {
    const target = path.join(dataDir, name);
    if (!await exists(target)) continue;
    parts.push({ kind: sourceSummary(name), sizeBytes: await fingerprintFile(target, sourceSummary(name), hash) });
    if (name === CLIENT_SQLITE_FILE) {
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${target}${suffix}`;
        if (await exists(sidecar)) parts.push({ kind: `client-sqlite${suffix}`, sizeBytes: await fingerprintFile(sidecar, suffix, hash) });
      }
    }
  }
  return { fingerprint: hash.digest('hex'), parts };
}

function tableExists(database, tableName) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName));
}

function readLegacyClientDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON');
    const profiles = tableExists(database, 'profiles') ? database.prepare('SELECT * FROM profiles').all().map((row) => ({
      id: row.id, ownerId: row.ownerId, name: row.name, type: row.type, avatarKey: row.avatarKey,
      colorKey: row.colorKey, isGuest: row.isGuest === 1, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
    })) : [];
    const assignments = tableExists(database, 'profileAssignments')
      ? database.prepare('SELECT * FROM profileAssignments').all().map((row) => ({
        profileId: row.profileId, accountId: row.accountId, access: row.access, createdAt: Number(row.createdAt),
      })) : [];
    const progress = {};
    if (tableExists(database, 'progress')) for (const row of database.prepare('SELECT * FROM progress').all()) {
      progress[row.profileId] ||= {};
      progress[row.profileId][row.mediaId] = {
        position: Number(row.position), duration: Number(row.duration), watched: row.watched === 1, updatedAt: Number(row.updatedAt),
      };
    }
    const selections = {};
    if (tableExists(database, 'selections')) for (const row of database.prepare('SELECT * FROM selections').all()) selections[row.ownerId] = row.profileId;
    return { profiles, assignments, progress, selections };
  } finally { database.close(); }
}

export function mapLegacyAllowedFolders({ allowedFolders, libraryRoots }) {
  if (!Array.isArray(allowedFolders)) return undefined;
  if (allowedFolders.length === 0) return null;
  const roots = (libraryRoots || []).map((root) => ({ id: root.id, locator: path.resolve(root.path ?? root.locator) }));
  const ids = [];
  for (const folder of allowedFolders) {
    const resolved = path.resolve(String(folder));
    const exact = roots.find((root) => root.locator === resolved);
    if (exact) { ids.push(exact.id); continue; }
    const containingRoot = roots.find((root) => resolved.startsWith(`${root.locator}${path.sep}`));
    throw Object.assign(new Error(containingRoot
      ? 'A legacy subfolder restriction cannot be represented by canonical root IDs.'
      : 'A legacy folder restriction does not match a canonical root.'), {
      code: containingRoot ? 'legacy_subfolder_restriction_unrepresentable' : 'legacy_folder_restriction_unmatched',
      locatorFingerprint: hashText(resolved),
    });
  }
  return [...new Set(ids)];
}

function desktopCarriers(desktopState, adminState) {
  if (!desktopState || typeof desktopState !== 'object') return {};
  const restrictions = (desktopState.profileRestrictions || []).map((entry) => {
    const { allowedFolders, ...canonical } = entry;
    return {
    ...canonical,
    allowedRootIds: entry.allowedRootIds !== undefined
      ? entry.allowedRootIds
      : allowedFolders === undefined ? null : mapLegacyAllowedFolders({ allowedFolders, libraryRoots: adminState.roots }),
  }; });
  return {
    profiles: desktopState.profiles || [],
    profileCredentials: desktopState.profileCredentials || [],
    assignments: desktopState.profileAssignments || desktopState.assignments || [],
    selections: desktopState.profileSelections || desktopState.selections || [],
    progress: desktopState.progress || [],
    history: desktopState.history || [],
    profilePreferences: desktopState.profilePreferences || [],
    profileRestrictions: restrictions,
    profileListEntries: desktopState.profileListEntries || [],
    trackPreferences: desktopState.trackPreferences || [],
    mediaIdentityAliases: desktopState.mediaIdentityAliases || [],
    mediaIdentityEvidence: (desktopState.mediaIdentityEvidence || []).concat(
      (desktopState.mediaSources || []).flatMap((source) => (source.evidence || []).map((evidence) => ({ sourceId: source.id, ...evidence }))),
    ),
    catalogItems: desktopState.catalogItems || [],
    mediaSources: desktopState.mediaSources || [],
    libraryRoots: desktopState.libraryRoots || [],
    adminState: desktopState.adminState || null,
    accounts: desktopState.accounts || [],
    sessions: desktopState.sessions || [],
    devices: desktopState.devices || [],
    deviceCredentials: desktopState.deviceCredentials || [],
  };
}

function mergeDesktopAdminProjection(base, carriers) {
  if (!carriers.adminState && !carriers.libraryRoots.length && !carriers.accounts.length && !carriers.sessions.length) {
    return { adminState: base, conflicts: [], mergedCounts: {} };
  }
  const projected = normalizeHeadlessAdminState(carriers.adminState || {});
  const conflicts = [];
  const validAccountProjections = carriers.accounts.filter((item) => item?.account?.id && item?.credential?.accountId === item.account.id);
  if (validAccountProjections.length !== carriers.accounts.length) conflicts.push(issue(
    'desktop_account_credential_invalid', 'accounts', carriers.accounts.length - validAccountProjections.length,
  ));
  const projectedAccounts = validAccountProjections.map((item) => ({
    ...item.account,
    salt: item.credential.passwordSalt,
    hash: item.credential.passwordHash,
  }));
  const ownerProjection = projectedAccounts.find((item) => item.role === 'owner') || projected.owner;
  const extraOwners = Math.max(0, projectedAccounts.filter((item) => item.role === 'owner').length - 1);
  if (extraOwners) conflicts.push(issue('multiple_owner_accounts', 'accounts', extraOwners));
  const userProjection = projectedAccounts.filter((item) => item.role !== 'owner').concat(projected.users);
  if (base.owner && ownerProjection && base.owner.id !== ownerProjection.id) conflicts.push(issue('owner_identity_conflict', 'accounts'));
  const projectedRoots = carriers.libraryRoots.map((root) => ({
    id: root.id, path: root.locator || root.path,
    kind: root.kind === 'tv' ? 'tvShows' : root.kind,
    createdAt: root.createdAt, lastScanAt: root.lastScanAt,
  }));
  const roots = [];
  let mergedRoots = 0;
  for (const root of base.roots.concat(projected.roots, projectedRoots)) {
    const existing = roots.find((candidate) => candidate.id === root.id || candidate.path === root.path);
    if (!existing) {
      roots.push(root);
      continue;
    }
    if (existing.id === root.id && existing.path === root.path && existing.kind === root.kind) {
      existing.createdAt = Math.min(Number(existing.createdAt) || Number(root.createdAt), Number(root.createdAt) || Number(existing.createdAt));
      existing.lastScanAt = Math.max(Number(existing.lastScanAt) || 0, Number(root.lastScanAt) || 0) || undefined;
      mergedRoots += 1;
    } else {
      conflicts.push(issue('root_identity_requires_explicit_merge', 'roots', 1));
    }
  }
  return {
    adminState: {
      ...base,
      owner: base.owner || ownerProjection,
      users: base.users.concat(userProjection),
      sessions: base.sessions.concat(projected.sessions, carriers.sessions.map((item) => ({
        id: item.id, tokenHash: item.tokenHash, userId: item.accountId, deviceId: item.deviceId,
        createdAt: item.createdAt, lastSeenAt: item.lastSeenAt || item.createdAt,
        idleExpiresAt: item.idleExpiresAt, absoluteExpiresAt: item.absoluteExpiresAt, expiresAt: item.absoluteExpiresAt,
        revokedAt: item.revokedAt, revokedReason: item.revokedReason,
      }))),
      loginAttempts: base.loginAttempts.concat(projected.loginAttempts),
      roots,
      catalog: base.catalog.concat(projected.catalog),
      logs: base.logs.concat(projected.logs),
      scan: Object.hasOwn(carriers.adminState || {}, 'scan') ? projected.scan : base.scan,
      backup: Object.hasOwn(carriers.adminState || {}, 'backup') ? projected.backup : base.backup,
    },
    conflicts,
    mergedCounts: { roots: mergedRoots },
  };
}

function reconciliationRow(source, imported, reason = 'invalid_or_unrepresentable', merged = 0) {
  const rejected = Math.max(0, source - imported - merged);
  return { source, imported, merged, legacyOnly: 0, rejected: rejected ? [{ reason, count: rejected }] : [] };
}

function deduplicate(items, keyFor, category, conflicts) {
  const byKey = new Map();
  let rejected = 0;
  for (const item of items) {
    const key = keyFor(item);
    if (!key || byKey.has(key)) { rejected += 1; continue; }
    byKey.set(key, item);
  }
  if (rejected) conflicts.push(issue('duplicate_record_rejected', category, rejected));
  return [...byKey.values()];
}

function validateAdminReferences(adminState) {
  const conflicts = [];
  const accountIds = new Set(adminState.owner ? [adminState.owner.id] : []);
  const users = deduplicate(adminState.users, (item) => item.id, 'accounts', conflicts)
    .filter((item) => !accountIds.has(item.id));
  for (const user of users) accountIds.add(user.id);
  const rootsById = deduplicate(adminState.roots, (item) => item.id, 'roots', conflicts);
  const roots = deduplicate(rootsById, (item) => item.path, 'roots', conflicts);
  const rootIds = new Set(roots.map((item) => item.id));
  const catalogById = deduplicate(adminState.catalog, (item) => item.id, 'catalogItems', conflicts);
  const catalogByPath = deduplicate(catalogById, (item) => item.path, 'catalogItems', conflicts);
  const catalog = catalogByPath.filter((item) => rootIds.has(item.rootId));
  if (catalog.length !== catalogByPath.length) conflicts.push(issue('catalog_root_unresolved', 'catalogItems', catalogByPath.length - catalog.length));
  const sessionsByToken = deduplicate(adminState.sessions, (item) => item.tokenHash, 'sessions', conflicts);
  const sessions = sessionsByToken.filter((item) => accountIds.has(item.userId));
  if (sessions.length !== sessionsByToken.length) conflicts.push(issue('session_account_unresolved', 'sessions', sessionsByToken.length - sessions.length));
  const loginAttempts = deduplicate(adminState.loginAttempts, (item) => item.key, 'loginAttempts', conflicts);
  return { adminState: { ...adminState, users, roots, catalog, sessions, loginAttempts }, conflicts };
}

function validateClientReferences(clientState, adminState, mediaAliases, projectedCatalogItems = []) {
  const validAccounts = new Set([
    ...(adminState.owner ? [adminState.owner.id] : []),
    ...adminState.users.filter((account) => account.disabled !== true).map((account) => account.id),
  ]);
  const conflicts = [];
  const uniqueProfiles = deduplicate(clientState.profiles, (item) => item.id, 'profiles', conflicts);
  const uniqueAssignments = deduplicate(clientState.assignments, (item) => `${item.profileId}\u0000${item.accountId}`, 'profileAssignments', conflicts);
  const assignments = uniqueAssignments.filter((item) => validAccounts.has(item.accountId));
  if (assignments.length !== uniqueAssignments.length) conflicts.push(issue(
    'profile_assignment_account_unavailable', 'profileAssignments', uniqueAssignments.length - assignments.length,
  ));
  const validCredentials = clientState.profileCredentials.filter((item) => typeof item.pinSalt === 'string'
    && typeof item.pinHash === 'string' && (item.pinAlgorithm === undefined || item.pinAlgorithm === 'scrypt'));
  if (validCredentials.length !== clientState.profileCredentials.length) conflicts.push(issue(
    'profile_credential_invalid', 'profileCredentials', clientState.profileCredentials.length - validCredentials.length,
  ));
  const credentialProfiles = new Set(validCredentials.map((item) => item.profileId));
  const managed = new Set(assignments.filter((item) => item.access === 'manage').map((item) => item.profileId));
  const profiles = uniqueProfiles.filter((item) => managed.has(item.id) && (!item.hasPin || credentialProfiles.has(item.id)));
  if (profiles.length !== uniqueProfiles.length) conflicts.push(issue(
    'profile_manager_or_credential_missing', 'profiles', uniqueProfiles.length - profiles.length,
  ));
  const profileIds = new Set(profiles.map((item) => item.id));
  const retainedAssignments = assignments.filter((item) => profileIds.has(item.profileId));
  const assignmentKeys = new Set(retainedAssignments.map((item) => `${item.accountId}\u0000${item.profileId}`));
  const uniqueSelections = deduplicate(clientState.selections, (item) => item.deviceId, 'profileSelections', conflicts);
  const selections = uniqueSelections.filter((item) => validAccounts.has(item.accountId)
    && (item.profileId === null || profileIds.has(item.profileId)
      && assignmentKeys.has(`${item.accountId}\u0000${item.profileId}`)));
  if (selections.length !== uniqueSelections.length) conflicts.push(issue(
    'profile_selection_orphaned', 'profileSelections', uniqueSelections.length - selections.length,
  ));
  const catalogIds = new Set([...adminState.catalog.map((item) => item.id), ...projectedCatalogItems.map((item) => item.id)]);
  const aliasMap = new Map(mediaAliases.map((item) => [`${item.namespace}\u0000${item.alias}`, item.mediaId]));
  const resolveMediaId = (mediaId) => catalogIds.has(mediaId) ? mediaId
    : aliasMap.get(`legacy-media-id\u0000${mediaId}`) || aliasMap.get(`headless-path-hash\u0000${mediaId}`) || null;
  const uniqueProgress = deduplicate(clientState.progress, (item) => `${item.profileId}\u0000${item.mediaId}`, 'progress', conflicts);
  const progress = uniqueProgress.map((item) => ({ ...item, mediaId: resolveMediaId(item.mediaId) }))
    .filter((item) => profileIds.has(item.profileId) && item.mediaId);
  if (progress.length !== uniqueProgress.length) conflicts.push(issue(
    'watch_progress_or_media_orphaned', 'progress', uniqueProgress.length - progress.length,
  ));
  const validHistory = clientState.history.filter((item) => typeof item.id === 'string'
    && ['started', 'progressed', 'completed', 'unwatched'].includes(item.event));
  if (validHistory.length !== clientState.history.length) conflicts.push(issue(
    'watch_history_invalid', 'history', clientState.history.length - validHistory.length,
  ));
  const uniqueHistory = deduplicate(validHistory, (item) => item.id, 'history', conflicts);
  const history = uniqueHistory.map((item) => ({ ...item, mediaId: resolveMediaId(item.mediaId) }))
    .filter((item) => profileIds.has(item.profileId) && item.mediaId);
  if (history.length !== uniqueHistory.length) conflicts.push(issue(
    'watch_history_orphaned', 'history', uniqueHistory.length - history.length,
  ));
  const filterProfileCarrier = (items, category, keyFor) => {
    const unique = deduplicate(items, keyFor, category, conflicts);
    const retained = unique.filter((item) => profileIds.has(item.profileId));
    if (retained.length !== unique.length) conflicts.push(issue('profile_carrier_orphaned', category, unique.length - retained.length));
    return retained;
  };
  const rootIds = new Set(adminState.roots.map((root) => root.id));
  const profileRestrictions = filterProfileCarrier(clientState.profileRestrictions, 'profileRestrictions', (item) => item.profileId);
  const restrictions = profileRestrictions.filter((item) => item.allowedRootIds === null
    || Array.isArray(item.allowedRootIds) && item.allowedRootIds.every((rootId) => rootIds.has(rootId)));
  if (restrictions.length !== profileRestrictions.length) conflicts.push(issue(
    'profile_restriction_root_unresolved', 'profileRestrictions', profileRestrictions.length - restrictions.length,
  ));
  const validListEntries = clientState.profileListEntries.filter((item) => ['watchlist', 'favorite', 'watched'].includes(item.kind));
  if (validListEntries.length !== clientState.profileListEntries.length) conflicts.push(issue(
    'profile_list_kind_invalid', 'profileListEntries', clientState.profileListEntries.length - validListEntries.length,
  ));
  const sourceListEntries = filterProfileCarrier(validListEntries, 'profileListEntries', (item) => `${item.profileId}\u0000${item.mediaId}\u0000${item.kind}`);
  const listEntries = sourceListEntries.map((item) => ({ ...item, mediaId: resolveMediaId(item.mediaId) })).filter((item) => item.mediaId);
  if (listEntries.length !== sourceListEntries.length) conflicts.push(issue(
    'profile_list_media_unresolved', 'profileListEntries', sourceListEntries.length - listEntries.length,
  ));
  return {
    clientState: {
      ...clientState, profiles, assignments: retainedAssignments, selections, progress, history,
      profileCredentials: filterProfileCarrier(validCredentials, 'profileCredentials', (item) => item.profileId),
      profilePreferences: filterProfileCarrier(clientState.profilePreferences, 'profilePreferences', (item) => item.profileId),
      profileRestrictions: restrictions,
      profileListEntries: listEntries,
      trackPreferences: filterProfileCarrier(clientState.trackPreferences, 'trackPreferences', (item) => `${item.profileId}\u0000${item.scope}`),
    },
    conflicts,
  };
}

function rawClientCounts(rawClient, carrierInput) {
  const profiles = (Array.isArray(rawClient?.profiles) ? rawClient.profiles.length : 0)
    + (Array.isArray(carrierInput?.profiles) ? carrierInput.profiles.length : 0);
  const assignments = (Array.isArray(rawClient?.assignments) && rawClient.assignments.length
    ? rawClient.assignments.length
    : (Array.isArray(rawClient?.profiles) ? rawClient.profiles.filter((item) => typeof item?.ownerId === 'string').length : 0))
    + (Array.isArray(carrierInput?.assignments) ? carrierInput.assignments.length : 0);
  const selections = Array.isArray(rawClient?.selections) ? rawClient.selections.length
    : rawClient?.selections && typeof rawClient.selections === 'object' ? Object.keys(rawClient.selections).length : 0;
  const projectedSelections = Array.isArray(carrierInput?.selections) ? carrierInput.selections.length : 0;
  const progress = Array.isArray(rawClient?.progress) ? rawClient.progress.length
    : rawClient?.progress && typeof rawClient.progress === 'object'
      ? Object.values(rawClient.progress).reduce((sum, entries) => sum + (entries && typeof entries === 'object' ? Object.keys(entries).length : 0), 0) : 0;
  const carrierCount = (key) => (Array.isArray(rawClient?.[key]) ? rawClient[key].length : 0)
    + (Array.isArray(carrierInput?.[key]) ? carrierInput[key].length : 0);
  return {
    profiles, profileAssignments: assignments, profileSelections: selections + projectedSelections,
    progress: progress + (Array.isArray(carrierInput?.progress) ? carrierInput.progress.length : 0),
    history: Array.isArray(carrierInput?.history) ? carrierInput.history.length : 0,
    profileCredentials: carrierCount('profileCredentials'), profilePreferences: carrierCount('profilePreferences'),
    profileRestrictions: carrierCount('profileRestrictions'), profileListEntries: carrierCount('profileListEntries'),
    trackPreferences: carrierCount('trackPreferences'), devices: Array.isArray(carrierInput?.devices) ? carrierInput.devices.length : 0,
    deviceCredentials: Array.isArray(carrierInput?.deviceCredentials) ? carrierInput.deviceCredentials.length : 0,
    projectedAccounts: (carrierInput?.adminState?.owner ? 1 : 0) + (Array.isArray(carrierInput?.adminState?.users) ? carrierInput.adminState.users.length : 0)
      + (Array.isArray(carrierInput?.accounts) ? carrierInput.accounts.length : 0),
    projectedSessions: (Array.isArray(carrierInput?.adminState?.sessions) ? carrierInput.adminState.sessions.length : 0)
      + (Array.isArray(carrierInput?.sessions) ? carrierInput.sessions.length : 0),
    projectedLoginAttempts: Array.isArray(carrierInput?.adminState?.loginAttempts) ? carrierInput.adminState.loginAttempts.length : 0,
    projectedRoots: (Array.isArray(carrierInput?.adminState?.roots) ? carrierInput.adminState.roots.length : 0)
      + (Array.isArray(carrierInput?.libraryRoots) ? carrierInput.libraryRoots.length : 0),
    projectedAdminCatalog: Array.isArray(carrierInput?.adminState?.catalog) ? carrierInput.adminState.catalog.length : 0,
    projectedLogs: Array.isArray(carrierInput?.adminState?.logs) ? carrierInput.adminState.logs.length : 0,
    projectedBackup: Object.hasOwn(carrierInput?.adminState || {}, 'backup') ? 1 : 0,
    projectedScan: Object.hasOwn(carrierInput?.adminState || {}, 'scan') ? 1 : 0,
    catalogItems: Array.isArray(carrierInput?.catalogItems) ? carrierInput.catalogItems.length : 0,
    mediaSources: Array.isArray(carrierInput?.mediaSources) ? carrierInput.mediaSources.length : 0,
    mediaIdentityEvidence: Array.isArray(carrierInput?.mediaIdentityEvidence) ? carrierInput.mediaIdentityEvidence.length : 0,
  };
}

function validateProjectedMedia(carriers, adminState) {
  const conflicts = [];
  const validItems = (carriers.catalogItems || []).filter((item) => item && typeof item.id === 'string'
    && typeof item.title === 'string' && ['movie', 'series', 'episode', 'video'].includes(item.kind));
  if (validItems.length !== (carriers.catalogItems || []).length) conflicts.push(issue(
    'desktop_catalog_item_invalid', 'catalogItems', (carriers.catalogItems || []).length - validItems.length,
  ));
  const uniqueCatalogItems = deduplicate(validItems, (item) => item.id, 'catalogItems', conflicts);
  const headlessById = new Map(adminState.catalog.map((item) => [item.id, item]));
  const projectedSourcesByMedia = new Map((carriers.mediaSources || []).map((item) => [item.mediaId, item]));
  const mergedSourceIds = new Set();
  let mergedCatalogItems = 0;
  const catalogItems = [];
  for (const item of uniqueCatalogItems) {
    const headless = headlessById.get(item.id);
    if (!headless) {
      catalogItems.push(item);
      continue;
    }
    const projectedSource = projectedSourcesByMedia.get(item.id);
    const headlessSourceId = headless.sourceId || `${headless.id}:primary`;
    const compatible = projectedSource
      && projectedSource.id === headlessSourceId
      && path.resolve(projectedSource.locator) === path.resolve(headless.path)
      && projectedSource.rootId === headless.rootId
      && item.kind === headless.kind;
    if (!compatible) {
      conflicts.push(issue('catalog_identity_requires_explicit_merge', 'catalogItems', 1));
      continue;
    }
    const protectedFields = new Set(['id', 'rootId', 'path', 'relativePath', 'sourceId', 'sourceIds', 'available']);
    for (const [key, value] of Object.entries(item)) {
      if (!protectedFields.has(key) && value !== undefined) headless[key] = value;
    }
    mergedCatalogItems += 1;
    mergedSourceIds.add(projectedSource.id);
  }
  const catalogIds = new Set([...adminState.catalog.map((item) => item.id), ...catalogItems.map((item) => item.id)]);
  const rootIds = new Set(adminState.roots.map((item) => item.id));
  const validStates = new Set(['online', 'offline', 'unreadable', 'missing']);
  const sourceRows = (carriers.mediaSources || []).filter((item) => item && typeof item.id === 'string'
    && catalogIds.has(item.mediaId) && rootIds.has(item.rootId) && typeof item.locator === 'string'
    && typeof item.relativePath === 'string' && validStates.has(item.state));
  if (sourceRows.length !== (carriers.mediaSources || []).length) conflicts.push(issue(
    'desktop_media_source_invalid', 'mediaSources', (carriers.mediaSources || []).length - sourceRows.length,
  ));
  const headlessSourceIds = new Set(adminState.catalog.map((item) => item.sourceId || `${item.id}:primary`));
  const headlessLocators = new Set(adminState.catalog.map((item) => item.path));
  const retainedSourceRows = sourceRows.filter((item) => !mergedSourceIds.has(item.id));
  const nonCollidingSources = retainedSourceRows.filter((item) => !headlessSourceIds.has(item.id) && !headlessLocators.has(item.locator));
  if (nonCollidingSources.length !== retainedSourceRows.length) conflicts.push(issue(
    'media_source_requires_explicit_merge', 'mediaSources', retainedSourceRows.length - nonCollidingSources.length,
  ));
  const mediaSourcesById = deduplicate(nonCollidingSources, (item) => item.id, 'mediaSources', conflicts);
  const mediaSources = deduplicate(mediaSourcesById, (item) => item.locator, 'mediaSources', conflicts);
  const sourceIds = new Set([
    ...adminState.catalog.map((item) => item.sourceId || `${item.id}:primary`),
    ...mediaSources.map((item) => item.id),
  ]);
  const evidenceKinds = new Set(['content-sha256', 'filesystem-id', 'quick-hash', 'legacy-path-hash']);
  const evidenceRows = (carriers.mediaIdentityEvidence || []).filter((item) => item && sourceIds.has(item.sourceId)
    && evidenceKinds.has(item.kind) && typeof item.value === 'string');
  if (evidenceRows.length !== (carriers.mediaIdentityEvidence || []).length) conflicts.push(issue(
    'media_identity_evidence_invalid', 'mediaIdentityEvidence', (carriers.mediaIdentityEvidence || []).length - evidenceRows.length,
  ));
  const mediaIdentityEvidence = deduplicate(evidenceRows, (item) => `${item.sourceId}\u0000${item.kind}\u0000${item.value}`, 'mediaIdentityEvidence', conflicts);
  return {
    catalogItems,
    mediaSources,
    mediaIdentityEvidence,
    mergedCounts: { catalogItems: mergedCatalogItems, mediaSources: mergedSourceIds.size },
    conflicts,
  };
}

function validateDeviceAndIdentityCarriers(carriers, adminState, generatedAliases, projectedCatalogItems = []) {
  const conflicts = [];
  const accountIds = new Set([...(adminState.owner ? [adminState.owner.id] : []), ...adminState.users.map((item) => item.id)]);
  const validDeviceRows = (carriers.devices || []).filter((item) => typeof item.id === 'string' && item.id && typeof item.name === 'string');
  if (validDeviceRows.length !== (carriers.devices || []).length) conflicts.push(issue('device_record_invalid', 'devices', (carriers.devices || []).length - validDeviceRows.length));
  const uniqueDevices = deduplicate(validDeviceRows, (item) => item.id, 'devices', conflicts);
  const devices = uniqueDevices.filter((item) => !item.accountId || accountIds.has(item.accountId));
  if (devices.length !== uniqueDevices.length) conflicts.push(issue('device_account_unresolved', 'devices', uniqueDevices.length - devices.length));
  const deviceIds = new Set(devices.map((item) => item.id));
  const validCredentialRows = (carriers.deviceCredentials || []).filter((item) => typeof item.deviceId === 'string'
    && typeof item.secretHash === 'string' && typeof item.algorithm === 'string');
  if (validCredentialRows.length !== (carriers.deviceCredentials || []).length) conflicts.push(issue(
    'device_credential_invalid', 'deviceCredentials', (carriers.deviceCredentials || []).length - validCredentialRows.length,
  ));
  const uniqueCredentials = deduplicate(validCredentialRows, (item) => item.deviceId, 'deviceCredentials', conflicts);
  const deviceCredentials = uniqueCredentials.filter((item) => deviceIds.has(item.deviceId));
  if (deviceCredentials.length !== uniqueCredentials.length) conflicts.push(issue('device_credential_orphaned', 'deviceCredentials', uniqueCredentials.length - deviceCredentials.length));
  const catalogIds = new Set([...adminState.catalog.map((item) => item.id), ...projectedCatalogItems.map((item) => item.id)]);
  const allowedNamespaces = new Set(['desktop-path-hash', 'headless-path-hash', 'legacy-media-id', 'provider']);
  const uniqueGeneratedAliases = deduplicate(generatedAliases, (item) => `${item.namespace}\u0000${item.alias}`, 'mediaIdentityAliases', conflicts);
  const generatedKeys = new Set(uniqueGeneratedAliases.map((item) => `${item.namespace}\u0000${item.alias}`));
  const uniqueAliases = deduplicate(carriers.mediaIdentityAliases || [], (item) => `${item.namespace}\u0000${item.alias}`, 'mediaIdentityAliases', conflicts);
  const aliases = uniqueAliases.filter((item) => allowedNamespaces.has(item.namespace) && catalogIds.has(item.mediaId)
    && !generatedKeys.has(`${item.namespace}\u0000${item.alias}`));
  if (aliases.length !== uniqueAliases.length) conflicts.push(issue('media_identity_alias_invalid', 'mediaIdentityAliases', uniqueAliases.length - aliases.length));
  return { devices, deviceCredentials, aliases: uniqueGeneratedAliases.concat(aliases), generatedAliasCount: uniqueGeneratedAliases.length, conflicts };
}

function migrationAccounting(rawAdmin, rawCounts, state, legacyOnly, carrierAliasCount, mergedCounts = {}) {
  const client = state.clientState;
  const accounts = (rawAdmin?.owner ? 1 : 0) + (Array.isArray(rawAdmin?.users) ? rawAdmin.users.length : 0) + rawCounts.projectedAccounts;
  const importedAccounts = (state.adminState.owner ? 1 : 0) + state.adminState.users.length;
  const backupSources = (Object.hasOwn(rawAdmin || {}, 'backup') ? 1 : 0) + rawCounts.projectedBackup;
  const scanSources = (Object.hasOwn(rawAdmin || {}, 'scan') ? 1 : 0) + rawCounts.projectedScan;
  const values = {
    accounts: [accounts, importedAccounts], accountCredentials: [accounts, importedAccounts],
    sessions: [(rawAdmin?.sessions?.length || 0) + rawCounts.projectedSessions, state.adminState.sessions.length],
    loginAttempts: [(rawAdmin?.loginAttempts?.length || 0) + rawCounts.projectedLoginAttempts, state.adminState.loginAttempts.length],
    roots: [(rawAdmin?.roots?.length || 0) + rawCounts.projectedRoots, state.adminState.roots.length],
    catalogItems: [(rawAdmin?.catalog?.length || 0) + rawCounts.projectedAdminCatalog + rawCounts.catalogItems,
      new Set([...state.adminState.catalog.map((item) => item.id), ...(state.catalogItems || []).map((item) => item.id)]).size],
    mediaSources: [(rawAdmin?.catalog?.length || 0) + rawCounts.projectedAdminCatalog + rawCounts.mediaSources,
      state.adminState.catalog.length + (state.mediaSources || []).length],
    mediaIdentityEvidence: [(rawAdmin?.catalog?.length || 0) + rawCounts.projectedAdminCatalog + rawCounts.mediaIdentityEvidence, state.mediaIdentityEvidence.length],
    profiles: [rawCounts.profiles, client.profiles.length],
    profileCredentials: [rawCounts.profileCredentials, client.profileCredentials.length],
    profileAssignments: [rawCounts.profileAssignments, client.assignments.length],
    profileSelections: [rawCounts.profileSelections, client.selections.length],
    progress: [rawCounts.progress, client.progress.length],
    history: [rawCounts.history, client.history.length],
    profileRestrictions: [rawCounts.profileRestrictions, client.profileRestrictions.length],
    profilePreferences: [rawCounts.profilePreferences, client.profilePreferences.length],
    profileListEntries: [rawCounts.profileListEntries, client.profileListEntries.length],
    trackPreferences: [rawCounts.trackPreferences, client.trackPreferences.length],
    devices: [rawCounts.devices, state.devices.length], deviceCredentials: [rawCounts.deviceCredentials, state.deviceCredentials.length],
    backupState: [backupSources, Math.min(1, backupSources)],
    scanState: [scanSources, Math.min(1, scanSources)],
    operationalLogs: [(rawAdmin?.logs?.length || 0) + rawCounts.projectedLogs, state.adminState.logs.length],
  };
  const sourceCounts = Object.fromEntries(Object.entries(values).map(([key, [source]]) => [key, source]));
  const reconciliation = Object.fromEntries(Object.entries(values).map(([key, [source, imported]]) => [
    key,
    reconciliationRow(source, imported, 'invalid_or_unrepresentable', Number(mergedCounts[key] || 0)),
  ]));
  const generatedAliases = state.generatedAliasCount || 0;
  sourceCounts.mediaIdentityAliases = carrierAliasCount;
  reconciliation.mediaIdentityAliases = {
    ...reconciliationRow(carrierAliasCount, Math.max(0, state.mediaIdentityAliases.length - generatedAliases)),
    generated: generatedAliases,
  };
  for (const category of ['backupState', 'scanState']) {
    reconciliation[category].generated = reconciliation[category].source === 0 ? 1 : 0;
  }
  for (const [category, count] of Object.entries(legacyOnly)) {
    sourceCounts[category] = count;
    reconciliation[category] = { source: count, imported: 0, legacyOnly: count, rejected: [] };
  }
  return { sourceCounts, reconciliation };
}

function applyRejectionReasons(accounting, conflicts) {
  for (const [category, row] of Object.entries(accounting.reconciliation)) {
    const rejectedTotal = Math.max(0, Number(row.source) - Number(row.imported) - Number(row.merged || 0) - Number(row.legacyOnly));
    if (!rejectedTotal) { row.rejected = []; continue; }
    const reasons = [];
    let remaining = rejectedTotal;
    for (const conflict of conflicts.filter((item) => item.category === category)) {
      const count = Math.min(remaining, Number(conflict.count) || 0);
      if (count > 0) reasons.push({ reason: conflict.code, count });
      remaining -= count;
      if (!remaining) break;
    }
    if (remaining) reasons.push({ reason: 'normalization_rejected', count: remaining });
    row.rejected = reasons;
  }
  return accounting;
}

export async function createLegacyCanonicalImportPlan({ dataDir, desktopState = null }) {
  const resolvedDir = path.resolve(dataDir);
  const sourceNames = [ADMIN_FILE, CLIENT_SQLITE_FILE, CLIENT_JSON_FILE];
  const before = await fingerprintSources(resolvedDir, sourceNames);
  if (!before.parts.length && !desktopState) throw Object.assign(new Error('No legacy state sources were found.'), { code: 'legacy_state_not_found' });
  const adminPath = path.join(resolvedDir, ADMIN_FILE);
  const rawAdmin = await exists(adminPath) ? JSON.parse(await fs.readFile(adminPath, 'utf8')) : {};
  const baseAdminState = normalizeHeadlessAdminState(rawAdmin);
  const carriers = desktopCarriers(desktopState, baseAdminState);
  const mergedAdmin = mergeDesktopAdminProjection(baseAdminState, carriers);
  const validatedAdmin = validateAdminReferences(mergedAdmin.adminState);
  const adminState = validatedAdmin.adminState;
  let rawClient = {};
  const sqlitePath = path.join(resolvedDir, CLIENT_SQLITE_FILE);
  const jsonPath = path.join(resolvedDir, CLIENT_JSON_FILE);
  if (await exists(sqlitePath)) rawClient = readLegacyClientDatabase(sqlitePath);
  else if (await exists(jsonPath)) rawClient = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  const normalizationConflicts = [];
  const rawAssignments = Array.isArray(rawClient.assignments) ? rawClient.assignments : [];
  const validAssignments = rawAssignments.filter((item) => item?.access === 'use' || item?.access === 'manage');
  const desktopAssignments = Array.isArray(carriers.assignments) ? carriers.assignments : [];
  const validDesktopAssignments = desktopAssignments.filter((item) => item?.access === 'use' || item?.access === 'manage');
  if (validAssignments.length !== rawAssignments.length) normalizationConflicts.push(issue(
    'profile_assignment_access_invalid', 'profileAssignments', rawAssignments.length - validAssignments.length,
  ));
  if (validDesktopAssignments.length !== desktopAssignments.length) normalizationConflicts.push(issue(
    'profile_assignment_access_invalid', 'profileAssignments', desktopAssignments.length - validDesktopAssignments.length,
  ));
  const rawCounts = rawClientCounts(rawClient, carriers);
  const legacyClient = normalizeHeadlessClientState({ ...rawClient, ...(rawAssignments.length ? { assignments: validAssignments } : {}) });
  if (rawAssignments.length) {
    const explicitProfiles = new Set(rawAssignments.map((item) => item?.profileId).filter((value) => typeof value === 'string'));
    const validExplicitProfiles = new Set(validAssignments.map((item) => item.profileId));
    legacyClient.assignments = legacyClient.assignments.filter((item) => !explicitProfiles.has(item.profileId) || validExplicitProfiles.has(item.profileId));
  }
  const desktopClient = normalizeHeadlessClientState({ ...carriers, assignments: validDesktopAssignments });
  const sourceClient = Object.fromEntries(Object.keys(legacyClient).map((key) => [key, legacyClient[key].concat(desktopClient[key] || [])]));
  const projectedMedia = validateProjectedMedia(carriers, adminState);
  const generatedAliases = adminState.catalog.map((item) => ({
    namespace: 'headless-path-hash', alias: item.id, mediaId: item.id, createdAt: Number(item.indexedAt) || Date.now(),
  })).concat(projectedMedia.catalogItems.flatMap((item) => (item.legacyIds || []).map((alias) => ({
    namespace: 'legacy-media-id', alias, mediaId: item.id, createdAt: item.createdAt,
  }))));
  const validatedCarriers = validateDeviceAndIdentityCarriers(carriers, adminState, generatedAliases, projectedMedia.catalogItems);
  const mediaIdentityAliases = [...new Map(validatedCarriers.aliases.map((item) => [`${item.namespace}\u0000${item.alias}`, item])).values()];
  const evidenceCandidates = adminState.catalog.map((item) => ({
    sourceId: item.sourceId || `${item.id}:primary`, kind: 'legacy-path-hash', value: item.id,
    observedAt: Number(item.indexedAt) || Date.now(),
  }));
  const mediaIdentityEvidence = [...new Map(evidenceCandidates.concat(projectedMedia.mediaIdentityEvidence)
    .map((item) => [`${item.sourceId}\u0000${item.kind}\u0000${item.value}`, item])).values()];
  const validatedClient = validateClientReferences(sourceClient, adminState, mediaIdentityAliases, projectedMedia.catalogItems);
  const clientState = validatedClient.clientState;
  const state = { adminState, clientState, mediaIdentityAliases, mediaIdentityEvidence,
    catalogItems: projectedMedia.catalogItems, mediaSources: projectedMedia.mediaSources,
    generatedAliasCount: validatedCarriers.generatedAliasCount,
    devices: validatedCarriers.devices, deviceCredentials: validatedCarriers.deviceCredentials };
  const after = await fingerprintSources(resolvedDir, sourceNames);
  if (before.fingerprint !== after.fingerprint) throw Object.assign(new Error('Legacy state changed while the import plan was being built.'), { code: 'legacy_state_changed' });
  const legacyOnly = { legacyAdminProfiles: Array.isArray(rawAdmin.profiles) ? rawAdmin.profiles.length : 0,
    legacyWatchDocuments: rawAdmin.watchState && typeof rawAdmin.watchState === 'object' ? Object.keys(rawAdmin.watchState).length : 0 };
  const conflicts = [...mergedAdmin.conflicts, ...validatedAdmin.conflicts, ...normalizationConflicts,
    ...projectedMedia.conflicts, ...validatedCarriers.conflicts, ...validatedClient.conflicts];
  const accounting = applyRejectionReasons(
    migrationAccounting(
      rawAdmin,
      rawCounts,
      state,
      legacyOnly,
      (carriers.mediaIdentityAliases || []).length,
      { ...mergedAdmin.mergedCounts, ...projectedMedia.mergedCounts },
    ),
    conflicts,
  );
  const sourceFingerprint = hashText(`${before.fingerprint}:${stableJson(desktopState || {})}`);
  const targetCounts = Object.fromEntries(Object.entries(accounting.reconciliation)
    .filter(([category]) => !Object.hasOwn(legacyOnly, category))
    .map(([category, row]) => [category, Number(row.imported || 0) + Number(row.generated || 0)]));
  return {
    migrationId: `legacy-${sourceFingerprint.slice(0, 32)}`,
    format: CANONICAL_MIGRATION_FORMAT,
    sourceFingerprint,
    sourceKinds: [...before.parts.map((part) => part.kind), ...(desktopState ? ['desktop-projection'] : [])],
    sourceCounts: accounting.sourceCounts,
    targetCounts,
    reconciliation: accounting.reconciliation,
    state,
    decisions: [
      { code: 'legacy_sqlite_read_only', value: true },
      { code: 'empty_allowed_folders', value: 'all-roots-null' },
      { code: 'subfolder_grants', value: 'fail-closed' },
      { code: 'legacy_state_after_cutover', value: 'read-only-import-source' },
      { code: 'headless_path_hash_representation', value: 'legacy-media-id-produced-by-headless-mediaIdFor' },
    ],
    warnings: [], conflicts,
  };
}

async function fileDigest(target) {
  const hash = createHash('sha256');
  const handle = await fs.open(target, 'r');
  let sizeBytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally { await handle.close(); }
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function verifyLegacyBackupManifest(manifestPath, migrationId) {
  const stats = await fs.stat(manifestPath);
  if (!stats.isFile() || stats.size > 1024 * 1024) throw Object.assign(new Error('Legacy backup manifest is invalid.'), { code: 'legacy_backup_invalid' });
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch {
    throw Object.assign(new Error('Legacy backup manifest is invalid.'), { code: 'legacy_backup_invalid' });
  }
  if (manifest?.format !== 'loomtv-canonical-source-backup-v1' || manifest.migrationId !== migrationId
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw Object.assign(new Error('Legacy backup manifest does not match the migration.'), { code: 'legacy_backup_invalid' });
  }
  const backupDir = path.dirname(path.resolve(manifestPath));
  for (const artifact of manifest.artifacts) {
    if (!artifact || path.basename(String(artifact.fileName)) !== artifact.fileName
      || !/^[a-f0-9]{64}$/.test(String(artifact.sha256)) || !Number.isSafeInteger(artifact.sizeBytes)) {
      throw Object.assign(new Error('Legacy backup manifest contains an invalid artifact.'), { code: 'legacy_backup_invalid' });
    }
    const actual = await fileDigest(path.join(backupDir, artifact.fileName));
    if (actual.sha256 !== artifact.sha256 || actual.sizeBytes !== artifact.sizeBytes) {
      throw Object.assign(new Error('A verified legacy backup artifact has changed.'), { code: 'legacy_backup_changed' });
    }
  }
  return manifest;
}

export async function createVerifiedLegacyBackup({ dataDir, migrationId, destinationDir, additionalArtifacts = [] }) {
  const resolvedDir = path.resolve(dataDir);
  const destinationRoot = path.resolve(destinationDir);
  const backupDir = path.join(destinationRoot, `canonical-cutover-${migrationId}`);
  const partialDir = path.join(destinationRoot, `.canonical-cutover-${migrationId}.partial-${randomUUID()}`);
  await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(partialDir, { mode: 0o700 });

  const syncFile = async (target) => {
    const handle = await fs.open(target, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const copyAndSync = async (source, target) => {
    await fs.copyFile(source, target);
    await fs.chmod(target, 0o600);
    await syncFile(target);
  };

  try {
    const artifacts = [];
    const adminPath = path.join(resolvedDir, ADMIN_FILE);
    if (await exists(adminPath)) {
      const target = path.join(partialDir, ADMIN_FILE);
      await copyAndSync(adminPath, target);
      artifacts.push({ kind: 'admin-json', fileName: ADMIN_FILE, ...await fileDigest(target) });
    }
    const clientPath = path.join(resolvedDir, CLIENT_SQLITE_FILE);
    if (await exists(clientPath)) {
      const target = path.join(partialDir, CLIENT_SQLITE_FILE);
      const source = new DatabaseSync(clientPath, { readOnly: true });
      try { await backupDatabase(source, target); } finally { source.close(); }
      await fs.chmod(target, 0o600);
      await syncFile(target);
      artifacts.push({ kind: 'client-sqlite', fileName: CLIENT_SQLITE_FILE, ...await fileDigest(target) });
    } else {
      const legacyJson = path.join(resolvedDir, CLIENT_JSON_FILE);
      if (await exists(legacyJson)) {
        const target = path.join(partialDir, CLIENT_JSON_FILE);
        await copyAndSync(legacyJson, target);
        artifacts.push({ kind: 'client-json', fileName: CLIENT_JSON_FILE, ...await fileDigest(target) });
      }
    }
    for (const [index, artifact] of additionalArtifacts.entries()) {
      if (!artifact || typeof artifact.path !== 'string' || typeof artifact.kind !== 'string') {
        throw Object.assign(new Error('A desktop backup artifact is invalid.'), { code: 'legacy_backup_invalid' });
      }
      const source = path.resolve(artifact.path);
      const sourceParts = [source];
      if (['.sqlite', '.sqlite3', '.db'].includes(path.extname(source).toLowerCase())) {
        for (const suffix of ['-wal', '-shm']) if (await exists(`${source}${suffix}`)) sourceParts.push(`${source}${suffix}`);
      }
      const beforeDigests = await Promise.all(sourceParts.map(fileDigest));
      for (const [partIndex, sourcePart] of sourceParts.entries()) {
        const suffix = partIndex === 0 ? path.extname(source).slice(0, 16) : sourcePart.slice(source.length);
        const fileName = `desktop-source-${index + 1}${suffix}`;
        const target = path.join(partialDir, fileName);
        await copyAndSync(sourcePart, target);
        artifacts.push({ kind: `${artifact.kind}${partIndex === 0 ? '' : suffix}`.slice(0, 80), fileName, ...await fileDigest(target) });
      }
      const afterDigests = await Promise.all(sourceParts.map(fileDigest));
      if (beforeDigests.some((beforeDigest, partIndex) => beforeDigest.sha256 !== afterDigests[partIndex].sha256
        || beforeDigest.sizeBytes !== afterDigests[partIndex].sizeBytes)) {
        throw Object.assign(new Error('A desktop backup source changed while it was copied.'), { code: 'legacy_state_changed' });
      }
    }
    const verified = await Promise.all(artifacts.map(async (artifact) => {
      const actual = await fileDigest(path.join(partialDir, artifact.fileName));
      return actual.sha256 === artifact.sha256 && actual.sizeBytes === artifact.sizeBytes;
    }));
    if (!artifacts.length || verified.includes(false)) {
      throw Object.assign(new Error('Legacy backup verification failed.'), { code: 'legacy_backup_invalid' });
    }

    const manifestPath = path.join(partialDir, 'manifest.json');
    const manifest = { format: 'loomtv-canonical-source-backup-v1', migrationId, createdAt: Date.now(), artifacts };
    const manifestHandle = await fs.open(manifestPath, 'wx', 0o600);
    try {
      await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    const partialHandle = await fs.open(partialDir, 'r');
    try { await partialHandle.sync(); } finally { await partialHandle.close(); }
    await fs.rename(partialDir, backupDir);
    const rootHandle = await fs.open(destinationRoot, 'r');
    try { await rootHandle.sync(); } finally { await rootHandle.close(); }
    return { backupPath: path.join(backupDir, 'manifest.json'), artifactCount: artifacts.length, verified: true };
  } catch (error) {
    await fs.rm(partialDir, { recursive: true, force: true });
    throw error;
  }
}

export async function commitLegacyCanonicalImport({ dataDir, plan, backupPath, reportPath }) {
  const rejected = Object.values(plan.reconciliation || {}).reduce((sum, row) => sum
    + (Array.isArray(row.rejected) ? row.rejected.reduce((total, item) => total + Number(item.count || 0), 0) : 0), 0);
  if ((plan.conflicts || []).length || rejected) {
    throw Object.assign(new Error('Canonical cutover cannot commit while migration conflicts or rejected records remain.'), {
      code: 'migration_conflicts_unresolved', conflictCount: (plan.conflicts || []).length, rejectedCount: rejected,
    });
  }
  await verifyLegacyBackupManifest(backupPath, plan.migrationId);
  const stage = await createCanonicalImportStage({
    dataDir, migrationId: plan.migrationId, sourceFingerprint: plan.sourceFingerprint,
    sourceCounts: plan.sourceCounts, reconciliation: plan.reconciliation, state: plan.state, backupPath, reportPath,
  });
  await verifyLegacyBackupManifest(backupPath, plan.migrationId);
  return finalizeCanonicalImport({ dataDir, migrationId: plan.migrationId, stagedPath: stage.stagedPath });
}

export function createMigrationReport(plan, { dryRun = true, targetCounts = plan.targetCounts, backup = null } = {}) {
  return {
    format: CANONICAL_MIGRATION_REPORT_FORMAT, migrationId: plan.migrationId,
    sourceFingerprint: plan.sourceFingerprint, dryRun, createdAt: Date.now(), sourceKinds: plan.sourceKinds,
    sourceCounts: plan.sourceCounts, targetCounts, reconciliation: plan.reconciliation,
    decisions: plan.decisions, conflicts: plan.conflicts, warnings: plan.warnings,
    backup: backup ? { verified: backup.verified, artifactCount: backup.artifactCount } : { verified: false, artifactCount: 0 },
    rollback: { mode: 'stop-server-remove-canonical-restore-verified-legacy-backup', automaticFallback: false },
    redactions: { rawPaths: true, credentials: true, sourceLocators: true },
  };
}

export const legacyStateFilenames = Object.freeze({ admin: ADMIN_FILE, clientSqlite: CLIENT_SQLITE_FILE, clientJson: CLIENT_JSON_FILE });
