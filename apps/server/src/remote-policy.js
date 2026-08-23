import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hasPermission, isLocalNetworkAddress } from './auth-policy.js';

const INVITATION_PERMISSIONS = Object.freeze(['library.read', 'stream', 'downloads']);
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMITS = Object.freeze({ credential: 30, pairing: 12, media: 600, download: 600, admin: 120, compatibility: 300, public: 180 });
const INVITATION_SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_SCOPE_IDS = 512;

function remoteError(status, code, message, details = {}) {
  return Object.assign(new Error(message), { status, code, ...details });
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(left, right) {
  const actual = Buffer.from(String(left || ''), 'utf8');
  const expected = Buffer.from(String(right || ''), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(Number(value))) throw remoteError(400, 'invalid_request', 'A remote policy limit is invalid.');
  return Math.max(minimum, Math.min(maximum, Number(value)));
}

function scalarDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (/secret|token|credential|authorization|cookie|path|locator|url|header|address|fingerprint/i.test(key)) continue;
    if (typeof item === 'string') result[key.slice(0, 64)] = item.slice(0, 256);
    else if (typeof item === 'number' && Number.isFinite(item)) result[key.slice(0, 64)] = item;
    else if (typeof item === 'boolean' || item === null) result[key.slice(0, 64)] = item;
  }
  return result;
}

function uniqueIds(value, field) {
  if (value === null && field === 'mediaIds') return null;
  if (!Array.isArray(value)) throw remoteError(400, 'invalid_request', `${field} must be an array.`);
  const ids = [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
  if (ids.length > MAX_SCOPE_IDS || ids.some((entry) => entry.length > 128)) throw remoteError(400, 'invalid_request', `${field} is invalid.`);
  return ids;
}

function fileVersion(source) {
  return createHash('sha256').update([
    source.sourceId, source.fileId?.dev, source.fileId?.ino,
    source.sizeBytes, Math.trunc(source.modifiedAtMs || 0),
  ].join('\0')).digest('base64url');
}

function publicDownloadLease(lease) {
  const { secretHash: _secretHash, quotaOwner: _quotaOwner, fileVersion: _fileVersion, ...safe } = lease;
  return safe;
}

export function createRemotePolicyService({ store, proxyPolicy, getAccount, getAdminService, getClientState, clock = Date.now }) {
  if (!store || !proxyPolicy) throw new Error('Remote policy requires canonical state and a trusted-proxy policy.');
  const rateBuckets = new Map();
  const addressAuditKey = randomBytes(32);

  function context(req) {
    const address = proxyPolicy.clientAddress(req);
    const requestClass = isLocalNetworkAddress(address) ? 'local' : 'remote';
    return { address, requestClass, secure: proxyPolicy.isSecureRequest(req) };
  }

  function audit(action, outcome, requestContext, actor = null, details = {}) {
    const actorType = actor?.authentication === 'invitation-session'
      ? 'invitation' : actor?.authentication === 'device-credential' || actor?.authentication === 'device-session'
        ? 'device' : actor?.id ? 'account' : 'anonymous';
    store.appendAuditEvent({
      id: randomUUID(), occurredAt: clock(), requestClass: requestContext?.requestClass || 'local', actorType,
      actorId: actor?.invitationSessionId || actor?.deviceId || actor?.id,
      action: String(action).slice(0, 128), outcome,
      addressHash: requestContext?.address
        ? createHmac('sha256', addressAuditKey).update(requestContext.address).digest('hex') : undefined,
      details: scalarDetails(details),
    });
  }

  function consumeRate(requestContext, routeClass) {
    if (requestContext.requestClass !== 'remote') return;
    const limit = RATE_LIMITS[routeClass] || RATE_LIMITS.public;
    const currentTime = clock();
    const key = digest(`${requestContext.address}\0${routeClass}`);
    const prior = rateBuckets.get(key);
    const bucket = !prior || prior.resetAt <= currentTime ? { count: 0, resetAt: currentTime + RATE_WINDOW_MS } : prior;
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    while (rateBuckets.size > 4096) rateBuckets.delete(rateBuckets.keys().next().value);
    if (bucket.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000));
      if (!bucket.reported) {
        bucket.reported = true;
        audit('remote.rate-limit', 'denied', requestContext, null, { routeClass });
      }
      throw remoteError(429, 'rate_limited', 'Too many remote requests. Try again later.', { retryAfter });
    }
  }

  function preflight(req, routeClass = 'public') {
    if (req?.__loomRemoteContext) return req.__loomRemoteContext;
    const requestContext = context(req);
    if (requestContext.requestClass === 'local') {
      if (req) req.__loomRemoteContext = requestContext;
      return requestContext;
    }
    consumeRate(requestContext, routeClass);
    const policy = store.readRemotePolicy();
    if (!policy.enabled) {
      audit('remote.request', 'denied', requestContext, null, { reason: 'disabled', routeClass });
      throw remoteError(403, 'remote_access_disabled', 'Remote access is disabled.');
    }
    if (!requestContext.secure) {
      audit('remote.request', 'denied', requestContext, null, { reason: 'insecure', routeClass });
      throw remoteError(426, 'secure_transport_required', 'Remote access requires HTTPS or a trusted secure proxy.');
    }
    if (req) req.__loomRemoteContext = requestContext;
    return requestContext;
  }

  function liveInvitationScope(scope, issuer) {
    const rootIds = issuer.rootIds === null
      ? [...scope.rootIds]
      : scope.rootIds.filter((rootId) => issuer.rootIds?.includes(rootId));
    if (!rootIds.length) return null;
    const permissions = scope.permissions.filter((permission) => hasPermission(issuer, permission));
    if (!permissions.length) return null;
    return { ...scope, rootIds, permissions };
  }

  async function authorizedInvitationScope(scope, issuer) {
    const liveScope = liveInvitationScope(scope, issuer);
    if (!liveScope) return null;
    const profileContext = await getClientState().requireScopedProfile(issuer.id, liveScope.profileId);
    const restrictedRoots = profileContext.restrictions?.allowedRootIds;
    const rootIds = restrictedRoots === null || restrictedRoots === undefined
      ? liveScope.rootIds
      : liveScope.rootIds.filter((rootId) => restrictedRoots.includes(rootId));
    return rootIds.length ? { ...liveScope, rootIds } : null;
  }

  function assertPrincipal(req, principal, routeClass = 'public') {
    const requestContext = preflight(req, routeClass);
    if (requestContext.requestClass === 'remote'
      && principal?.authentication !== 'invitation-session'
      && !hasPermission(principal, 'remote.access')) {
      audit('remote.authorization', 'denied', requestContext, principal, { routeClass });
      throw remoteError(403, 'remote_access_disabled', 'Remote access is not enabled for this credential.');
    }
    return requestContext;
  }

  function policy() {
    return store.readRemotePolicy();
  }

  function updatePolicy(input, principal, req) {
    const requestContext = context(req);
    if (!hasPermission(principal, 'remote.manage')) throw remoteError(403, 'permission_denied', 'Remote policy management permission is required.');
    if (input.enabled === true && requestContext.requestClass !== 'local') {
      throw remoteError(403, 'permission_denied', 'Remote access can only be enabled from the local network.');
    }
    const current = policy();
    const updated = store.updateRemotePolicy({
      enabled: input.enabled,
      downloadQuotaBytes: boundedInteger(input.downloadQuotaBytes, current.downloadQuotaBytes, 0, 1024 ** 4),
      downloadLeaseTtlMs: boundedInteger(input.downloadLeaseTtlMs, current.downloadLeaseTtlMs, 60_000, 30 * 24 * 60 * 60 * 1000),
      invitationTtlMs: boundedInteger(input.invitationTtlMs, current.invitationTtlMs, 60_000, 30 * 24 * 60 * 60 * 1000),
    }, principal.id, clock());
    audit('remote.policy.update', 'allowed', requestContext, principal, { enabled: updated.enabled });
    return updated;
  }

  async function createInvitation(input, principal, req) {
    const requestContext = assertPrincipal(req, principal, 'admin');
    if (!hasPermission(principal, 'sharing.manage')) throw remoteError(403, 'permission_denied', 'Sharing management permission is required.');
    const profileId = String(input.profileId || '').trim();
    const rootIds = uniqueIds(input.rootIds, 'rootIds');
    const mediaIds = uniqueIds(input.mediaIds ?? null, 'mediaIds');
    const permissions = [...new Set((Array.isArray(input.permissions) ? input.permissions : ['library.read', 'stream'])
      .filter((entry) => INVITATION_PERMISSIONS.includes(entry)))];
    if (!profileId || !rootIds.length || !permissions.includes('library.read')
      || (Array.isArray(input.permissions) && permissions.length !== input.permissions.length)) {
      throw remoteError(400, 'invalid_request', 'Invitation scope is invalid.');
    }
    if (permissions.some((permission) => !hasPermission(principal, permission))) throw remoteError(403, 'permission_denied', 'Invitation scope exceeds the issuer permissions.');
    const clientState = getClientState();
    const scopedProfile = await clientState.requireScopedProfile(principal.id, profileId);
    const admin = getAdminService();
    const visibleRootIds = new Set((await admin.listLibraryRoots(principal)).map((root) => root.id));
    for (const rootId of rootIds) {
      if (!visibleRootIds.has(rootId)) throw remoteError(400, 'invalid_request', 'Invitation scope contains an unavailable library root.');
      if (principal.rootIds !== null && !principal.rootIds?.includes(rootId)) throw remoteError(403, 'permission_denied', 'Invitation scope exceeds the issuer library roots.');
      if (scopedProfile.restrictions?.allowedRootIds !== null
        && scopedProfile.restrictions?.allowedRootIds !== undefined
        && !scopedProfile.restrictions.allowedRootIds.includes(rootId)) {
        throw remoteError(403, 'permission_denied', 'Invitation scope exceeds the profile restrictions.');
      }
    }
    if (mediaIds) for (const mediaId of mediaIds) {
      const item = await admin.getLibraryItem(mediaId, principal);
      if (!item) throw remoteError(404, 'media_not_found', 'An invited media item is unavailable.');
      const sources = store.listMediaSources(mediaId);
      if (!sources.some((source) => rootIds.includes(source.rootId))) throw remoteError(403, 'permission_denied', 'An invited media item is outside the invitation roots.');
      await clientState.requireScopedProfile(principal.id, profileId, { ...item, rootId: sources.find((source) => rootIds.includes(source.rootId))?.rootId });
    }
    const currentPolicy = policy();
    const ttlMs = boundedInteger(input.ttlMs, currentPolicy.invitationTtlMs, 60_000, currentPolicy.invitationTtlMs);
    const downloadQuotaBytes = permissions.includes('downloads')
      ? boundedInteger(input.downloadQuotaBytes, Math.min(currentPolicy.downloadQuotaBytes, 5 * 1024 ** 3), 0, currentPolicy.downloadQuotaBytes)
      : 0;
    const secret = randomBytes(32).toString('base64url');
    const createdAt = clock();
    const invitation = store.createInvitation({ id: randomUUID(), issuerAccountId: principal.id, secretHash: digest(secret),
      scope: { profileId, rootIds, mediaIds, permissions, downloadQuotaBytes }, createdAt, expiresAt: createdAt + ttlMs });
    audit('invitation.create', 'created', requestContext, principal, { invitationId: invitation.id, profileId });
    return { ...invitation, secret, scheme: 'LoomInvite' };
  }

  async function acceptInvitation(invitationId, invitationSecret, deviceId, req) {
    const requestContext = preflight(req, 'credential');
    const invitation = store.readInvitation(invitationId, true);
    if (!invitation || !safeEqual(invitation.secretHash, digest(invitationSecret))) throw remoteError(404, 'not_found', 'Invitation was not found.');
    const issuer = await getAccount(invitation.issuerAccountId);
    if (!issuer || !hasPermission(issuer, 'sharing.manage')) throw remoteError(403, 'permission_denied', 'Invitation is no longer authorized.');
    const liveScope = await authorizedInvitationScope(invitation.scope, issuer);
    if (!liveScope) throw remoteError(403, 'permission_denied', 'Invitation scope is no longer authorized.');
    await getClientState().requireScopedProfile(issuer.id, liveScope.profileId);
    const normalizedDeviceId = String(deviceId || '').trim().slice(0, 128);
    if (!normalizedDeviceId) throw remoteError(400, 'invalid_request', 'deviceId is required.');
    const sessionSecret = randomBytes(32).toString('base64url');
    const createdAt = clock();
    const session = store.acceptInvitation({ invitationId, invitationSecretHash: invitation.secretHash,
      sessionId: randomUUID(), sessionSecretHash: digest(sessionSecret), deviceId: normalizedDeviceId, createdAt,
      idleExpiresAt: Math.min(invitation.expiresAt, createdAt + INVITATION_SESSION_IDLE_MS), absoluteExpiresAt: invitation.expiresAt });
    audit('invitation.accept', 'created', requestContext, null, { invitationId, sessionId: session.id });
    const { secretHash: _secretHash, issuerAccountId: _issuerAccountId, ...safeSession } = session;
    return { ...safeSession, credential: { id: session.id, secret: sessionSecret, scheme: 'LoomInvitation' } };
  }

  async function authenticateInvitation(req) {
    const match = /^LoomInvitation\s+([A-Za-z0-9-]{36})\.([A-Za-z0-9_-]{32,256})$/.exec(String(req?.headers?.authorization || '').trim());
    if (!match) return null;
    const requestContext = preflight(req, 'credential');
    const session = store.readInvitationSession(match[1], true);
    const currentTime = clock();
    if (!session || session.revokedAt || session.idleExpiresAt <= currentTime || session.absoluteExpiresAt <= currentTime
      || !safeEqual(session.secretHash, digest(match[2]))) throw remoteError(401, 'session_expired', 'Invitation session is unavailable.');
    const issuer = await getAccount(session.issuerAccountId);
    if (!issuer || !hasPermission(issuer, 'sharing.manage')) {
      store.revokeInvitationSession(session.id, 'issuer_revoked', currentTime);
      throw remoteError(403, 'permission_denied', 'Invitation session is no longer authorized.');
    }
    const liveScope = await authorizedInvitationScope(session.scope, issuer);
    if (!liveScope) throw remoteError(403, 'permission_denied', 'Invitation permissions are no longer available.');
    store.touchInvitationSession(session.id, currentTime, currentTime + INVITATION_SESSION_IDLE_MS);
    return {
      ...issuer, type: 'invitation', role: 'viewer', authentication: 'invitation-session',
      invitationSessionId: session.id, invitationId: session.invitationId, deviceId: session.deviceId,
      permissions: liveScope.permissions, devicePermissions: liveScope.permissions,
      rootIds: liveScope.rootIds, invitationMediaIds: liveScope.mediaIds,
      invitationProfileId: liveScope.profileId, invitationScope: liveScope,
      sessionId: session.id, remoteRequestContext: requestContext,
    };
  }

  async function resolveInvitationPrincipal(sessionId) {
    const session = store.readInvitationSession(sessionId, true);
    const currentTime = clock();
    if (!session || session.revokedAt || session.idleExpiresAt <= currentTime || session.absoluteExpiresAt <= currentTime) return null;
    const issuer = await getAccount(session.issuerAccountId);
    if (!issuer || !hasPermission(issuer, 'sharing.manage')) return null;
    const liveScope = await authorizedInvitationScope(session.scope, issuer);
    if (!liveScope) return null;
    return { ...issuer, type: 'invitation', role: 'viewer', authentication: 'invitation-session',
      invitationSessionId: session.id, invitationId: session.invitationId, deviceId: session.deviceId,
      permissions: liveScope.permissions, devicePermissions: liveScope.permissions, rootIds: liveScope.rootIds,
      invitationMediaIds: liveScope.mediaIds, invitationProfileId: liveScope.profileId,
      invitationScope: liveScope, sessionId: session.id };
  }

  async function invitationProfileContext(principal, media) {
    if (principal?.authentication !== 'invitation-session') return null;
    if (!media) return getClientState().requireScopedProfile(
      principal.id, principal.invitationProfileId, undefined, principal.deviceId,
    );
    if (principal.invitationMediaIds && !principal.invitationMediaIds.includes(media.id)) throw remoteError(403, 'permission_denied', 'Media is outside the invitation scope.');
    if (!principal.rootIds?.includes(media.rootId)) throw remoteError(403, 'permission_denied', 'Media is outside the invitation roots.');
    return getClientState().requireScopedProfile(principal.id, principal.invitationProfileId, media, principal.deviceId);
  }

  async function createDownload(input, principal, req) {
    const requestContext = assertPrincipal(req, principal, 'download');
    if (!hasPermission(principal, 'downloads')) throw remoteError(403, 'download_not_allowed', 'Offline downloads are not allowed.');
    const admin = getAdminService();
    const source = await admin.resolveMediaPath(String(input.mediaId || ''), principal, input.sourceId);
    if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0) {
      throw remoteError(409, 'source_unavailable', 'The media source size is unavailable for quota reservation.');
    }
    const profileContext = principal.authentication === 'invitation-session'
      ? await invitationProfileContext(principal, source)
      : await getClientState().requireActivePlaybackProfile(principal.id, principal.deviceId, source);
    const currentPolicy = policy();
    const ownerQuota = principal.authentication === 'invitation-session'
      ? Math.min(currentPolicy.downloadQuotaBytes, principal.invitationScope.downloadQuotaBytes)
      : currentPolicy.downloadQuotaBytes;
    const ttlMs = boundedInteger(input.ttlMs, currentPolicy.downloadLeaseTtlMs, 60_000, currentPolicy.downloadLeaseTtlMs);
    const secret = randomBytes(32).toString('base64url');
    const createdAt = clock();
    const lease = store.createDownloadLease({ id: randomUUID(), secretHash: digest(secret),
      ...(principal.authentication === 'invitation-session' ? { invitationSessionId: principal.invitationSessionId } : { accountId: principal.id }),
      quotaOwner: principal.authentication === 'invitation-session' ? `invitation:${principal.invitationSessionId}` : `account:${principal.id}`,
      deviceId: principal.deviceId || `account:${principal.id}`, profileId: profileContext.profileId,
      selectionRevision: profileContext.selectionRevision, rootId: source.rootId, mediaId: source.id,
      sourceId: source.sourceId, fileVersion: fileVersion(source), sizeBytes: source.sizeBytes,
      allowRanges: input.allowRanges !== false, createdAt, expiresAt: createdAt + ttlMs,
    }, ownerQuota);
    audit('download.create', 'created', requestContext, principal, { downloadId: lease.id, mediaId: lease.mediaId, sizeBytes: lease.sizeBytes });
    return { ...publicDownloadLease(lease), contentUrl: `/api/v1/downloads/${encodeURIComponent(lease.id)}/content`,
      credential: { id: lease.id, secret, scheme: 'LoomDownload' } };
  }

  async function authorizeDownload(req, downloadId) {
    const requestContext = preflight(req, 'download');
    const match = /^LoomDownload\s+([A-Za-z0-9-]{36})\.([A-Za-z0-9_-]{32,256})$/.exec(String(req?.headers?.authorization || '').trim());
    if (!match || match[1] !== downloadId) throw remoteError(401, 'session_expired', 'Download lease is unavailable.');
    const lease = store.readDownloadLease(downloadId, true);
    const currentTime = clock();
    if (!lease || lease.revokedAt || lease.expiresAt <= currentTime || !safeEqual(lease.secretHash, digest(match[2]))) {
      throw remoteError(401, 'session_expired', 'Download lease is unavailable.');
    }
    let principal;
    let invitationSession = null;
    if (lease.invitationSessionId) {
      invitationSession = store.readInvitationSession(lease.invitationSessionId, true);
      if (!invitationSession || invitationSession.revokedAt || invitationSession.idleExpiresAt <= currentTime
        || invitationSession.absoluteExpiresAt <= currentTime) throw remoteError(401, 'session_expired', 'Download lease is unavailable.');
      const issuer = await getAccount(invitationSession.issuerAccountId);
      if (!issuer || !hasPermission(issuer, 'sharing.manage') || !invitationSession.scope.permissions.includes('downloads')) {
        throw remoteError(403, 'download_not_allowed', 'Download authority was revoked.');
      }
      const liveScope = await authorizedInvitationScope(invitationSession.scope, issuer);
      if (!liveScope || !liveScope.permissions.includes('downloads')) throw remoteError(403, 'download_not_allowed', 'Download authority was revoked.');
      principal = { ...issuer, type: 'invitation', role: 'viewer', authentication: 'invitation-session',
        invitationSessionId: invitationSession.id, invitationId: invitationSession.invitationId,
        deviceId: invitationSession.deviceId, permissions: liveScope.permissions,
        devicePermissions: liveScope.permissions, rootIds: liveScope.rootIds,
        invitationMediaIds: liveScope.mediaIds, invitationProfileId: liveScope.profileId,
        invitationScope: liveScope };
    } else {
      principal = await getAccount(lease.accountId);
      if (!principal || !hasPermission(principal, 'downloads')) throw remoteError(403, 'download_not_allowed', 'Download authority was revoked.');
    }
    assertPrincipal(req, principal, 'download');
    const source = await getAdminService().resolveMediaPath(lease.mediaId, principal, lease.sourceId);
    const profileContext = principal.authentication === 'invitation-session'
      ? await invitationProfileContext(principal, source)
      : await getClientState().requireActivePlaybackProfile(principal.id, lease.deviceId, source);
    if (profileContext.profileId !== lease.profileId || profileContext.selectionRevision !== lease.selectionRevision
      || source.rootId !== lease.rootId || source.sourceId !== lease.sourceId || source.sizeBytes !== lease.sizeBytes
      || fileVersion(source) !== lease.fileVersion) throw remoteError(409, 'source_unavailable', 'Download lease binding changed.');
    if (req.headers.range && !lease.allowRanges) throw remoteError(416, 'download_not_allowed', 'This download lease does not permit byte ranges.');
    if (invitationSession && !store.touchInvitationSession(invitationSession.id, currentTime, currentTime + INVITATION_SESSION_IDLE_MS)) {
      throw remoteError(401, 'session_expired', 'Download lease is unavailable.');
    }
    return { lease, principal, source, requestContext };
  }

  function listDownloads(principal) {
    return store.listDownloadLeases(principal.authentication === 'invitation-session'
      ? { invitationSessionId: principal.invitationSessionId } : { accountId: principal.id })
      .map(publicDownloadLease);
  }

  function revokeDownload(id, principal, req) {
    const requestContext = assertPrincipal(req, principal, 'download');
    const changed = store.revokeDownloadLease(id, principal.authentication === 'invitation-session'
      ? { invitationSessionId: principal.invitationSessionId } : { accountId: principal.id }, 'user_revoked', clock());
    if (!changed) throw remoteError(404, 'not_found', 'Download lease was not found.');
    audit('download.revoke', 'revoked', requestContext, principal, { downloadId: id });
    return true;
  }

  return {
    context, preflight, assertPrincipal, policy, updatePolicy, audit,
    createInvitation, acceptInvitation, authenticateInvitation, resolveInvitationPrincipal, invitationProfileContext,
    listInvitations: (principal) => store.listInvitations(principal.id),
    revokeInvitation(id, principal, req) {
      const requestContext = assertPrincipal(req, principal, 'admin');
      if (!hasPermission(principal, 'sharing.manage')) throw remoteError(403, 'permission_denied', 'Sharing management permission is required.');
      store.revokeInvitation(id, principal.id, 'user_revoked', clock());
      audit('invitation.revoke', 'revoked', requestContext, principal, { invitationId: id });
      return true;
    },
    revokeInvitationSession(principal, req) {
      if (principal.authentication !== 'invitation-session') throw remoteError(400, 'invalid_request', 'An invitation session is required.');
      const requestContext = assertPrincipal(req, principal, 'credential');
      store.revokeInvitationSession(principal.invitationSessionId, 'user_revoked', clock());
      audit('invitation.session.revoke', 'revoked', requestContext, principal, { sessionId: principal.invitationSessionId });
      return true;
    },
    createDownload, authorizeDownload, listDownloads, revokeDownload,
    listAuditEvents: (input) => store.listAuditEvents(input),
    supportedInvitationPermissions: [...INVITATION_PERMISSIONS],
  };
}
