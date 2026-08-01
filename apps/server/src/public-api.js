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
  const path = action === 'direct'
    ? `/api/media/items/${encodeURIComponent(mediaId)}`
    : '/api/media/transcode';
  return new URL(`${path}?${query.toString()}`, 'http://loomtv.local');
}

function authTokenPresent(req, url) {
  return Boolean(req.headers.authorization || req.headers['x-loom-admin-token'] || url.searchParams.get('token'));
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
      downloads: false,
    },
    health: {
      status: health.status,
      media: health.media,
      transcoder: health.transcoder,
    },
  };
}

const OPENAPI_DOCUMENT = Object.freeze({
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
    '/api/v1/auth/onboarding': { get: { summary: 'Check whether owner onboarding is required' } },
    '/api/v1/auth/owner': { post: { summary: 'Create the first owner account' } },
    '/api/v1/auth/session': { post: { summary: 'Create an authenticated session' }, delete: { summary: 'Revoke the current session' } },
    '/api/v1/auth/me': { get: { summary: 'Return the authenticated account' } },
    '/api/v1/library': { get: { summary: 'List the authenticated catalog' } },
    '/api/v1/library/{mediaId}': { get: { summary: 'Read one catalog item' } },
    '/api/v1/library/scan': { get: { summary: 'Read scan status' }, post: { summary: 'Start a library scan' } },
    '/api/v1/profiles': { get: { summary: 'List profiles' }, post: { summary: 'Create a profile' } },
    '/api/v1/profiles/{profileId}': { patch: { summary: 'Update a profile' } },
    '/api/v1/profiles/{profileId}/select': { post: { summary: 'Select the active profile' } },
    '/api/v1/profiles/{profileId}/progress': { get: { summary: 'List watch progress' } },
    '/api/v1/profiles/{profileId}/progress/{mediaId}': { get: { summary: 'Read progress' }, put: { summary: 'Save progress' } },
    '/api/v1/media/{mediaId}': { get: { summary: 'Read media playback links' } },
    '/api/v1/media/{mediaId}/direct': { get: { summary: 'Stream a browser-compatible file' } },
    '/api/v1/media/{mediaId}/transcode': { post: { summary: 'Start an HLS transcode' } },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
});

/**
 * Versioned viewer/client API. Existing `/api/admin` and `/api/media` routes
 * remain intact; this handler is a stable adapter around those services.
 */
export function createPublicApiHandler({ service, clientState, mediaService, getRuntimeHealth, version }) {
  if (!service || !clientState || !mediaService) throw new Error('createPublicApiHandler requires server services.');

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
    if (!pathname.startsWith(`${PUBLIC_API_PREFIX}/`)) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        [PUBLIC_API_HEADER]: PUBLIC_API_VERSION,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Loom-Admin-Token',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return true;
    }

    const segments = pathname.slice(`${PUBLIC_API_PREFIX}/`.length).split('/').filter(Boolean);
    const resource = segments[0] || '';
    try {
      if (resource === 'discovery' && req.method === 'GET') {
        writeJson(res, 200, discoveryDocument(version, await getRuntimeHealth()));
        return true;
      }
      if (resource === 'auth' && segments[1] === 'onboarding' && req.method === 'GET') {
        writeJson(res, 200, { ownerConfigured: await service.isOwnerConfigured(), apiVersion: PUBLIC_API_VERSION });
        return true;
      }
      if (resource === 'auth' && segments[1] === 'owner' && req.method === 'POST') {
        if (await service.isOwnerConfigured()) throw requestError(409, 'owner_exists', 'The LoomTV owner has already been created.');
        const body = await readJsonBody(req);
        writeJson(res, 201, await service.createOwner({
          name: requiredString(body.name, 'name', 80),
          password: requiredString(body.password, 'password', 256),
        }));
        return true;
      }
      if (resource === 'auth' && segments[1] === 'session' && req.method === 'POST') {
        const body = await readJsonBody(req);
        writeJson(res, 200, await service.createSession({
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
        writeJson(res, 200, { user: await service.getCurrentUser(principal) });
        return true;
      }
      if (resource === 'library' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'library.read');
        writeJson(res, 200, { items: await service.listLibraryItems(principal) });
        return true;
      }
      if (resource === 'library' && segments[1] === 'scan' && (req.method === 'GET' || req.method === 'POST')) {
        const principal = await requirePrincipal(req, req.method === 'GET' ? 'library.read' : 'library.manage');
        if (req.method === 'GET') writeJson(res, 200, await service.getScanStatus(principal));
        else {
          const body = await readJsonBody(req);
          writeJson(res, 202, await service.startLibraryScan({ mode: body.mode, rootId: body.rootId }, principal));
        }
        return true;
      }
      if (resource === 'library' && segments.length === 2 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'library.read');
        const item = await service.getLibraryItem(decodeSegment(segments[1], 'mediaId'), principal);
        if (!item) throw requestError(404, 'media_not_found', 'Media item was not found.');
        writeJson(res, 200, { item });
        return true;
      }
      if (resource === 'profiles' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req);
        writeJson(res, 200, { profiles: await clientState.listProfiles(principal.id, canSeeAllProfiles(principal)) });
        return true;
      }
      if (resource === 'profiles' && segments.length === 1 && req.method === 'POST') {
        const principal = await requirePrincipal(req);
        const body = await readJsonBody(req);
        writeJson(res, 201, { profile: await clientState.createProfile(body, principal.id) });
        return true;
      }
      if (resource === 'profiles' && segments.length === 2 && req.method === 'PATCH') {
        const principal = await requirePrincipal(req);
        const body = await readJsonBody(req);
        writeJson(res, 200, { profile: await clientState.updateProfile(decodeSegment(segments[1], 'profileId'), body, principal.id, canSeeAllProfiles(principal)) });
        return true;
      }
      if (resource === 'profiles' && segments.length === 3 && segments[2] === 'select' && req.method === 'POST') {
        const principal = await requirePrincipal(req);
        writeJson(res, 200, { profile: await clientState.selectProfile(decodeSegment(segments[1], 'profileId'), principal.id, canSeeAllProfiles(principal)) });
        return true;
      }
      if (resource === 'profiles' && segments.length >= 3 && segments[2] === 'progress') {
        const principal = await requirePrincipal(req);
        const profileId = decodeSegment(segments[1], 'profileId');
        if (segments.length === 3 && req.method === 'GET') {
          writeJson(res, 200, { progress: await clientState.listProgress(profileId, principal.id, canSeeAllProfiles(principal)) });
          return true;
        }
        if (segments.length === 4 && (req.method === 'GET' || req.method === 'PUT' || req.method === 'POST')) {
          const mediaId = decodeSegment(segments[3], 'mediaId');
          if (req.method === 'GET') writeJson(res, 200, { progress: await clientState.getProgress(profileId, mediaId, principal.id, canSeeAllProfiles(principal)) });
          else writeJson(res, 200, { progress: await clientState.saveProgress(profileId, mediaId, await readJsonBody(req), principal.id, canSeeAllProfiles(principal)) });
          return true;
        }
      }
      if (resource === 'media' && segments.length === 2 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'library.read');
        const mediaId = decodeSegment(segments[1], 'mediaId');
        const item = await service.getLibraryItem(mediaId, principal);
        if (!item) throw requestError(404, 'media_not_found', 'Media item was not found.');
        writeJson(res, 200, {
          item,
          directUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/direct`,
          transcodeUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/transcode`,
        });
        return true;
      }
      if (resource === 'media' && segments.length === 3 && (segments[2] === 'direct' || segments[2] === 'transcode')) {
        const mediaId = decodeSegment(segments[1], 'mediaId');
        if (segments[2] === 'transcode') await requirePrincipal(req, 'transcode');
        else if (!authTokenPresent(req, url)) throw requestError(401, 'auth_required', 'A valid LoomTV session is required.');
        return handleMedia(req, res, url, mediaId, segments[2]);
      }
      return false;
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
