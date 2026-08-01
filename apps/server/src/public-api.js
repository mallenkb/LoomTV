import { isOwnerPrincipal } from './auth-policy.js';

export const PUBLIC_API_PREFIX = '/api/v1';
export const PUBLIC_API_VERSION = '1';
export const PUBLIC_API_HEADER = 'X-LoomTV-API-Version';

const MAX_BODY_BYTES = 128 * 1024;

function requestError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function writeJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    [PUBLIC_API_HEADER]: PUBLIC_API_VERSION,
    ...headers,
  });
  res.end(body);
}

function writeError(res, status, code, message, details = {}) {
  writeJson(res, status, { ok: false, error: { code, message, ...details } });
}

function writeData(res, status, data, headers = {}) {
  writeJson(res, status, { ok: true, data }, headers);
}

function requiredString(value, field, max = 4_096) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(400, `${field}_required`, `${field} is required.`);
  const normalized = value.trim();
  if (normalized.length > max) throw requestError(400, `${field}_too_long`, `${field} is too long.`);
  return normalized;
}

function optionalString(value, field, max = 4_096) {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, field, max);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(req) {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    req.resume();
    throw requestError(413, 'body_too_large', 'Request body is too large.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw requestError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks, size).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) throw new Error('not_object');
    return parsed;
  } catch {
    throw requestError(400, 'invalid_json', 'Request body must be a JSON object.');
  }
}

function decodeSegment(value, field = 'id') {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 512 || decoded.includes('/') || decoded.includes('\\')) {
      throw new Error('invalid');
    }
    return decoded;
  } catch {
    throw requestError(400, `${field}_invalid`, `${field} is invalid.`);
  }
}

function pathForMedia(url, mediaId, action) {
  const query = new URLSearchParams(url.searchParams);
  query.delete('profileId');
  query.set('itemId', mediaId);
  const path = action === 'download'
    ? `/api/media/items/${encodeURIComponent(mediaId)}/download`
    : action === 'direct'
      ? `/api/media/items/${encodeURIComponent(mediaId)}`
      : '/api/media/transcode';
  return new URL(`${path}?${query.toString()}`, 'http://loomtv.local');
}

function authTokenPresent(req, url) {
  return Boolean(req.headers.authorization || req.headers['x-loom-admin-token'] || url.searchParams.get('token'));
}

function publicHealthSummary(health) {
  const media = health?.media || {};
  const transcoder = health?.transcoder || {};
  return {
    status: health?.status,
    media: {
      configured: Boolean(media.configured),
      state: media.state || 'unknown',
      readable: media.readable === true,
    },
    transcoder: {
      available: transcoder.available === true,
      hardwareAcceleration: transcoder.hardwareAcceleration === true,
      recommendedBackend: transcoder.recommendedBackend || 'software',
    },
  };
}

function publicLibraryItem(item) {
  if (!item || typeof item !== 'object') return item;
  const { path: _path, ...safeItem } = item;
  return safeItem;
}

function publicLibraryRoot(root) {
  if (!root || typeof root !== 'object') return root;
  const { path: _path, ...safeRoot } = root;
  return safeRoot;
}

function discoveryDocument(version, health) {
  return {
    apiVersion: PUBLIC_API_VERSION,
    serverVersion: version,
    mediaCoreContractVersion: health.mediaCoreContractVersion,
    openapi: '/api/v1/openapi.json',
    client: { app: '/app/', admin: '/admin/' },
    capabilities: {
      authentication: true,
      profiles: true,
      watchProgress: true,
      library: true,
      directStreaming: true,
      hlsTranscoding: Boolean(health.capabilities?.transcoding),
      hardwareAcceleration: Boolean(health.capabilities?.hardwareAcceleration),
      profilePins: false,
      downloads: true,
    },
    health: {
      ...publicHealthSummary(health),
    },
  };
}

function completeOpenApi(document) {
  for (const [route, pathItem] of Object.entries(document.paths || {})) {
    const parameterNames = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!operation || typeof operation !== 'object' || method === 'parameters') continue;
      operation.responses ||= {
        '200': { description: 'Request succeeded.' },
        '400': { description: 'The request was invalid.' },
        '401': { description: 'Authentication is required.' },
        '403': { description: 'The account is not allowed to perform this action.' },
        '404': { description: 'The requested resource was not found.' },
      };
      if (parameterNames.length) {
        operation.parameters ||= parameterNames.map((name) => ({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        }));
      }
    }
  }
  return document;
}

const OPENAPI_DOCUMENT = Object.freeze(completeOpenApi({
  openapi: '3.0.3',
  info: {
    title: 'LoomTV Hosted API',
    version: PUBLIC_API_VERSION,
    description: 'Versioned browser and client API for a headless LoomTV server.',
  },
  servers: [{ url: '/' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/api/v1/discovery': { get: { summary: 'Discover capabilities and client URLs' } },
    '/api/v1/health': { get: { summary: 'Read a safe unauthenticated health summary' } },
    '/api/v1/auth/onboarding': { get: { summary: 'Check whether owner onboarding is required' } },
    '/api/v1/auth/owner': { post: { summary: 'Create the first owner account' } },
    '/api/v1/auth/session': { post: { summary: 'Create an authenticated session' }, delete: { summary: 'Revoke the current session' } },
    '/api/v1/auth/me': { get: { summary: 'Return the authenticated account' } },
    '/api/v1/library': { get: { summary: 'List the authenticated catalog' } },
    '/api/v1/library/roots': { get: { summary: 'List the authenticated library roots' }, post: { summary: 'Add a library root' } },
    '/api/v1/library/roots/{rootId}': { delete: { summary: 'Remove a library root' } },
    '/api/v1/library/{mediaId}': { get: { summary: 'Read one catalog item' } },
    '/api/v1/library/scan': { get: { summary: 'Read scan status' }, post: { summary: 'Start a library scan' } },
    '/api/v1/profiles': { get: { summary: 'List profiles' }, post: { summary: 'Create a profile' } },
    '/api/v1/profiles/{profileId}': { patch: { summary: 'Update a profile' } },
    '/api/v1/profiles/{profileId}/select': { post: { summary: 'Select the active profile' } },
    '/api/v1/profiles/{profileId}/progress': { get: { summary: 'List watch progress' } },
    '/api/v1/profiles/{profileId}/progress/{mediaId}': { get: { summary: 'Read progress' }, put: { summary: 'Save progress' } },
    '/api/v1/media/{mediaId}': { get: { summary: 'Read media playback links' } },
    '/api/v1/media/{mediaId}/direct': { get: { summary: 'Stream a browser-compatible file' } },
    '/api/v1/media/{mediaId}/download': { get: { summary: 'Download the original media file' } },
    '/api/v1/media/{mediaId}/transcode': { post: { summary: 'Start an HLS transcode' } },
    '/api/v1/users': { get: { summary: 'List scoped user accounts' }, post: { summary: 'Create a user account' } },
    '/api/v1/users/{userId}': { patch: { summary: 'Update a user account' }, delete: { summary: 'Remove a user account' } },
    '/api/v1/account/password': { post: { summary: 'Change or reset an account password' } },
    '/api/v1/diagnostics': { get: { summary: 'Read administrator diagnostics' } },
    '/api/v1/sessions': { get: { summary: 'List active playback sessions' } },
    '/api/v1/logs': { get: { summary: 'Read operational logs' } },
    '/api/v1/backups': { get: { summary: 'Read backup status' }, post: { summary: 'Create a backup' } },
    '/api/v1/backups/restore': { post: { summary: 'Validate and restore a backup' } },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
}));

/**
 * Versioned viewer/client API. Existing `/api/admin` and `/api/media` routes
 * remain intact; this handler is a stable adapter around those services.
 */
export function createPublicApiHandler({ service, clientState, mediaService, getRuntimeHealth, version, requireSecureTransport = false, trustProxy = false }) {
  if (!service || !clientState || !mediaService) throw new Error('createPublicApiHandler requires server services.');

  function isSecureRequest(req) {
    if (req.socket?.encrypted) return true;
    if (!trustProxy) return false;
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return forwardedProto === 'https';
  }

  async function principalForRequest(req) {
    return service.authenticateRequest(req);
  }

  async function requirePrincipal(req, permission) {
    const principal = await principalForRequest(req);
    if (!principal) throw requestError(401, 'auth_required', 'A valid LoomTV session is required.');
    if (permission && !await service.authorizePrincipal(principal, permission)) {
      throw requestError(403, 'permission_denied', 'This account is not allowed to perform that action.');
    }
    return principal;
  }

  function canSeeAllProfiles(principal) {
    return isOwnerPrincipal(principal) || principal.permissions?.includes('users.manage') === true;
  }

  async function handleMedia(req, res, url, mediaId, action) {
    const queryUrl = pathForMedia(url, mediaId, action);
    res.__loomtvPublicApi = true;
    // Direct playback URLs are also usable by an HTMLMediaElement, which
    // cannot attach Authorization headers. The underlying media service still
    // validates the short-lived/session token from the query string.
    if (action === 'direct' && req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (action === 'transcode' && req.method !== 'POST') return false;
    const result = await mediaService.handle(req, res, queryUrl);
    return result !== false;
  }

  return async function handlePublicApi(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'loomtv.local'}`);
    const pathname = url.pathname;
    if (pathname === PUBLIC_API_PREFIX && req.method === 'GET') {
      writeJson(res, 200, discoveryDocument(version, await getRuntimeHealth()));
      return true;
    }
    if (pathname === `${PUBLIC_API_PREFIX}/openapi.json` && (req.method === 'GET' || req.method === 'HEAD')) {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
        res.end();
      } else writeJson(res, 200, OPENAPI_DOCUMENT, { 'Cache-Control': 'public, max-age=300' });
      return true;
    }
    if (pathname === PUBLIC_API_PREFIX && req.method === 'OPTIONS') {
      res.writeHead(204, {
        [PUBLIC_API_HEADER]: PUBLIC_API_VERSION,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Loom-Admin-Token, X-Loom-Device-Id',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return true;
    }
    if (!pathname.startsWith(`${PUBLIC_API_PREFIX}/`)) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        [PUBLIC_API_HEADER]: PUBLIC_API_VERSION,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Loom-Admin-Token, X-Loom-Device-Id',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return true;
    }

    const segments = pathname.slice(`${PUBLIC_API_PREFIX}/`.length).split('/').filter(Boolean);
    const resource = segments[0] || '';
    const publicDiscovery = (resource === 'discovery' && req.method === 'GET')
      || (resource === 'auth' && segments[1] === 'onboarding' && req.method === 'GET')
      || (pathname === `${PUBLIC_API_PREFIX}/openapi.json` && (req.method === 'GET' || req.method === 'HEAD'));
    if (requireSecureTransport && !publicDiscovery && !isSecureRequest(req)) {
      writeError(res, 426, 'secure_transport_required', 'Use HTTPS for credential, API, and media requests.');
      return true;
    }

    try {
      if (resource === 'discovery' && req.method === 'GET') {
        writeJson(res, 200, discoveryDocument(version, await getRuntimeHealth()));
        return true;
      }
      if (resource === 'health' && req.method === 'GET') {
        writeJson(res, 200, { ok: true, data: await service.getHealth(null, { summary: true }) });
        return true;
      }
      if (resource === 'auth' && segments[1] === 'onboarding' && req.method === 'GET') {
        writeData(res, 200, { ownerConfigured: await service.isOwnerConfigured(), apiVersion: PUBLIC_API_VERSION });
        return true;
      }
      if (resource === 'auth' && segments[1] === 'owner' && req.method === 'POST') {
        if (await service.isOwnerConfigured()) throw requestError(409, 'owner_exists', 'The LoomTV owner has already been created.');
        const body = await readJsonBody(req);
        writeData(res, 201, await service.createOwner({
          name: requiredString(body.name, 'name', 80),
          password: requiredString(body.password, 'password', 256),
        }));
        return true;
      }
      if (resource === 'auth' && segments[1] === 'session' && req.method === 'POST') {
        const body = await readJsonBody(req);
        writeData(res, 200, await service.createSession({
          username: optionalString(body.username, 'username', 80),
          password: requiredString(body.password, 'password', 256),
          address: req.socket?.remoteAddress,
          deviceId: optionalString(req.headers['x-loom-device-id'], 'deviceId', 128),
        }));
        return true;
      }
      if (resource === 'auth' && segments[1] === 'session' && req.method === 'DELETE') {
        await requirePrincipal(req);
        await service.revokeRequest(req);
        res.writeHead(204, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
        res.end();
        return true;
      }
      if (resource === 'auth' && segments[1] === 'me' && req.method === 'GET') {
        const principal = await requirePrincipal(req);
        writeData(res, 200, { user: await service.getCurrentUser(principal) });
        return true;
      }
      if (resource === 'library' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'library.read');
        writeData(res, 200, { items: (await service.listLibraryItems(principal)).map(publicLibraryItem) });
        return true;
      }
      if (resource === 'library' && segments[1] === 'roots' && segments.length === 2 && (req.method === 'GET' || req.method === 'POST')) {
        const principal = await requirePrincipal(req, req.method === 'GET' ? 'library.read' : 'library.manage');
        if (req.method === 'GET') writeData(res, 200, { roots: (await service.listLibraryRoots(principal)).map(publicLibraryRoot) });
        else {
          const body = await readJsonBody(req);
          writeData(res, 201, { root: publicLibraryRoot(await service.addLibraryRoot({ path: requiredString(body.path, 'path', 4_096), kind: optionalString(body.kind, 'kind', 16) }, principal)) });
        }
        return true;
      }
      if (resource === 'library' && segments[1] === 'roots' && segments.length === 3 && req.method === 'DELETE') {
        const principal = await requirePrincipal(req, 'library.manage');
        await service.removeLibraryRoot(decodeSegment(segments[2], 'rootId'), principal);
        res.writeHead(204, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
        res.end();
        return true;
      }
      if (resource === 'library' && segments[1] === 'scan' && (req.method === 'GET' || req.method === 'POST')) {
        const principal = await requirePrincipal(req, req.method === 'GET' ? 'library.read' : 'library.manage');
        if (req.method === 'GET') writeData(res, 200, await service.getScanStatus(principal));
        else {
          const body = await readJsonBody(req);
          writeData(res, 202, await service.startLibraryScan({ mode: body.mode, rootId: body.rootId }, principal));
        }
        return true;
      }
      if (resource === 'library' && segments.length === 2 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'library.read');
        const item = await service.getLibraryItem(decodeSegment(segments[1], 'mediaId'), principal);
        if (!item) throw requestError(404, 'media_not_found', 'Media item was not found.');
        writeData(res, 200, { item: publicLibraryItem(item) });
        return true;
      }
      if (resource === 'profiles' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req);
        writeData(res, 200, { profiles: await clientState.listProfiles(principal.id, canSeeAllProfiles(principal)) });
        return true;
      }
      if (resource === 'profiles' && segments.length === 1 && req.method === 'POST') {
        const principal = await requirePrincipal(req);
        const body = await readJsonBody(req);
        writeData(res, 201, { profile: await clientState.createProfile(body, principal.id) });
        return true;
      }
      if (resource === 'profiles' && segments.length === 2 && req.method === 'PATCH') {
        const principal = await requirePrincipal(req);
        const body = await readJsonBody(req);
        writeData(res, 200, { profile: await clientState.updateProfile(decodeSegment(segments[1], 'profileId'), body, principal.id, canSeeAllProfiles(principal)) });
        return true;
      }
      if (resource === 'profiles' && segments.length === 3 && segments[2] === 'select' && req.method === 'POST') {
        const principal = await requirePrincipal(req);
        writeData(res, 200, { profile: await clientState.selectProfile(decodeSegment(segments[1], 'profileId'), principal.id, canSeeAllProfiles(principal)) });
        return true;
      }
      if (resource === 'profiles' && segments.length >= 3 && segments[2] === 'progress') {
        const principal = await requirePrincipal(req);
        const profileId = decodeSegment(segments[1], 'profileId');
        if (segments.length === 3 && req.method === 'GET') {
          writeData(res, 200, { progress: await clientState.listProgress(profileId, principal.id, canSeeAllProfiles(principal)) });
          return true;
        }
        if (segments.length === 4 && (req.method === 'GET' || req.method === 'PUT' || req.method === 'POST')) {
          const mediaId = decodeSegment(segments[3], 'mediaId');
          if (req.method === 'GET') writeData(res, 200, { progress: await clientState.getProgress(profileId, mediaId, principal.id, canSeeAllProfiles(principal)) });
          else {
            const media = await service.getLibraryItem(mediaId, principal);
            if (!media) throw requestError(404, 'media_not_found', 'Media item was not found.');
            writeData(res, 200, { progress: await clientState.saveProgress(profileId, mediaId, await readJsonBody(req), principal.id, canSeeAllProfiles(principal)) });
          }
          return true;
        }
      }
      if (resource === 'media' && segments.length === 2 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'library.read');
        const mediaId = decodeSegment(segments[1], 'mediaId');
        const item = await service.getLibraryItem(mediaId, principal);
        if (!item) throw requestError(404, 'media_not_found', 'Media item was not found.');
        const directToken = typeof mediaService.issuePlaybackToken === 'function'
          ? mediaService.issuePlaybackToken(mediaId, principal.id, 'direct')?.token
          : null;
        const downloadToken = typeof mediaService.issuePlaybackToken === 'function'
          ? mediaService.issuePlaybackToken(mediaId, principal.id, 'download')?.token
          : null;
        const tokenQuery = (token) => token ? `?token=${encodeURIComponent(token)}` : '';
        writeData(res, 200, {
          item: publicLibraryItem(item),
          directUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/direct${tokenQuery(directToken)}`,
          downloadUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/download${tokenQuery(downloadToken)}`,
          transcodeUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/transcode`,
        });
        return true;
      }
      if (resource === 'media' && segments.length === 3 && (segments[2] === 'direct' || segments[2] === 'download' || segments[2] === 'transcode')) {
        const mediaId = decodeSegment(segments[1], 'mediaId');
        if (segments[2] === 'transcode') await requirePrincipal(req, 'transcode');
        else if (segments[2] === 'download' && !req.headers.authorization && !req.headers['x-loom-admin-token']) {
          if (!url.searchParams.get('token')) throw requestError(401, 'auth_required', 'A valid LoomTV session is required.');
        }
        else if (!authTokenPresent(req, url)) throw requestError(401, 'auth_required', 'A valid LoomTV session is required.');
        if (segments[2] === 'download') {
          res.__loomtvPublicApi = true;
          const queryUrl = pathForMedia(url, mediaId, 'download');
          return mediaService.handle(req, res, queryUrl);
        }
        return handleMedia(req, res, url, mediaId, segments[2]);
      }
      if (resource === 'sessions' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'sessions.read');
        writeData(res, 200, { sessions: await service.listSessions(principal) });
        return true;
      }
      if (resource === 'logs' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'logs.read');
        const limit = Number(url.searchParams.get('limit') || 100);
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) {
          throw requestError(400, 'pagination_invalid', 'limit must be 1–500 and offset must be a non-negative integer.');
        }
        writeData(res, 200, await service.listLogs({
          limit,
          offset,
          level: url.searchParams.get('level') || undefined,
          source: url.searchParams.get('source') || undefined,
          search: url.searchParams.get('search') || undefined,
        }, principal));
        return true;
      }
      if (resource === 'backups' && segments.length === 1 && (req.method === 'GET' || req.method === 'POST')) {
        const principal = await requirePrincipal(req, req.method === 'GET' ? 'backup.read' : 'backup.create');
        if (req.method === 'GET') writeData(res, 200, await service.getBackupStatus(principal));
        else {
          const body = await readJsonBody(req);
          const destination = optionalString(body.destination, 'destination', 4_096);
          if (destination && typeof service.isBackupPathAllowed === 'function' && !service.isBackupPathAllowed(destination)) {
            throw requestError(403, 'backup_path_forbidden', 'Public API backups must stay inside the server backup directory.');
          }
          writeData(res, 202, await service.startBackup({ destination }, principal));
        }
        return true;
      }
      if (resource === 'backups' && segments[1] === 'restore' && segments.length === 2 && req.method === 'POST') {
        const principal = await requirePrincipal(req, 'backup.create');
        const body = await readJsonBody(req);
        const source = requiredString(body.path || body.source, 'path', 4_096);
        if (typeof service.isBackupPathAllowed === 'function' && !service.isBackupPathAllowed(source)) {
          throw requestError(403, 'backup_path_forbidden', 'Public API restores must read from the server backup directory.');
        }
        writeData(res, 200, await service.restoreBackup({ path: source }, principal));
        return true;
      }
      if (resource === 'users' && segments.length === 1 && (req.method === 'GET' || req.method === 'POST')) {
        const principal = await requirePrincipal(req, req.method === 'GET' ? 'users.read' : 'users.manage');
        if (req.method === 'GET') writeData(res, 200, { users: await service.listUsers(principal) });
        else {
          const body = await readJsonBody(req);
          writeData(res, 201, { user: await service.createUser({
            name: requiredString(body.name, 'name', 80),
            password: requiredString(body.password, 'password', 256),
            role: optionalString(body.role, 'role', 16),
            permissions: body.permissions,
            rootIds: body.rootIds,
            deviceIds: body.deviceIds,
            maxSessions: body.maxSessions,
          }, principal) });
        }
        return true;
      }
      if (resource === 'users' && segments.length === 2 && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const principal = await requirePrincipal(req, 'users.manage');
        const userId = decodeSegment(segments[1], 'userId');
        if (req.method === 'DELETE') {
          await service.removeUser(userId, principal);
          res.writeHead(204, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
          res.end();
        } else {
          const body = await readJsonBody(req);
          writeData(res, 200, { user: await service.updateUser(userId, body, principal) });
        }
        return true;
      }
      if (resource === 'account' && segments[1] === 'password' && segments.length === 2 && req.method === 'POST') {
        const principal = await requirePrincipal(req);
        const body = await readJsonBody(req);
        writeData(res, 200, await service.changePassword({
          userId: optionalString(body.userId, 'userId', 128),
          currentPassword: body.currentPassword,
          newPassword: requiredString(body.newPassword, 'newPassword', 256),
        }, principal));
        return true;
      }
      if (resource === 'diagnostics' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'admin.read');
        writeData(res, 200, await service.getDiagnostics(principal));
        return true;
      }
      writeError(res, 404, 'not_found', 'The requested API resource does not exist.');
      return true;
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = error?.code || 'request_failed';
      const message = status >= 500 ? 'The hosted API request could not be completed.' : error?.message || 'The request was rejected.';
      writeError(res, status, code, message, error?.retryAfter ? { retryAfter: error.retryAfter } : {});
      return true;
    }
  };
}

export { OPENAPI_DOCUMENT };
