import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAdminApiHandler } from '../src/admin-page.js';
import { createPublicApiHandler } from '../src/public-api.js';
import { createHeadlessServer } from '../src/server.js';
import {
  createTrustedProxyPolicy,
  normalizeIpAddress,
} from '../src/trusted-proxy.js';

function request(remoteAddress, forwardedFor, forwardedProto) {
  return {
    headers: {
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
    },
    socket: { remoteAddress },
  };
}

function jsonRequest({ url, remoteAddress, body, forwardedFor, forwardedProto }) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.url = url;
  req.headers = {
    'content-type': 'application/json',
    ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
  };
  req.socket = { remoteAddress };
  return req;
}

function responseRecorder() {
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  return {
    status: 0,
    headers: {},
    body: '',
    finished,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += chunk;
      resolveFinished();
    },
  };
}

test('direct peers keep their canonical socket address and cannot spoof forwarding headers', () => {
  const policy = createTrustedProxyPolicy();
  assert.equal(
    policy.clientAddress(request('198.51.100.7', '203.0.113.9')),
    '198.51.100.7',
  );
  assert.equal(
    policy.clientAddress(request('2001:0db8:0:0:0:0:0:7')),
    '2001:db8::7',
  );
  assert.equal(policy.isSecureRequest(request('198.51.100.7', undefined, 'https')), false);
});

test('one trusted proxy may supply the canonical client address', () => {
  const policy = createTrustedProxyPolicy('10.0.0.0/8');
  assert.equal(
    policy.clientAddress(request('10.2.3.4', '203.0.113.9')),
    '203.0.113.9',
  );
});

test('multiple trusted hops are walked from the immediate peer toward the client', () => {
  const policy = createTrustedProxyPolicy(['10.0.0.0/8', '2001:db8:1::/48']);
  assert.equal(
    policy.clientAddress(request('10.0.0.3', '203.0.113.9, 2001:db8:1::2')),
    '203.0.113.9',
  );
});

test('an untrusted intermediary terminates the forwarding chain', () => {
  const policy = createTrustedProxyPolicy('10.0.0.0/8');
  assert.equal(
    policy.clientAddress(request('10.0.0.3', '203.0.113.9, 192.0.2.44')),
    '192.0.2.44',
  );
  assert.equal(
    policy.clientAddress(request('10.0.0.3', '203.0.113.9, not-an-address')),
    '10.0.0.3',
  );
});

test('IPv4-mapped IPv6 addresses share IPv4 trust and identity semantics', () => {
  const policy = createTrustedProxyPolicy('10.0.0.0/8');
  assert.equal(normalizeIpAddress('::ffff:192.0.2.9'), '192.0.2.9');
  assert.equal(policy.isTrustedAddress('::ffff:10.2.3.4'), true);
  assert.equal(
    policy.clientAddress(request('::ffff:10.2.3.4', '::ffff:203.0.113.9')),
    '203.0.113.9',
  );
});

test('trusted proxy configuration validates and canonicalizes IPv4, IPv6, and CIDRs', () => {
  const policy = createTrustedProxyPolicy('10.2.3.4/8, 2001:0db8:1::5/48, ::ffff:192.0.2.9/120');
  assert.deepEqual(policy.trustedProxies, [
    '10.0.0.0/8',
    '2001:db8:1::/48',
    '192.0.2.0/24',
  ]);

  for (const malformed of [
    'proxy.internal',
    '10.0.0.1/33',
    '10.0.0.1/',
    '2001:db8::1/129',
    '10.0.0.1,,192.0.2.1',
    '::ffff:192.0.2.1/64',
    ['10.0.0.1', ''],
  ]) {
    assert.throws(() => createTrustedProxyPolicy(malformed), /trusted proxy/i);
  }
});

test('malformed trust configuration aborts server construction', () => {
  assert.throws(() => createHeadlessServer({
    host: '127.0.0.1',
    port: 0,
    paths: { dataDir: '/unused', cacheDir: '/unused', mediaDir: null },
    version: '0.0.0-test',
    trustedProxies: 'not-a-proxy-address',
  }), /trusted proxy/i);
});

test('forwarded transport is accepted only from the explicit immediate proxy', () => {
  const policy = createTrustedProxyPolicy('10.0.0.0/8');
  assert.equal(policy.isSecureRequest(request('192.0.2.4', undefined, 'https')), false);
  assert.equal(policy.isSecureRequest(request('10.0.0.4', undefined, 'HTTPS')), true);
  assert.equal(policy.isSecureRequest(request('10.0.0.4', undefined, 'http, https')), false);
  assert.equal(policy.isSecureRequest(request('10.0.0.4', undefined, 'https, http')), false);
  assert.equal(policy.isSecureRequest(request('10.0.0.4', undefined, ',https')), false);
  assert.equal(policy.isSecureRequest(request('10.0.0.4', undefined, `https${' '.repeat(40)}`)), false);
  assert.equal(policy.isSecureRequest({ headers: {}, socket: { encrypted: true, remoteAddress: '192.0.2.4' } }), true);
});

test('both login API surfaces use the same trusted client identity and secure-transport policy', async () => {
  const addresses = [];
  const service = {
    createSession: async (input) => {
      addresses.push(input.address);
      return { adminToken: 'test-token' };
    },
    isOwnerConfigured: async () => true,
  };
  const proxyPolicy = createTrustedProxyPolicy('10.0.0.0/8');
  const publicDependencies = {
    clientState: {}, mediaService: {}, pairingService: {},
    remotePolicy: {
      authenticateInvitation: async () => null,
      assertPrincipal: () => undefined,
      audit: () => undefined,
    },
    getRuntimeHealth: async () => ({}), version: '0.0.0-test',
  };
  const adminHandler = createAdminApiHandler({
    service,
    proxyPolicy,
    requireSecureTransport: true,
    ownerConfigured: service.isOwnerConfigured,
  });
  const publicHandler = createPublicApiHandler({
    service,
    proxyPolicy,
    requireSecureTransport: true,
    ...publicDependencies,
  });

  for (const [handler, url] of [
    [adminHandler, '/api/admin/session'],
    [publicHandler, '/api/v1/auth/session'],
  ]) {
    const req = jsonRequest({
      url,
      remoteAddress: '10.0.0.3',
      forwardedFor: '203.0.113.9',
      forwardedProto: 'https',
      body: { password: 'not-a-secret-test-value' },
    });
    const res = responseRecorder();
    assert.equal(await handler(req, res), true);
    await res.finished;
    assert.equal(res.status, 200);
  }
  assert.deepEqual(addresses, ['203.0.113.9', '203.0.113.9']);

  const spoofed = jsonRequest({
    url: '/api/v1/auth/session',
    remoteAddress: '192.0.2.44',
    forwardedFor: '203.0.113.9',
    forwardedProto: 'https',
    body: { password: 'not-a-secret-test-value' },
  });
  const rejected = responseRecorder();
  assert.equal(await publicHandler(spoofed, rejected), true);
  await rejected.finished;
  assert.equal(rejected.status, 426);
  assert.equal(addresses.length, 2, 'spoofed forwarding headers must not reach authentication');

  const directHandler = createPublicApiHandler({
    service,
    proxyPolicy,
    ...publicDependencies,
  });
  const direct = jsonRequest({
    url: '/api/v1/auth/session',
    remoteAddress: '192.0.2.44',
    forwardedFor: '203.0.113.9',
    body: { password: 'not-a-secret-test-value' },
  });
  const directResponse = responseRecorder();
  assert.equal(await directHandler(direct, directResponse), true);
  await directResponse.finished;
  assert.equal(directResponse.status, 200, 'direct LAN login remains available when secure transport is not required');
  assert.equal(addresses.at(-1), '192.0.2.44', 'an untrusted peer cannot choose its authentication bucket');
});

test('admin first-run owner creation forwards the bootstrap capability and trusted client address', async () => {
  let ownerInput;
  const handler = createAdminApiHandler({
    service: {
      createOwner: async (input) => {
        ownerInput = input;
        return { adminToken: 'owner-token' };
      },
      isOwnerConfigured: async () => false,
    },
    ownerConfigured: async () => false,
    proxyPolicy: createTrustedProxyPolicy('10.0.0.0/8'),
    requireSecureTransport: true,
  });
  const req = jsonRequest({
    url: '/api/admin/onboarding/owner',
    remoteAddress: '10.0.0.3',
    forwardedFor: '203.0.113.12',
    forwardedProto: 'https',
    body: { name: 'Owner', password: 'password-value', bootstrapSecret: 'bootstrap-value' },
  });
  const res = responseRecorder();
  assert.equal(await handler(req, res), true);
  await res.finished;
  assert.equal(res.status, 201);
  assert.deepEqual(ownerInput, {
    name: 'Owner',
    password: 'password-value',
    bootstrapSecret: 'bootstrap-value',
    address: '203.0.113.12',
  });
});
