import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBootstrapSecurity, DEFAULT_BOOTSTRAP_SECRET_FILENAME } from '../src/secure-bootstrap.js';
import { createHeadlessServer } from '../src/server.js';
import { assertTransportConfiguration, requestUsesSecureTransport } from '../src/transport-security.js';

const BOOTSTRAP_SECRET = 'security-test-bootstrap-secret-32-bytes';
const OWNER_PASSWORD = 'security-test-owner-password';

test('generated bootstrap secret is persisted privately, rate-limited, and removed after use', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-bootstrap-'));
  let generated;
  const security = createBootstrapSecurity({
    dataDir,
    onGenerated: (value) => { generated = value; },
  });
  await security.initialize({ ownerConfigured: false });

  assert.match(generated.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(generated.file, path.join(dataDir, DEFAULT_BOOTSTRAP_SECRET_FILENAME));
  assert.equal((await fs.readFile(generated.file, 'utf8')).trim(), generated.secret);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(generated.file)).mode & 0o077, 0, 'generated secret must not be group/world accessible');
  }

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.throws(
      () => security.authorize(`wrong-secret-${attempt}`, '192.0.2.10'),
      (error) => error.status === 401 && error.code === 'bootstrap_secret_invalid',
    );
  }
  assert.throws(
    () => security.authorize('wrong-secret-5', '192.0.2.10'),
    (error) => error.status === 429 && error.code === 'bootstrap_locked' && error.retryAfter > 0,
  );
  assert.throws(
    () => security.authorize(generated.secret, '192.0.2.10'),
    (error) => error.status === 429 && error.code === 'bootstrap_locked',
    'bootstrap lockout is independent of whether the next capability is correct',
  );

  security.authorize(generated.secret, '192.0.2.11');
  await security.invalidate();
  await assert.rejects(() => fs.access(generated.file), (error) => error.code === 'ENOENT');
  assert.throws(
    () => security.authorize(generated.secret, '192.0.2.11'),
    (error) => error.status === 409 && error.code === 'bootstrap_unavailable',
  );
});

test('operator bootstrap secret can be supplied by protected file and is logically invalidated', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-bootstrap-file-'));
  const secretFile = path.join(dataDir, 'operator-secret');
  await fs.writeFile(secretFile, `${BOOTSTRAP_SECRET}\n`, { mode: 0o600 });
  const security = createBootstrapSecurity({ dataDir, secretFile });
  await security.initialize({ ownerConfigured: false });
  assert.doesNotThrow(() => security.authorize(BOOTSTRAP_SECRET, '192.0.2.12'));
  await security.invalidate();
  await fs.access(secretFile);
  assert.throws(
    () => security.authorize(BOOTSTRAP_SECRET, '192.0.2.12'),
    (error) => error.status === 409 && error.code === 'bootstrap_unavailable',
  );
});

test('non-loopback transport policy rejects cleartext and requires secure proxy enforcement', () => {
  assert.throws(
    () => assertTransportConfiguration({ host: '0.0.0.0' }),
    (error) => error.code === 'INSECURE_TRANSPORT_CONFIGURATION' && /Refusing cleartext non-loopback bind/.test(error.message),
  );
  assert.throws(
    () => assertTransportConfiguration({ host: '0.0.0.0', trustProxy: true }),
    (error) => error.code === 'INSECURE_TRANSPORT_CONFIGURATION' && /requires --require-secure-transport/.test(error.message),
  );
  assert.doesNotThrow(() => assertTransportConfiguration({
    host: '0.0.0.0',
    trustProxy: true,
    requireSecureTransport: true,
  }));
  assert.doesNotThrow(() => assertTransportConfiguration({ host: '0.0.0.0', directTls: true }));
  assert.doesNotThrow(() => assertTransportConfiguration({
    host: '0.0.0.0',
    developmentAllowInsecureNonLoopback: true,
  }));

  assert.equal(requestUsesSecureTransport({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }, true), true);
  assert.equal(requestUsesSecureTransport({ socket: {}, headers: { 'x-forwarded-proto': 'https,http' } }, true), false);
  assert.equal(requestUsesSecureTransport({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }, false), false);
});

test('non-empty but invalid TLS material cannot satisfy the server transport gate', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-invalid-tls-'));
  const paths = { dataDir: path.join(base, 'data'), cacheDir: path.join(base, 'cache'), mediaDir: null };
  assert.throws(
    () => createHeadlessServer({
      host: '0.0.0.0',
      port: 0,
      paths,
      version: '0.0.0-test',
      bootstrapSecret: BOOTSTRAP_SECRET,
      tls: { cert: Buffer.from('not a certificate'), key: Buffer.from('not a private key') },
    }),
    /PEM|certificate|private key/i,
  );
});

test('server startup gate blocks cleartext LAN and trusted TLS proxy mode gates credentials and media', async (t) => {
  const createPaths = async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-transport-'));
    const paths = { dataDir: path.join(base, 'data'), cacheDir: path.join(base, 'cache'), mediaDir: null };
    await fs.mkdir(paths.dataDir, { recursive: true });
    await fs.mkdir(paths.cacheDir, { recursive: true });
    return paths;
  };

  const blocked = createHeadlessServer({
    host: '0.0.0.0',
    port: 0,
    paths: await createPaths(),
    version: '0.0.0-test',
    bootstrapSecret: BOOTSTRAP_SECRET,
  });
  await assert.rejects(
    () => blocked.start(),
    (error) => error.code === 'INSECURE_TRANSPORT_CONFIGURATION',
  );
  await blocked.stop();

  const proxy = createHeadlessServer({
    host: '0.0.0.0',
    port: 0,
    paths: await createPaths(),
    version: '0.0.0-test',
    bootstrapSecret: BOOTSTRAP_SECRET,
    requireSecureTransport: true,
    trustProxy: true,
  });
  t.after(() => proxy.stop());
  const address = await proxy.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({ name: 'Owner', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });

  const cleartext = await fetch(`${baseUrl}/api/v1/auth/owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(cleartext.status, 426);

  const spoofedChain = await fetch(`${baseUrl}/api/v1/auth/owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https,http' },
    body,
  });
  assert.equal(spoofedChain.status, 426);

  const proxied = await fetch(`${baseUrl}/api/v1/auth/owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body,
  });
  assert.equal(proxied.status, 201);

  const mediaOverCleartext = await fetch(`${baseUrl}/api/media/items`);
  assert.equal(mediaOverCleartext.status, 426, 'internal media endpoints must share the transport gate');
});
