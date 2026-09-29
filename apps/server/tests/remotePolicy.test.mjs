import assert from 'node:assert/strict';
import test from 'node:test';
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
