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
