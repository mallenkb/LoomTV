import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLegacyV2CompatibilityHandler } from '../src/legacy-v2-adapter.js';

async function post(url, payload, context, options = {}) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), {
    method: 'POST', url, headers: { host: 'loomtv.local' }, socket: { remoteAddress: '127.0.0.1' },
  });
  let status;
  let response;
  const res = {
    writeHead(value) { status = value; },
    end(body) { response = JSON.parse(body); },
  };
  assert.equal(await createLegacyV2CompatibilityHandler(options)(req, res, context), true);
  return { status, response };
}

test('legacy pairing status preserves pending and denied responses', async () => {
  for (const [status, expected] of [['pending', 202], ['denied', 403], ['expired', 410]]) {
    const result = await post('/api/v2/pair/status', {}, {
      pairingService: { status: async () => ({ status, expiresAt: 123 }) },
    });
    assert.equal(result.status, expected);
    assert.equal(result.response.status, status);
  }
});

test('legacy pairing does not issue a session for a credential revoked during approval', async () => {
  let issuedSessions = 0;
  const result = await post('/api/v2/pair', { code: '1234' }, {
    pairingService: {
      request: async () => ({ requestId: 'request-1', requestSecret: 'secret' }),
      approve: async () => undefined,
      status: async () => ({ status: 'approved', credential: { id: 'credential-1', secret: 'secret' } }),
      authenticate: async () => null,
    },
    adminService: {
      getOwnerPrincipal: async () => ({ id: 'owner-1' }),
      issueDeviceSession: async () => { issuedSessions += 1; },
    },
  }, { getCertificateFingerprint: () => 'fingerprint', authorizeLegacyPairing: async () => true });
  assert.equal(result.status, 401);
  assert.equal(result.response.error, 'device_revoked');
  assert.equal(issuedSessions, 0);
});

test('legacy pairing reports an unavailable approval without reading missing credentials', async () => {
  const result = await post('/api/v2/pair/status', {}, {
    pairingService: { status: async () => ({ status: 'approved' }) },
  });
  assert.equal(result.status, 409);
});

test('legacy signed streams recheck live device authority for credential and session URLs', async () => {
  for (const authenticationSessionId of [null, 'session-1']) {
    const account = { id: 'user-1', type: 'user', permissions: ['stream'], deviceIds: ['other-device'] };
    let streams = 0;
    const query = new URLSearchParams({ deviceId: 'device-1', mediaId: 'media-1', profileId: 'profile-1', selectionRevision: '0', sourceId: 'source-1', fileVersion: 'version', expiresAt: '1000', signature: 'signed' });
    if (authenticationSessionId) query.set('authenticationSessionId', authenticationSessionId);
    const req = { method: 'HEAD', url: `/stream?${query}`, headers: { host: 'loomtv.local' }, socket: { remoteAddress: '127.0.0.1' } };
    let status;
    const res = { writeHead(value) { status = value; }, end() {} };
    await createLegacyV2CompatibilityHandler()(req, res, {
      pairingService: { authorizeLegacyStreamCapability: () => ({ accountId: account.id, deviceId: 'device-1', permissions: ['stream'] }) },
      adminService: { getPrincipalById: async () => account, isSessionActive: async () => true,
        resolvePlaybackPrincipal: async (id, binding) => {
          assert.equal(id, account.id);
          assert.equal(binding.authenticationDeviceId, 'device-1');
          assert.equal(binding.authenticationSessionId, authenticationSessionId);
          return null;
        }, getLibraryItem: async () => ({ id: 'media-1' }) },
      clientState: { requireActivePlaybackProfile: async () => ({ profileId: 'profile-1', selectionRevision: 0 }) },
      mediaService: { serveDirectCapability: async () => { streams += 1; res.writeHead(200); } },
    });
    assert.equal(status, 403);
    assert.equal(streams, 0);
  }
});
