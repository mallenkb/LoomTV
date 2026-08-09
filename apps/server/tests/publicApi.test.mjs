import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHeadlessServer } from '../src/server.js';

const OWNER_PASSWORD = 'public-api-password';
const BOOTSTRAP_SECRET = 'public-api-bootstrap-secret-32-bytes';

async function startServer() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-public-api-'));
  const paths = {
    dataDir: path.join(base, 'data'),
    cacheDir: path.join(base, 'cache'),
    mediaDir: null,
  };
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.cacheDir, { recursive: true });
  const server = createHeadlessServer({ host: '127.0.0.1', port: 0, paths, version: '0.0.0-test', bootstrapSecret: BOOTSTRAP_SECRET });
  const address = await server.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
}

function api(baseUrl, token) {
  return async function call(method, route, body) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, headers: response.headers, payload };
  };
}

test('public API end-to-end: discovery, onboarding, profiles, and progress', async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.stop());
  const anonymous = api(baseUrl);

  await t.test('discovery and onboarding state are public', async () => {
    const discovery = await anonymous('GET', '/api/v1/discovery');
    assert.equal(discovery.status, 200);
    assert.equal(discovery.headers.get('x-loomtv-api-version'), '1');

    const onboarding = await anonymous('GET', '/api/v1/auth/onboarding');
    assert.equal(onboarding.status, 200);
    assert.equal(onboarding.payload.data.ownerConfigured, false);

    const openapi = await anonymous('GET', '/api/v1/openapi.json');
    assert.equal(openapi.status, 200);
    assert.equal(openapi.payload.openapi, '3.0.3');
    for (const pathItem of Object.values(openapi.payload.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (method === 'parameters') continue;
        assert.ok(operation.responses, `every operation documents responses (${method})`);
      }
    }
  });

  await t.test('authenticated routes reject anonymous requests with the versioned error envelope', async () => {
    const me = await anonymous('GET', '/api/v1/auth/me');
    assert.equal(me.status, 401);
    assert.equal(me.payload.ok, false);
    assert.equal(me.payload.error.code, 'auth_required');
    assert.equal(typeof me.payload.error.message, 'string');
    assert.equal(me.headers.get('x-loomtv-api-version'), '1');
  });

  let token;
  await t.test('owner onboarding issues a session token exactly once', async () => {
    const missingSecret = await anonymous('POST', '/api/v1/auth/owner', { name: 'Owner', password: OWNER_PASSWORD });
    assert.equal(missingSecret.status, 401);
    assert.equal(missingSecret.payload.error.code, 'bootstrap_secret_invalid');

    const rejected = await anonymous('POST', '/api/v1/auth/owner', {
      name: 'Owner',
      password: 'short',
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    assert.equal(rejected.status, 400);

    const created = await anonymous('POST', '/api/v1/auth/owner', {
      name: 'Owner',
      password: OWNER_PASSWORD,
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    assert.equal(created.status, 201);
    token = created.payload.data.adminToken;
    assert.equal(typeof token, 'string');

    const again = await anonymous('POST', '/api/v1/auth/owner', {
      name: 'Owner',
      password: OWNER_PASSWORD,
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    assert.equal(again.status, 409);
    assert.equal(again.payload.error.code, 'owner_exists');
  });

  await t.test('sessions authenticate and report the signed-in account', async () => {
    const authed = api(baseUrl, token);
    const me = await authed('GET', '/api/v1/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.payload.data.user.type, 'owner');

    const wrong = await anonymous('POST', '/api/v1/auth/session', { password: 'incorrect-password' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.payload.error.code, 'invalid_credentials');
  });

  await t.test('profile lifecycle and progress; progress rejects unknown media', async () => {
    const authed = api(baseUrl, token);
    const created = await authed('POST', '/api/v1/profiles', { name: 'Living room' });
    assert.equal(created.status, 201);
    const profileId = created.payload.data.profile.id;

    const listed = await authed('GET', '/api/v1/profiles');
    assert.equal(listed.payload.data.profiles.length, 1);

    const selected = await authed('POST', `/api/v1/profiles/${profileId}/select`);
    assert.equal(selected.status, 200);

    // Progress writes verify the media exists in the catalog first.
    const unknown = await authed('PUT', `/api/v1/profiles/${profileId}/progress/no-such-media`, { position: 10, duration: 100 });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.error.code, 'media_not_found');

    const empty = await authed('GET', `/api/v1/profiles/${profileId}/progress`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.payload.data.progress, {});
  });

  await t.test('library routes work end to end against a real media folder', async () => {
    const authed = api(baseUrl, token);
    const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-public-media-'));
    await fs.writeFile(path.join(mediaDir, 'sample.mkv'), 'fake-video');
    await fs.mkdir(path.join(mediaDir, 'My Show', 'Season 1'), { recursive: true });
    await fs.writeFile(path.join(mediaDir, 'My Show', 'Season 1', 'My.Show.S01E01.mkv'), 'fake-episode-1');
    await fs.writeFile(path.join(mediaDir, 'My Show', 'Season 1', 'My.Show.S01E02.mkv'), 'fake-episode-2');

    const root = await authed('POST', '/api/v1/library/roots', { path: mediaDir });
    assert.equal(root.status, 201);

    const scan = await authed('POST', '/api/v1/library/scan', {});
    assert.equal(scan.status, 202);
    const deadline = Date.now() + 5000;
    let status;
    do {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      status = await authed('GET', '/api/v1/library/scan');
    } while (status.payload.data.state === 'scanning' && Date.now() < deadline);
    assert.equal(status.payload.data.state, 'completed');

    const library = await authed('GET', '/api/v1/library');
    assert.equal(library.payload.data.items.length, 3);
    const movie = library.payload.data.items.find((item) => item.kind === 'movie');
    assert.equal(movie.title, 'sample');
    for (const item of library.payload.data.items) assert.equal(item.path, undefined, 'server paths must not leak');
    const mediaId = movie.id;

    const series = await authed('GET', '/api/v1/library/series');
    assert.equal(series.status, 200);
    assert.equal(series.payload.data.series.length, 1);
    const show = series.payload.data.series[0];
    assert.equal(show.title, 'My Show');
    assert.equal(show.episodeCount, 2);
    assert.equal(show.seasons[0].season, 1);
    assert.deepEqual(show.seasons[0].episodes.map((episode) => episode.series.episode), [1, 2]);

    const media = await authed('GET', `/api/v1/media/${encodeURIComponent(mediaId)}`);
    assert.equal(media.status, 200);
    assert.match(media.payload.data.directUrl, /^\/api\/v1\/media\/.+\/direct\?token=/);

    // The issued playback token must satisfy the direct route without a
    // bearer header, the way an HTMLMediaElement uses it.
    const direct = await fetch(`${baseUrl}${media.payload.data.directUrl}`, { method: 'HEAD' });
    assert.equal(direct.status, 200);

    // A stale or forged query token must not.
    const forged = await fetch(`${baseUrl}/api/v1/media/${encodeURIComponent(mediaId)}/direct?token=forged-token`, { method: 'HEAD' });
    assert.equal(forged.status, 401);

    // Progress against real media persists.
    const profile = await authed('GET', '/api/v1/profiles');
    const profileId = profile.payload.data.profiles[0].id;
    const saved = await authed('PUT', `/api/v1/profiles/${profileId}/progress/${encodeURIComponent(mediaId)}`, { position: 61, duration: 120 });
    assert.equal(saved.status, 200);
    const read = await authed('GET', `/api/v1/profiles/${profileId}/progress/${encodeURIComponent(mediaId)}`);
    assert.equal(read.payload.data.progress.position, 61);
  });

  await t.test('signing out revokes the token', async () => {
    const authed = api(baseUrl, token);
    const revoked = await authed('DELETE', '/api/v1/auth/session');
    assert.equal(revoked.status, 204);
    const me = await authed('GET', '/api/v1/auth/me');
    assert.equal(me.status, 401);
  });
});

test('public and admin password routes share the credential-reset policy', async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.stop());
  const anonymous = api(baseUrl);
  const ownerCreated = await anonymous('POST', '/api/v1/auth/owner', {
    name: 'Owner',
    password: 'route-owner-password-1',
    bootstrapSecret: BOOTSTRAP_SECRET,
  });
  assert.equal(ownerCreated.status, 201);
  const owner = api(baseUrl, ownerCreated.payload.data.adminToken);

  const managerCreated = await owner('POST', '/api/v1/users', {
    name: 'Manager',
    password: 'route-manager-password-1',
    role: 'user',
    permissions: ['users.manage', 'account.password'],
    rootIds: null,
  });
  const adminCreated = await owner('POST', '/api/v1/users', {
    name: 'Administrator',
    password: 'route-admin-password-1',
    role: 'admin',
    rootIds: null,
  });
  const selfCreated = await owner('POST', '/api/v1/users', {
    name: 'Self service',
    password: 'route-self-password-1',
    role: 'viewer',
    permissions: [],
    rootIds: null,
  });
  assert.equal(managerCreated.status, 201);
  assert.equal(adminCreated.status, 201);
  assert.equal(selfCreated.status, 201);
  const managerId = managerCreated.payload.data.user.id;
  const adminId = adminCreated.payload.data.user.id;

  const managerSignedIn = await anonymous('POST', '/api/v1/auth/session', {
    username: 'Manager',
    password: 'route-manager-password-1',
  });
  const manager = api(baseUrl, managerSignedIn.payload.data.adminToken);
  const deniedPublic = await manager('POST', '/api/v1/account/password', {
    userId: adminId,
    newPassword: 'route-stolen-password-1',
  });
  assert.equal(deniedPublic.status, 403);
  assert.equal(deniedPublic.payload.error.code, 'permission_denied');
  const deniedAdmin = await manager('POST', '/api/admin/account/password', {
    userId: adminId,
    newPassword: 'route-stolen-password-2',
  });
  assert.equal(deniedAdmin.status, 403);
  assert.equal(deniedAdmin.payload.error, 'permission_denied');

  const selfSignedIn = await anonymous('POST', '/api/v1/auth/session', {
    username: 'Self service',
    password: 'route-self-password-1',
  });
  const selfPublic = api(baseUrl, selfSignedIn.payload.data.adminToken);
  const changedPublic = await selfPublic('POST', '/api/v1/account/password', {
    currentPassword: 'route-self-password-1',
    newPassword: 'route-self-password-2',
  });
  assert.equal(changedPublic.status, 200);
  const selfAdmin = api(baseUrl, changedPublic.payload.data.adminToken);
  const changedAdmin = await selfAdmin('POST', '/api/admin/account/password', {
    currentPassword: 'route-self-password-2',
    newPassword: 'route-self-password-3',
  });
  assert.equal(changedAdmin.status, 200, 'the admin route must not impose a different permission gate on self-service');

  const ownerReset = await owner('POST', '/api/admin/account/password', {
    userId: managerId,
    newPassword: 'route-manager-password-2',
  });
  assert.equal(ownerReset.status, 200);
  assert.deepEqual(ownerReset.payload, { changed: true });
  const revokedManager = await manager('GET', '/api/v1/auth/me');
  assert.equal(revokedManager.status, 401, 'an authorized owner reset must revoke the target session');
});
