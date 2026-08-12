import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Server-native admin UI asset loader.
 *
 * This module intentionally has no Electron or desktop imports. In the
 * workspace it serves the canonical responsive page from
 * `apps/desktop/src/headless/admin.html`; a packaged server can pass an
 * explicit `htmlPath` pointing at a copied asset during its build.
 */

export const HEADLESS_ADMIN_PATH = '/admin/';
export const HEADLESS_ADMIN_CONTENT_TYPE = 'text/html; charset=utf-8';
export const HEADLESS_ADMIN_ICONS_PATH = '/admin/lucide-icons.svg';
export const HEADLESS_ADMIN_ICONS_CONTENT_TYPE = 'image/svg+xml; charset=utf-8';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ADMIN_HTML_PATH = path.resolve(MODULE_DIR, '../../desktop/src/headless/admin.html');
export const DEFAULT_ADMIN_ICONS_PATH = path.resolve(MODULE_DIR, '../../desktop/src/headless/lucide-icons.svg');

const FALLBACK_ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0a0a0a">
<title>LoomTV server control</title><style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#fafafa}
body{display:grid;min-height:100vh;place-items:center;margin:0;padding:24px}main{max-width:560px;padding:30px;border:1px solid rgba(255,255,255,.1);border-radius:16px;background:rgba(23,23,23,.88)}h1{margin:0 0 10px;color:#FC9C03}p{line-height:1.6;color:#a3a3a3}code{color:#FC9C03}
</style></head><body><main><h1>LoomTV server</h1><p>The admin UI asset was not copied into this server image. Mount or package <code>admin.html</code>, then configure the server with its path.</p></main></body></html>`;

export async function readAdminPage(options = {}) {
  const htmlPath = options.htmlPath || DEFAULT_ADMIN_HTML_PATH;
  try {
    return await fs.readFile(htmlPath, 'utf8');
  } catch {
    return FALLBACK_ADMIN_HTML;
  }
}

export async function readAdminIcons(options = {}) {
  const iconsPath = options.iconsPath || DEFAULT_ADMIN_ICONS_PATH;
  return fs.readFile(iconsPath, 'utf8');
}

/**
 * Return a tiny route adapter for a Node `http.createServer` listener.
 * Returning `false` means the caller should continue routing. The adapter
 * handles both `/admin` and `/admin/`, including HEAD and safe redirects.
 */
export function createAdminPage(options = {}) {
  const htmlProvider = options.getHtml || (() => readAdminPage(options));
  const iconsProvider = options.getIcons || (() => readAdminIcons(options));
  return async function handleAdminPage(req, res) {
    const pathname = new URL(req.url || '/', 'http://loomtv.local').pathname;
    const isAdminPage = pathname === '/admin' || pathname === HEADLESS_ADMIN_PATH;
    const isIcons = pathname === HEADLESS_ADMIN_ICONS_PATH;
    if (!isAdminPage && !isIcons) return false;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const body = isIcons ? await iconsProvider() : await htmlProvider();
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': isIcons ? HEADLESS_ADMIN_ICONS_CONTENT_TYPE : HEADLESS_ADMIN_CONTENT_TYPE,
        'Content-Length': Buffer.byteLength(body),
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
      return true;
    }
    const body = JSON.stringify({ ok: false, error: 'method_not_allowed' });
    res.writeHead(405, {
      Allow: 'GET, HEAD',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return true;
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(400, `${field} is required.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw requestError(400, `${field} is too long.`);
  return normalized;
}

function optionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, field, maxLength);
}

function allowedValue(value, field, allowed) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) throw requestError(400, `${field} is invalid.`);
  return value;
}

function optionalBoolean(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw requestError(400, `${field} must be a boolean.`);
  return value;
}

function writeJson(res, status, payload, headers = {}) {
  if (status === 204) {
    res.writeHead(204, { 'Cache-Control': 'no-store', ...headers });
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function permissionForRoute(pathname, method, prefix) {
  // Bootstrap is the authenticated capability snapshot. The service redacts
  // health, roots, users, and backup details for principals that lack the
  // corresponding read permission, so every signed-in account can unlock the
  // web client without receiving administrator-only data.
  if (pathname === `${prefix}/bootstrap`) return undefined;
  if (pathname === `${prefix}/library/roots`) return method === 'GET' ? 'library.read' : 'library.manage';
  if (pathname === `${prefix}/library/browse`) return 'library.manage';
  if (pathname === `${prefix}/library/items`) return 'library.read';
  if (pathname.startsWith(`${prefix}/library/roots/`)) return 'library.manage';
  if (pathname === `${prefix}/library/scan`) return method === 'GET' ? 'library.read' : 'library.manage';
  if (pathname === `${prefix}/health`) return 'admin.read';
  if (pathname === `${prefix}/sessions`) return 'sessions.read';
  if (pathname === `${prefix}/logs`) return 'logs.read';
  if (pathname === `${prefix}/diagnostics`) return 'admin.read';
  if (pathname === `${prefix}/backup/restore`) return 'backup.create';
  if (pathname === `${prefix}/backup`) return method === 'GET' ? 'backup.read' : 'backup.create';
  if (pathname === `${prefix}/users` || pathname.startsWith(`${prefix}/users/`)) return method === 'GET' ? 'users.read' : 'users.manage';
  if (pathname === `${prefix}/account/password`) return 'account.password';
  return undefined;
}

async function readJsonBody(req, maxBytes) {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    throw requestError(413, 'Request body is too large.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw requestError(413, 'Request body is too large.');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks, size).toString('utf8').trim();
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw requestError(400, 'Request body is not valid JSON.'); }
  if (!isObject(parsed)) throw requestError(400, 'JSON body must be an object.');
  return parsed;
}

function limitFromQuery(value) {
  if (!value) return 100;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) throw requestError(400, 'limit must be between 1 and 500.');
  return parsed;
}

function logQueryFromUrl(url) {
  return {
    limit: limitFromQuery(url.searchParams.get('limit')),
    offset: (() => {
      const value = url.searchParams.get('offset');
      if (!value) return 0;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100_000) throw requestError(400, 'offset must be a non-negative integer.');
      return parsed;
    })(),
    level: optionalString(url.searchParams.get('level'), 'level', 16),
    source: optionalString(url.searchParams.get('source'), 'source', 128),
    search: optionalString(url.searchParams.get('search'), 'search', 200),
    before: url.searchParams.get('before') ? Number(url.searchParams.get('before')) : undefined,
    after: url.searchParams.get('after') ? Number(url.searchParams.get('after')) : undefined,
  };
}

/**
 * Server-native API counterpart to the typed desktop adapter. `service` uses
 * the same method names as `HeadlessAdminService` but is intentionally duck
 * typed so the standalone server can provide storage/scanner implementations
 * without a TypeScript or Electron dependency.
 */
export function createAdminApiHandler(options = {}) {
  const service = options.service;
  if (!service) throw new Error('createAdminApiHandler requires a service.');
  const authorize = options.authorize || (() => false);
  const authenticate = options.authenticate || service.authenticateRequest;
  const authorizePrincipal = options.authorizePrincipal || service.authorizePrincipal;
  const ownerConfigured = options.ownerConfigured || (async () => (await service.getBootstrap()).ownerConfigured);
  const maxBodyBytes = options.maxBodyBytes || 128 * 1024;
  const log = options.log || ((message, error) => console.error(`[headless-admin] ${message}`, error || ''));
  const requireSecureTransport = options.requireSecureTransport === true;
  const trustProxy = options.trustProxy === true;

  function isSecureRequest(req) {
    if (req.socket?.encrypted) return true;
    if (!trustProxy) return false;
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return forwardedProto === 'https';
  }

  return async function handleAdminApi(req, res) {
    const url = new URL(req.url || '/', 'http://loomtv.local');
    const pathname = url.pathname;
    const prefix = '/api/admin';
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Loom-Admin-Token, X-Loom-Device-Id',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return true;
    }
    const hasCredential = Boolean(req.headers.authorization || req.headers['x-loom-admin-token']);
    const isPublicBootstrapRequest = pathname === `${prefix}/bootstrap` && method === 'GET' && !hasCredential;
    if (requireSecureTransport && !isPublicBootstrapRequest && !isSecureRequest(req)) {
      writeJson(res, 426, {
        error: 'secure_transport_required',
        message: 'Use HTTPS for admin and credential requests.',
      });
      return true;
    }

    let configured;
    try { configured = await ownerConfigured(); } catch (error) { log('owner state lookup failed', error); configured = true; }
    const publicRoute = (pathname === `${prefix}/bootstrap` && method === 'GET' && !configured)
      || (pathname === `${prefix}/onboarding/owner` && method === 'POST')
      || (pathname === `${prefix}/session` && method === 'POST');
    const requiredPermission = permissionForRoute(pathname, method, prefix);
    let principal = null;
    if (!publicRoute) {
      try {
        if (typeof authenticate === 'function') {
          principal = await authenticate(req);
          if (!principal) {
            writeJson(res, 401, { error: 'admin_auth_required', message: 'A valid LoomTV admin token is required.' });
            return true;
          }
          const permitted = typeof authorizePrincipal === 'function'
            ? await authorizePrincipal(principal, requiredPermission)
            : (!requiredPermission || principal.type === 'owner' || principal.permissions?.includes('*') || principal.permissions?.includes(requiredPermission));
          if (!permitted) {
            writeJson(res, 403, { error: 'permission_denied', message: 'This account is not allowed to perform that action.' });
            return true;
          }
        } else if (!await authorize(req, requiredPermission)) {
          writeJson(res, 401, { error: 'admin_auth_required', message: 'A valid LoomTV admin token is required.' });
          return true;
        }
      } catch (error) {
        log('admin authorization failed', error);
        if (error?.status === 503) {
          writeJson(res, 503, { error: 'state_unavailable', message: 'The server account state is temporarily unavailable.' });
        } else {
          writeJson(res, 401, { error: 'admin_auth_required', message: 'A valid LoomTV admin token is required.' });
        }
        return true;
      }
    }

    try {
      if (pathname === `${prefix}/bootstrap` && method === 'GET') {
        writeJson(res, 200, await service.getBootstrap(principal));
        return true;
      }
      if (pathname === `${prefix}/onboarding/owner` && method === 'POST') {
        if (configured) throw requestError(409, 'The LoomTV owner has already been created.');
        const body = await readJsonBody(req, maxBodyBytes);
        writeJson(res, 201, await service.createOwner({
          name: requiredString(body.name, 'name', 80),
          password: requiredString(body.password, 'password', 256),
        }));
        return true;
      }
      if (pathname === `${prefix}/session` && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes);
        writeJson(res, 200, await service.createSession({
          username: optionalString(body.username, 'username', 80),
          password: requiredString(body.password, 'password', 256),
          address: req.socket?.remoteAddress,
          deviceId: optionalString(req.headers['x-loom-device-id'], 'deviceId', 128),
        }));
        return true;
      }
      if (pathname === `${prefix}/session` && method === 'DELETE') {
        await service.revokeRequest(req);
        writeJson(res, 204, null);
        return true;
      }
      if (pathname === `${prefix}/library/roots`) {
        if (method === 'GET') {
          writeJson(res, 200, { roots: await service.listLibraryRoots(principal) });
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req, maxBodyBytes);
          const kind = allowedValue(body.kind, 'kind', ['movies', 'tvShows', 'anime', 'others']);
          writeJson(res, 201, await service.addLibraryRoot({
            path: requiredString(body.path, 'path', 4_096),
            ...(kind ? { kind } : {}),
          }, principal));
          return true;
        }
      }
      if (pathname === `${prefix}/library/browse` && method === 'GET') {
        const requestedPath = optionalString(url.searchParams.get('path'), 'path', 4_096);
        if (typeof service.listLibraryDirectories !== 'function') {
          throw requestError(501, 'Mounted-folder browsing is not available on this server. Enter the server path manually.');
        }
        writeJson(res, 200, await service.listLibraryDirectories(requestedPath ? { path: requestedPath } : {}, principal));
        return true;
      }
      if (pathname === `${prefix}/library/items` && method === 'GET') {
        writeJson(res, 200, { items: await service.listLibraryItems(principal) });
        return true;
      }
      if (pathname.startsWith(`${prefix}/library/roots/`) && method === 'DELETE') {
        const rootId = decodeURIComponent(pathname.slice(`${prefix}/library/roots/`.length));
        if (!rootId || rootId.length > 512) throw requestError(400, 'rootId is invalid.');
        await service.removeLibraryRoot(rootId, principal);
        writeJson(res, 204, null);
        return true;
      }
      if (pathname === `${prefix}/library/scan`) {
        if (method === 'GET') {
          writeJson(res, 200, await service.getScanStatus(principal));
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req, maxBodyBytes);
          const mode = allowedValue(body.mode, 'mode', ['quick', 'metadata', 'full']);
          const rootId = optionalString(body.rootId, 'rootId', 512);
          writeJson(res, 202, await service.startLibraryScan({ ...(mode ? { mode } : {}), ...(rootId ? { rootId } : {}) }, principal));
          return true;
        }
      }
      if (pathname === `${prefix}/health` && method === 'GET') {
        writeJson(res, 200, await service.getHealth(principal));
        return true;
      }
      if (pathname === `${prefix}/sessions` && method === 'GET') {
        writeJson(res, 200, { sessions: await service.listSessions(principal) });
        return true;
      }
      if (pathname === `${prefix}/logs` && method === 'GET') {
        writeJson(res, 200, await service.listLogs(logQueryFromUrl(url), principal));
        return true;
      }
      if (pathname === `${prefix}/diagnostics` && method === 'GET') {
        writeJson(res, 200, await service.getDiagnostics(principal));
        return true;
      }
      if (pathname === `${prefix}/backup/restore` && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes);
        writeJson(res, 200, await service.restoreBackup({ path: requiredString(body.path || body.source, 'path', 4_096) }, principal));
        return true;
      }
      if (pathname === `${prefix}/backup`) {
        if (method === 'GET') {
          writeJson(res, 200, await service.getBackupStatus(principal));
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req, maxBodyBytes);
          const destination = optionalString(body.destination, 'destination', 4_096);
          writeJson(res, 202, await service.startBackup(destination ? { destination } : {}, principal));
          return true;
        }
      }
      if (pathname === `${prefix}/users`) {
        if (method === 'GET') {
          writeJson(res, 200, { users: await service.listUsers(principal) });
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req, maxBodyBytes);
          writeJson(res, 201, await service.createUser({
            name: requiredString(body.name, 'name', 80),
            password: requiredString(body.password, 'password', 256),
            role: allowedValue(body.role, 'role', ['viewer', 'user', 'admin']),
            permissions: body.permissions === undefined ? undefined : body.permissions,
            rootIds: body.rootIds === undefined ? undefined : body.rootIds,
            deviceIds: body.deviceIds === undefined ? undefined : body.deviceIds,
            maxSessions: body.maxSessions === undefined ? undefined : body.maxSessions,
          }, principal));
          return true;
        }
      }
      const userMatch = pathname.match(new RegExp(`^${prefix}/users/([^/]+)$`));
      if (userMatch) {
        const userId = decodeURIComponent(userMatch[1]);
        if (method === 'PATCH' || method === 'PUT') {
          const body = await readJsonBody(req, maxBodyBytes);
          writeJson(res, 200, await service.updateUser(userId, {
            ...(body.name === undefined ? {} : { name: requiredString(body.name, 'name', 80) }),
            ...(body.role === undefined ? {} : { role: allowedValue(body.role, 'role', ['viewer', 'user', 'admin']) }),
            ...(body.permissions === undefined ? {} : { permissions: body.permissions }),
            ...(body.rootIds === undefined ? {} : { rootIds: body.rootIds }),
            ...(body.deviceIds === undefined ? {} : { deviceIds: body.deviceIds }),
            ...(body.maxSessions === undefined ? {} : { maxSessions: body.maxSessions }),
            ...(body.disabled === undefined ? {} : { disabled: optionalBoolean(body.disabled, 'disabled') }),
          }, principal));
          return true;
        }
        if (method === 'DELETE') {
          await service.removeUser(userId, principal);
          writeJson(res, 204, null);
          return true;
        }
      }
      if (pathname === `${prefix}/account/password` && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes);
        writeJson(res, 200, await service.changePassword({
          userId: optionalString(body.userId, 'userId', 128),
          currentPassword: body.currentPassword,
          newPassword: requiredString(body.newPassword, 'newPassword', 256),
        }, principal));
        return true;
      }
      writeJson(res, 404, { error: 'admin_route_not_found', message: 'The requested admin route does not exist.' });
      return true;
    } catch (error) {
      if (error?.status) {
        writeJson(res, error.status, {
          error: error.code || 'invalid_request',
          message: error.message,
          ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
        }, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
        return true;
      }
      log(`request failed: ${method} ${pathname}`, error);
      writeJson(res, 500, { error: 'admin_request_failed', message: 'The admin request could not be completed.' });
      return true;
    }
  };
}
