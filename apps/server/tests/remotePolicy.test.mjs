import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRemotePolicyService, remoteRouteClass } from '../src/remote-policy.js';

function fixture({ address = '127.0.0.1', clientState = {} } = {}) {
  const events = [];
  const policy = { enabled: true, downloadQuotaBytes: 1024, downloadLeaseTtlMs: 60_000, invitationTtlMs: 60_000 };
  const service = createRemotePolicyService({
    store: { readRemotePolicy: () => policy, appendAuditEvent: (event) => events.push(event) },
    proxyPolicy: { clientAddress: () => address, isSecureRequest: () => true },
    getAccount: async () => null,
    getAdminService: () => ({}),
    getClientState: () => clientState,
    clock: () => 1000,
  });
  return { service, events };
}

test('remote audit details retain bounded scalars and exclude credentials and paths', () => {
  const { service, events } = fixture();
  service.audit('media.request', 'denied', service.context({ headers: {} }), null, {
    mediaId: 'item-1', count: 2, allowed: false, missing: null,
    secret: 'hidden', filePath: '/private/media', nested: { id: 1 }, infinite: Infinity,
    message: 'x'.repeat(300),
  });
  assert.deepEqual(events[0].details, {
    mediaId: 'item-1', count: 2, allowed: false, missing: null, message: 'x'.repeat(256),
  });
  assert.equal(events[0].addressHash.length, 64);
  assert.equal(JSON.stringify(events[0]).includes('127.0.0.1'), false);
});

test('unknown remote route classes use the public rate limit and audit denial once', () => {
  const { service, events } = fixture({ address: '198.51.100.10' });
  for (let index = 0; index < 180; index += 1) service.preflight({ headers: {} }, 'unregistered-route');
  for (let index = 0; index < 2; index += 1) {
    assert.throws(() => service.preflight({ headers: {} }, 'unregistered-route'), {
      code: 'rate_limited', status: 429, retryAfter: 600,
    });
  }
  assert.equal(events.filter((event) => event.action === 'remote.rate-limit').length, 1);
});

test('an invitation without a bound profile fails before client-state access', async () => {
  let profileReads = 0;
  const { service } = fixture({ clientState: { requireScopedProfile() { profileReads += 1; } } });
  await assert.rejects(service.invitationProfileContext({
    id: 'issuer-1', authentication: 'invitation-session', rootIds: ['root-1'],
  }, { id: 'media-1', rootId: 'root-1' }), { code: 'permission_denied', status: 403 });
  assert.equal(profileReads, 0);
});

test('invitation resolution returns its shorter live expiry and rechecks revocation after profile authorization', async () => {
  let currentTime = 1000;
  let revokedAt = null;
  let revokeDuringProfileCheck = false;
  const session = {
    id: 'invitation-1', invitationId: 'share-1', issuerAccountId: 'issuer-1', deviceId: 'tv-1',
    idleExpiresAt: 50_000, absoluteExpiresAt: 30_000,
    scope: { profileId: 'profile-1', rootIds: ['root-1'], mediaIds: null, permissions: ['library.read', 'stream'] },
  };
  const service = createRemotePolicyService({
    store: { readInvitationSession: () => ({ ...session, revokedAt }) },
    proxyPolicy: { clientAddress: () => '127.0.0.1', isSecureRequest: () => true },
    getAccount: async () => ({ id: 'issuer-1', type: 'owner', rootIds: null }),
    getAdminService: () => ({}),
    getClientState: () => ({ requireScopedProfile: async () => {
      if (revokeDuringProfileCheck) revokedAt = currentTime;
      return { profileId: 'profile-1' };
    } }),
    clock: () => currentTime,
  });
  assert.equal((await service.resolveInvitationPrincipal(session.id)).invitationSessionExpiresAt, 30_000);
  session.idleExpiresAt = 20_000;
  assert.equal((await service.resolveInvitationPrincipal(session.id)).invitationSessionExpiresAt, 20_000);
  revokeDuringProfileCheck = true;
  assert.equal(await service.resolveInvitationPrincipal(session.id), null);
  revokedAt = null;
  revokeDuringProfileCheck = false;
  currentTime = 20_000;
  assert.equal(await service.resolveInvitationPrincipal(session.id), null, 'expiry is inclusive');
});

test('invitation authentication refuses a session that expires during its profile check', async () => {
  const id = '12345678-1234-1234-1234-123456789012';
  const secret = 'a'.repeat(32);
  let currentTime = 1000;
  let touchTime;
  const session = {
    id, invitationId: 'share-1', issuerAccountId: 'issuer-1', deviceId: 'tv-1',
    secretHash: createHash('sha256').update(secret).digest('hex'),
    idleExpiresAt: 1500, absoluteExpiresAt: 5000,
    scope: { profileId: 'profile-1', rootIds: ['root-1'], mediaIds: null, permissions: ['library.read', 'stream'] },
  };
  const service = createRemotePolicyService({
    store: {
      readInvitationSession: () => session,
      touchInvitationSession: (_id, seenAt) => { touchTime = seenAt; return seenAt < session.idleExpiresAt; },
    },
    proxyPolicy: { clientAddress: () => '127.0.0.1', isSecureRequest: () => true },
    getAccount: async () => ({ id: 'issuer-1', type: 'owner', rootIds: null }),
    getAdminService: () => ({}),
    getClientState: () => ({ requireScopedProfile: async () => { currentTime = 1500; return { profileId: 'profile-1' }; } }),
    clock: () => currentTime,
  });
  await assert.rejects(service.authenticateInvitation({ headers: { authorization: `LoomInvitation ${id}.${secret}` } }), {
    status: 401, code: 'session_expired',
  });
  assert.equal(touchTime, 1500, 'the atomic touch checks the completion time instead of the earlier request time');
});

test('valid invitation profile bindings preserve the media and device restrictions', async () => {
  const calls = [];
  const profile = { profileId: 'profile-1', selectionRevision: 3 };
  const { service } = fixture({ clientState: { requireScopedProfile(...args) { calls.push(args); return profile; } } });
  const principal = {
    id: 'issuer-1', authentication: 'invitation-session', rootIds: ['root-1'],
    invitationProfileId: 'profile-1', invitationMediaIds: ['media-1'], deviceId: 'device-1',
  };
  const media = { id: 'media-1', rootId: 'root-1' };
  assert.equal(await service.invitationProfileContext(principal, media), profile);
  assert.deepEqual(calls, [['issuer-1', 'profile-1', media, 'device-1']]);
  await assert.rejects(service.invitationProfileContext(principal, { id: 'media-2', rootId: 'root-1' }), {
    code: 'permission_denied', status: 403,
  });
  assert.equal(calls.length, 1);
});

test('invitation profile bindings treat a null device ID as absent', async () => {
  const calls = [];
  const profile = { profileId: 'profile-1', selectionRevision: 3 };
  const { service } = fixture({ clientState: { requireScopedProfile(...args) { calls.push(args); return profile; } } });
  const principal = {
    id: 'issuer-1', authentication: 'invitation-session', rootIds: ['root-1'],
    invitationProfileId: 'profile-1', invitationMediaIds: ['media-1'], deviceId: null,
  };
  const media = { id: 'media-1', rootId: 'root-1' };

  assert.equal(await service.invitationProfileContext(principal, media), profile);
  assert.deepEqual(calls, [['issuer-1', 'profile-1', media, undefined]]);
});

test('polling one pairing approval does not use up the pairing creation budget', () => {
  const { service } = fixture({ address: '198.51.100.20' });
  const request = { headers: {} };
  const create = remoteRouteClass('POST', '/api/v1/pairing/requests');
  const poll = remoteRouteClass('GET', '/api/v1/pairing/requests/request-1');
  assert.equal(create, 'pairing');
  assert.equal(poll, 'pairingStatus');
  assert.equal(remoteRouteClass('POST', '/api/v1/pairing/requests/request-1/approve'), 'pairing');

  service.preflight({ ...request }, create);
  // A 1.5-second poll for the full five-minute approval window.
  for (let index = 0; index < 200; index += 1) service.preflight({ ...request }, poll);
  // Creation still has its own strict budget: 12 per ten minutes in total.
  for (let index = 0; index < 11; index += 1) service.preflight({ ...request }, create);
  assert.throws(() => service.preflight({ ...request }, create), { code: 'rate_limited', status: 429 });
});

test('pairing status polls remain rate limited', () => {
  const { service } = fixture({ address: '198.51.100.21' });
  const poll = remoteRouteClass('GET', '/api/v1/pairing/requests/request-1');
  for (let index = 0; index < 600; index += 1) service.preflight({ headers: {} }, poll);
  assert.throws(() => service.preflight({ headers: {} }, poll), { code: 'rate_limited', status: 429 });
});


test('invitation HLS requires stream permission, a plan, and scoped media', async () => {
  const calls = [];
  const profile = { profileId: 'profile-1', selectionRevision: 3 };
  const { service } = fixture({ clientState: { requireScopedProfile(...args) { calls.push(args); return profile; } } });
  const principal = {
    id: 'issuer-1', authentication: 'invitation-session', invitationSessionId: 'session-1',
    permissions: ['library.read', 'stream'], devicePermissions: ['library.read', 'stream'],
    rootIds: ['root-1'], invitationProfileId: 'profile-1', invitationMediaIds: ['media-1'], deviceId: 'tv-1',
  };
  const media = { id: 'media-1', rootId: 'root-1' };
  assert.equal(await service.authorizeInvitationTranscode(principal, media, 'server-issued-plan'), profile);
  assert.deepEqual(calls, [['issuer-1', 'profile-1', media, 'tv-1']]);
  await assert.rejects(service.authorizeInvitationTranscode(principal, media, null), { status: 401, code: 'playback_session_invalid' });
  await assert.rejects(service.authorizeInvitationTranscode({ ...principal, permissions: ['library.read'] }, media, 'plan'), { status: 403 });
  await assert.rejects(service.authorizeInvitationTranscode(principal, { ...media, id: 'media-2' }, 'plan'), { status: 403 });
  await assert.rejects(service.authorizeInvitationTranscode(principal, { ...media, rootId: 'root-2' }, 'plan'), { status: 403 });
  await assert.rejects(service.authorizeInvitationTranscode({ ...principal, invitationSessionId: undefined }, media, 'plan'), { status: 403 });
  assert.equal(service.supportedInvitationPermissions.includes('transcode'), false);
  assert.equal(calls.length, 1, 'scope failures do not reach the profile store');
});

test('offline download capabilities retain device remote grants and lose access when excluded', async () => {
  let address = '127.0.0.1';
  let allowed = true;
  let devicePermissions = ['downloads'];
  const account = { id: 'user-1', type: 'user', permissions: ['downloads', 'remote.access'], rootIds: null };
  const principal = { ...account, authentication: 'device-credential', deviceId: 'device-1', devicePermissions };
  const source = { id: 'media-1', sourceId: 'source-1', rootId: 'root-1', sizeBytes: 10, modifiedAtMs: 1, fileId: { dev: 1, ino: 2 } };
  let lease;
  const service = createRemotePolicyService({
    store: { readRemotePolicy: () => ({ enabled: true, downloadQuotaBytes: 1024, downloadLeaseTtlMs: 60_000 }),
      appendAuditEvent() {}, createDownloadLease: (input) => { lease = input; return input; }, readDownloadLease: () => lease },
    proxyPolicy: { clientAddress: () => address, isSecureRequest: () => true },
    getAccount: async () => account,
    getAdminService: () => ({ resolveMediaPath: async () => source, resolvePlaybackPrincipal: async (id, binding) => {
      assert.equal(id, account.id); assert.equal(binding.authenticationDeviceId, 'device-1');
      return allowed ? { ...principal, devicePermissions } : null;
    } }),
    getClientState: () => ({ requireActivePlaybackProfile: async () => ({ profileId: 'profile-1', selectionRevision: 0 }) }),
    clock: () => 1000,
  });
  const download = await service.createDownload({ headers: {} }, principal, { mediaId: source.id });
  const req = () => ({ headers: { authorization: `LoomDownload ${download.credential.id}.${download.credential.secret}` } });
  assert.ok(await service.authorizeDownload(req(), download.credential.id));
  address = '198.51.100.10';
  await assert.rejects(service.authorizeDownload(req(), download.credential.id), { status: 403, code: 'remote_access_disabled' });
  address = '127.0.0.1'; allowed = false;
  await assert.rejects(service.authorizeDownload(req(), download.credential.id), { status: 403, code: 'download_not_allowed' });
  allowed = true; devicePermissions = [];
  await assert.rejects(service.authorizeDownload(req(), download.credential.id), { status: 403, code: 'download_not_allowed' });
});
