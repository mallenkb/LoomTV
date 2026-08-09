import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHeadlessAdminService, headlessAdminStateFilename } from '../src/admin-service.js';
import { createHeadlessMediaService } from '../src/media-service.js';
import { createBootstrapSecurity } from '../src/secure-bootstrap.js';
import { createHeadlessServer } from '../src/server.js';
import { statContainedFile } from '../src/media-path-guard.js';

const BOOTSTRAP_SECRET = 'containment-test-bootstrap-secret-32-bytes';
const OWNER_PASSWORD = 'containment-test-password';
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX-only symlink semantics' : false };

function bearer(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

/**
 * A service whose catalog has been rewritten on disk, the way a corrupt state
 * file, an imported desktop catalog, or a second writer would leave it. The
 * scanner refuses to index a symlink in the first place, so tampering is how a
 * hostile catalog entry realistically arrives.
 */
async function serviceWithCatalogPath(hostilePath) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-contain-'));
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-contain-media-')));
  const mediaDir = path.join(base, 'library');
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.writeFile(path.join(mediaDir, 'inside.mkv'), 'in-root-bytes');

  const logs = [];
  const bootstrapSecurity = createBootstrapSecurity({ dataDir, secret: BOOTSTRAP_SECRET });
  await bootstrapSecurity.initialize({ ownerConfigured: false });
  const options = {
    dataDir,
    version: '0.0.0-test',
    getRuntimeHealth: async () => ({ media: { state: 'online' } }),
    getSessions: async () => [],
    bootstrapSecurity,
  };
  const service = createHeadlessAdminService(options);
  const session = await service.createOwner({ name: 'Owner', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET });
  const principal = await service.authenticateRequest(bearer(session.adminToken));
  await service.addLibraryRoot({ path: mediaDir }, principal);
  await service.startLibraryScan({}, principal);
  for (let waited = 0; waited < 200; waited += 1) {
    if ((await service.getScanStatus(principal)).state !== 'scanning') break;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }

  const statePath = path.join(dataDir, headlessAdminStateFilename);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.catalog.length, 1, 'the fixture library must index exactly one file');
  const itemId = state.catalog[0].id;
  if (hostilePath) {
    state.catalog[0].path = await hostilePath({ base, mediaDir });
    await fs.writeFile(statePath, JSON.stringify(state));
  }

  const reloaded = createHeadlessAdminService({ ...options, appendLog: undefined });
  const reloadedSession = await reloaded.createSession({ password: OWNER_PASSWORD });
  const reloadedPrincipal = await reloaded.authenticateRequest(bearer(reloadedSession.adminToken));
  return { service: reloaded, principal: reloadedPrincipal, itemId, base, mediaDir, dataDir, logs };
}

async function rejection(promise) {
  try {
    return { error: null, value: await promise };
  } catch (error) {
    return { error, value: null };
  }
}

test('an in-root catalog entry still resolves to a canonical, contained path', async () => {
  const { service, principal, itemId, mediaDir } = await serviceWithCatalogPath(null);
  const resolved = await service.resolveMediaPath(itemId, principal);
  assert.equal(resolved.path, path.join(mediaDir, 'inside.mkv'));
  assert.equal(resolved.rootPath, mediaDir);
  assert.equal(typeof resolved.fileId.ino, 'number');
  assert.equal(resolved.sizeBytes, 'in-root-bytes'.length);
});

test('a catalog entry pointing at a symlinked file outside the root is refused', POSIX_ONLY, async () => {
  const secretName = 'private.mkv';
  const { service, principal, itemId, base } = await serviceWithCatalogPath(async ({ base: fixtureBase, mediaDir }) => {
    const secret = path.join(fixtureBase, secretName);
    await fs.writeFile(secret, 'secret-bytes');
    const link = path.join(mediaDir, 'looks-inside.mkv');
    await fs.symlink(secret, link, 'file');
    return link;
  });

  const { error } = await rejection(service.resolveMediaPath(itemId, principal));
  assert.equal(error?.status, 403);
  assert.equal(error?.code, 'media_path_escape');
  assert.equal(error.message.includes(base), false, 'the error must not disclose a filesystem path');
});

test('a catalog entry reached through a directory symlink is refused', POSIX_ONLY, async () => {
  const { service, principal, itemId } = await serviceWithCatalogPath(async ({ base, mediaDir }) => {
    const outsideDir = path.join(base, 'elsewhere');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'private.mkv'), 'secret-bytes');
    await fs.symlink(outsideDir, path.join(mediaDir, 'shortcut'), 'dir');
    return path.join(mediaDir, 'shortcut', 'private.mkv');
  });

  const { error } = await rejection(service.resolveMediaPath(itemId, principal));
  assert.equal(error?.status, 403);
  assert.equal(error?.code, 'media_path_escape');
});

test('a broken catalog link and a directory catalog entry fail as typed errors', POSIX_ONLY, async () => {
  const broken = await serviceWithCatalogPath(async ({ mediaDir }) => {
    const link = path.join(mediaDir, 'dangling.mkv');
    await fs.symlink(path.join(mediaDir, 'never-existed.mkv'), link, 'file');
    return link;
  });
  const brokenResult = await rejection(broken.service.resolveMediaPath(broken.itemId, broken.principal));
  assert.equal(brokenResult.error?.status, 409);
  assert.equal(brokenResult.error?.code, 'media_path_unavailable');

  // The root itself is contained by definition but is not a servable file.
  const rootEntry = await serviceWithCatalogPath(async ({ mediaDir }) => mediaDir);
  const rootResult = await rejection(rootEntry.service.resolveMediaPath(rootEntry.itemId, rootEntry.principal));
  assert.equal(rootResult.error?.status, 409);
  assert.equal(rootResult.error?.code, 'media_path_not_a_file');
});

test('a sibling directory sharing the root name prefix is not inside the root', async () => {
  const { service, principal, itemId } = await serviceWithCatalogPath(async ({ base }) => {
    // The configured root is <base>/library; this is <base>/library-private.
    const sibling = path.join(base, 'library-private');
    await fs.mkdir(sibling, { recursive: true });
    const secret = path.join(sibling, 'secret.mkv');
    await fs.writeFile(secret, 'secret-bytes');
    return secret;
  });

  const { error } = await rejection(service.resolveMediaPath(itemId, principal));
  assert.equal(error?.status, 403);
  assert.equal(error?.code, 'media_path_escape');
});

test('dot traversal in a catalog entry is refused whether or not the target exists', async () => {
  const present = await serviceWithCatalogPath(async ({ base, mediaDir }) => {
    await fs.writeFile(path.join(base, 'outside.mkv'), 'secret-bytes');
    return path.join(mediaDir, '..', 'outside.mkv');
  });
  const presentResult = await rejection(present.service.resolveMediaPath(present.itemId, present.principal));
  assert.equal(presentResult.error?.status, 403);

  const absent = await serviceWithCatalogPath(async ({ mediaDir }) => path.join(mediaDir, '..', 'never-created.mkv'));
  const absentResult = await rejection(absent.service.resolveMediaPath(absent.itemId, absent.principal));
  assert.equal(absentResult.error?.status, 403, 'a missing target outside the root must not report existence');
  assert.equal(absentResult.error?.code, 'media_path_escape');
});

test('deleting an escaping catalog entry refuses and leaves the outside file intact', POSIX_ONLY, async () => {
  let secretPath;
  const { service, principal, itemId } = await serviceWithCatalogPath(async ({ base, mediaDir }) => {
    secretPath = path.join(base, 'private.mkv');
    await fs.writeFile(secretPath, 'secret-bytes');
    const link = path.join(mediaDir, 'looks-inside.mkv');
    await fs.symlink(secretPath, link, 'file');
    return link;
  });

  const { error } = await rejection(service.deleteLibraryItem(itemId, principal));
  assert.equal(error?.status, 403);
  assert.equal(error?.code, 'media_path_escape');
  assert.equal(await fs.readFile(secretPath, 'utf8'), 'secret-bytes', 'the file outside the root must survive');
  assert.equal((await service.listLibraryItems(principal)).length, 1, 'the catalog entry must not be dropped');
});

test('a successful delete records the path below the root, not the absolute path', async () => {
  const { service, principal, itemId, mediaDir } = await serviceWithCatalogPath(null);
  const result = await service.deleteLibraryItem(itemId, principal);
  assert.equal(result.deleted, true);
  await assert.rejects(() => fs.access(path.join(mediaDir, 'inside.mkv')));

  const logs = await service.listLogs({ limit: 100 }, principal);
  const entries = Array.isArray(logs) ? logs : logs.entries || logs.logs || [];
  const deletion = entries.find((entry) => /Media file deleted/.test(entry.message));
  assert.ok(deletion, 'the deletion must be logged');
  assert.equal(deletion.message.includes(mediaDir), false, 'logs must not carry the absolute media path');
  assert.match(deletion.message, /inside\.mkv$/);
});

/**
 * Transcode output is the one media decision point whose target is *supposed*
 * to be missing, so containment there rests on the nearest existing ancestor
 * rather than on the target itself. FFmpeg is never reached: the escape is
 * decided before the profile is normalized or a process is spawned.
 */
async function transcodeAttempt({ redirectOutput }) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-contain-tc-')));
  const mediaDir = path.join(base, 'library');
  const cacheDir = path.join(base, 'cache');
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });
  const mediaFile = path.join(mediaDir, 'clip.mkv');
  await fs.writeFile(mediaFile, 'fake-video-bytes');

  if (redirectOutput) {
    const escaped = path.join(base, 'escaped-cache');
    await fs.mkdir(escaped, { recursive: true });
    await fs.symlink(escaped, path.join(cacheDir, 'headless-transcodes'), 'dir');
  }

  const verified = await statContainedFile(mediaDir, mediaFile);
  const principal = { id: 'owner-1', type: 'owner', role: 'owner', permissions: ['transcode', 'stream'], rootIds: null };
  const mediaService = createHeadlessMediaService({
    cacheDir,
    transcoder: { path: path.join(base, 'ffmpeg-that-must-not-run'), getHealth: () => ({}) },
    authorize: async () => true,
    adminService: {
      authenticateRequest: async () => principal,
      authorizePrincipal: async () => true,
      getPrincipalById: async () => principal,
      resolveMediaPath: async () => ({
        id: 'item-1',
        rootId: 'root-1',
        path: verified.realPath,
        rootPath: verified.rootRealPath,
        fileId: verified.fileId,
      }),
    },
  });

  const res = {
    statusCode: null,
    body: '',
    headersSent: false,
    writeHead(status) { this.statusCode = status; this.headersSent = true; return this; },
    end(chunk) { if (chunk) this.body += chunk; return this; },
    once() { return this; },
    destroy() { this.destroyed = true; },
  };
  const url = new URL('http://loomtv.local/api/media/transcode?itemId=item-1');
  await mediaService.handle({ method: 'POST', headers: { authorization: 'Bearer token' } }, res, url);
  await mediaService.stop();
  return { res, base, cacheDir, payload: JSON.parse(res.body || '{}') };
}

test('a transcode output directory redirected outside the cache root is refused before FFmpeg runs', POSIX_ONLY, async () => {
  const { res, payload, base } = await transcodeAttempt({ redirectOutput: true });
  assert.equal(res.statusCode, 403);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'Media path is outside its configured root.');
  assert.equal(res.body.includes(base), false, 'the response must not disclose a filesystem path');
});

test('a contained transcode output directory is accepted and the run fails later, on capability', async () => {
  const { res, payload, cacheDir } = await transcodeAttempt({ redirectOutput: false });
  // 503 comes from profile normalization, which runs *after* the output
  // directory has been created and proven contained.
  assert.equal(res.statusCode, 503);
  assert.match(payload.error, /FFmpeg cannot produce/i);
  await fs.access(path.join(cacheDir, 'headless-transcodes'));
});

test('media routes contain paths end to end and reject encoded traversal at the boundary', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-contain-http-'));
  const paths = { dataDir: path.join(base, 'data'), cacheDir: path.join(base, 'cache'), mediaDir: null };
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.cacheDir, { recursive: true });
  const server = createHeadlessServer({ host: '127.0.0.1', port: 0, paths, version: '0.0.0-test', bootstrapSecret: BOOTSTRAP_SECRET });
  const address = await server.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => server.stop());

  const mediaBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-contain-httpmedia-')));
  const mediaDir = path.join(mediaBase, 'library');
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.writeFile(path.join(mediaDir, 'inside.mkv'), 'in-root-video-bytes');
  const secret = path.join(mediaBase, 'private.mkv');
  await fs.writeFile(secret, 'secret-bytes-that-must-never-be-served');

  const created = await fetch(`${baseUrl}/api/v1/auth/owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Owner', password: OWNER_PASSWORD, bootstrapSecret: BOOTSTRAP_SECRET }),
  }).then((response) => response.json());
  const token = created.data.adminToken;
  const authed = (method, route, body) => fetch(`${baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  await authed('POST', '/api/v1/library/roots', { path: mediaDir });
  await authed('POST', '/api/v1/library/scan', {});
  for (let waited = 0; waited < 200; waited += 1) {
    const status = await authed('GET', '/api/v1/library/scan').then((response) => response.json());
    if (status.data.state !== 'scanning') break;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  const library = await authed('GET', '/api/v1/library').then((response) => response.json());
  assert.equal(library.data.items.length, 1);
  const mediaId = library.data.items[0].id;

  await t.test('encoded traversal never reaches a path decision', async () => {
    const encoded = [
      '/api/v1/library/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      `/api/v1/media/%2e%2e%2f%2e%2e%2f${encodeURIComponent('etc/passwd')}/direct`,
      '/api/v1/media/..%2f..%2fetc%2fpasswd/download',
      '/api/v1/library/%2e%2e%5c%2e%2e%5cwindows%5cwin.ini',
    ];
    for (const route of encoded) {
      const response = await authed('GET', route);
      assert.equal(response.status, 400, `${route} must be rejected at the route boundary`);
      const payload = await response.json();
      assert.match(payload.error.code, /_invalid$/);
      assert.equal(/etc|passwd|win\.ini/.test(payload.error.message), false, 'the boundary error must not echo the input');
    }
  });

  await t.test('neither catalog listing route discloses a server path', async () => {
    for (const route of ['/api/v1/library', '/api/media/items']) {
      const payload = await authed('GET', route).then((response) => response.json());
      const items = payload.data?.items || payload.items;
      assert.ok(Array.isArray(items) && items.length === 1, `${route} must list the fixture item`);
      assert.equal(items[0].path, undefined, `${route} must not return a filesystem path`);
      assert.equal(JSON.stringify(items).includes(mediaBase), false, `${route} must not embed the media root`);
    }
  });

  await t.test('an in-root file streams, including a range request', async () => {
    const media = await authed('GET', `/api/v1/media/${mediaId}`).then((response) => response.json());
    const direct = await fetch(`${baseUrl}${media.data.directUrl}`);
    assert.equal(direct.status, 200);
    assert.equal(await direct.text(), 'in-root-video-bytes');

    const ranged = await fetch(`${baseUrl}${media.data.directUrl}`, { headers: { Range: 'bytes=0-6' } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), 'in-root');
  });

  await t.test('a file replaced by an escaping symlink after indexing is refused', POSIX_ONLY, async () => {
    const media = await authed('GET', `/api/v1/media/${mediaId}`).then((response) => response.json());
    await fs.rm(path.join(mediaDir, 'inside.mkv'));
    await fs.symlink(secret, path.join(mediaDir, 'inside.mkv'), 'file');

    for (const route of [media.data.directUrl, media.data.downloadUrl]) {
      const response = await fetch(`${baseUrl}${route}`);
      const body = await response.text();
      // A single clean rejection: the download branch forwards the media
      // service's return value as "handled", so an error response that reported
      // nothing used to be followed by a second, header-clobbering 404.
      assert.equal(response.status, 403, `${route} must reject a substituted file exactly once`);
      assert.equal(body.includes('secret-bytes'), false, 'no byte of the outside file may reach the client');
      assert.equal(body.includes(mediaBase), false, 'the response must not disclose a filesystem path');
    }
  });

  await t.test('a file replaced by a broken link is unavailable rather than contained', POSIX_ONLY, async () => {
    await fs.rm(path.join(mediaDir, 'inside.mkv'));
    await fs.symlink(path.join(mediaDir, 'never-existed.mkv'), path.join(mediaDir, 'inside.mkv'), 'file');
    const media = await authed('GET', `/api/v1/media/${mediaId}`).then((response) => response.json());
    const response = await fetch(`${baseUrl}${media.data.directUrl}`);
    assert.equal(response.status, 409);
    const body = await response.text();
    assert.equal(body.includes(mediaBase), false, 'the response must not disclose a filesystem path');
  });
});
