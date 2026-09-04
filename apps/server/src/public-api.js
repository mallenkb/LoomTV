import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hasPermission } from './auth-policy.js';
import { createDesktopSetupChannel } from './desktop-setup-channel.js';
import { SETUP_STEPS } from './setup-service.js';
import { createTrustedProxyPolicy } from './trusted-proxy.js';
import {
  MEDIA_CORE_CONTRACT_VERSION,
  normalizeClientPlaybackCapabilities,
} from '@loom-media-server/media-core';
import {
  CANONICAL_API_PREFIX,
  CANONICAL_API_VERSION,
  CANONICAL_API_VERSION_HEADER,
} from '@loom-media-server/video-contracts';
import { canonicalPublicError } from './public-error.js';
import { createCastSessionRegistry } from './cast-session-registry.js';
import { publicCatalog } from './public-catalog.js';

export const PUBLIC_API_PREFIX = CANONICAL_API_PREFIX;
export const PUBLIC_API_VERSION = CANONICAL_API_VERSION;
export const PUBLIC_API_HEADER = CANONICAL_API_VERSION_HEADER;

const MAX_BODY_BYTES = 128 * 1024;
const SESSION_COOKIE = '__Host-loomtv_session';
const CSRF_COOKIE = '__Host-loomtv_csrf';

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

function writeError(res, status, code, message, details = {}, headers = {}) {
  writeJson(res, status, { ok: false, error: { code, message, ...details } }, headers);
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

function requestCookie(req, name) {
  const raw = Array.isArray(req.headers.cookie) ? req.headers.cookie.join(';') : String(req.headers.cookie || '');
  if (!raw || raw.length > 8_192) return null;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function safeStringEqual(left, right) {
  const actual = Buffer.from(String(left || ''), 'utf8');
  const expected = Buffer.from(String(right || ''), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sameOriginRequest(req) {
  const origin = Array.isArray(req.headers.origin) ? '' : String(req.headers.origin || '');
  const host = Array.isArray(req.headers.host) ? '' : String(req.headers.host || '');
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' && parsed.host.toLowerCase() === host.toLowerCase();
  } catch { return false; }
}

function cookieSessionHeaders(token, csrfToken, expiresAt) {
  const maxAge = Math.max(1, Math.floor((Number(expiresAt) - Date.now()) / 1_000));
  return { 'Set-Cookie': [
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
    `${CSRF_COOKIE}=${csrfToken}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`,
  ] };
}

function clearCookieSessionHeaders() {
  return { 'Set-Cookie': [
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    `${CSRF_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Strict`,
  ] };
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
    throw requestError(400, 'invalid_request', `${field} is invalid.`);
  }
}

function pathForMedia(url, mediaId, action) {
  const query = new URLSearchParams(url.searchParams);
  query.set('itemId', mediaId);
  const path = action === 'download'
    ? `/api/media/items/${encodeURIComponent(mediaId)}/download`
    : action === 'direct'
      ? `/api/media/items/${encodeURIComponent(mediaId)}`
      : '/api/media/transcode';
  return new URL(`${path}?${query.toString()}`, 'http://loomtv.local');
}

function deviceIdForRequest(req, principal) {
  const raw = Array.isArray(req.headers['x-loom-device-id'])
    ? req.headers['x-loom-device-id'][0]
    : req.headers['x-loom-device-id'];
  const supplied = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 128) : null;
  const authenticated = principal.deviceId || `account:${principal.id}`;
  if (supplied && supplied !== authenticated) {
    throw requestError(403, 'device_identity_mismatch', 'The requested device does not match the authenticated credential.');
  }
  return authenticated;
}

function bindAuthenticationSession(profileContext, principal) {
  return {
    ...profileContext,
    remoteAccess: principal?.authentication === 'invitation-session' || hasPermission(principal, 'remote.access'),
    ...(principal?.sessionId ? { authenticationSessionId: principal.sessionId } : {}),
    ...(principal?.invitationSessionId ? { invitationSessionId: principal.invitationSessionId } : {}),
  };
}

export function publicHealthSummary(health) {
  const media = health?.media || {};
  const transcoder = health?.transcoder || {};
  const mediaStates = new Set(['unconfigured', 'online', 'offline', 'not-directory', 'permission-denied']);
  const transcoderStates = new Set(['available', 'limited', 'unavailable']);
  const publicStatuses = new Set(['ready', 'draining']);
  return {
    status: publicStatuses.has(health?.status) ? health.status : 'unknown',
    media: {
      configured: Boolean(media.configured),
      state: mediaStates.has(media.state) ? media.state : 'unknown',
      readable: media.readable === true,
    },
    transcoder: {
      available: transcoder.available === true,
      hardwareAcceleration: transcoder.hardwareAcceleration === true,
      recommendedBackend: typeof transcoder.recommendedBackend === 'string'
        ? transcoder.recommendedBackend.slice(0, 32)
        : 'software',
      state: transcoderStates.has(transcoder.state) ? transcoder.state : 'unavailable',
    },
  };
}

function publicLibraryItem(item) {
  if (!item || typeof item !== 'object') return item;
  const safeItem = {};
  for (const field of ['id', 'title', 'kind', 'seriesId']) {
    if (typeof item[field] === 'string' && item[field].length <= 500 && !item[field].includes('\u0000')) safeItem[field] = item[field];
  }
  for (const field of ['year', 'seasonNumber', 'episodeNumber', 'rating', 'createdAt', 'updatedAt']) {
    if (Number.isFinite(item[field])) safeItem[field] = Number(item[field]);
  }
  if (safeItem.seasonNumber === undefined && Number.isFinite(item.series?.season)) safeItem.seasonNumber = Number(item.series.season);
  if (safeItem.episodeNumber === undefined && Number.isFinite(item.series?.episode)) safeItem.episodeNumber = Number(item.series.episode);
  safeItem.available = item.available === true;
  if (Array.isArray(item.sourceIds)) safeItem.sourceIds = item.sourceIds
    .filter((sourceId) => typeof sourceId === 'string' && sourceId.length <= 256 && !sourceId.includes('\u0000'))
    .slice(0, 256);
  else safeItem.sourceIds = [];
  if (Array.isArray(item.legacyIds)) safeItem.legacyIds = item.legacyIds
    .filter((legacyId) => typeof legacyId === 'string' && legacyId.length <= 512 && !legacyId.includes('\u0000'))
    .slice(0, 512);
  else safeItem.legacyIds = [];
  if (item.animeLikely === true) safeItem.animeLikely = true;
  if (typeof item.summary === 'string') safeItem.summary = item.summary.slice(0, 20_000);
  if (Array.isArray(item.genres)) safeItem.genres = item.genres
    .filter((genre) => typeof genre === 'string' && genre.length <= 128 && !genre.includes('\u0000')).slice(0, 128);
  if (item.providerIds && typeof item.providerIds === 'object' && !Array.isArray(item.providerIds)) {
    safeItem.providerIds = Object.fromEntries(Object.entries(item.providerIds).slice(0, 64).flatMap(([key, value]) => (
      typeof value === 'string' && key.length <= 64 && value.length <= 256 && !key.includes('\u0000') && !value.includes('\u0000')
        ? [[key, value]] : []
    )));
  }
  return safeItem;
}

function publicLibraryRoot(root) {
  if (!root || typeof root !== 'object') return root;
  const safeRoot = {};
  for (const field of ['id']) {
    if (typeof root[field] === 'string' && root[field].length <= 128 && !root[field].includes('\u0000')) safeRoot[field] = root[field];
  }
  safeRoot.kind = root.kind === 'tvShows' ? 'tv' : ['movies','tv','anime','others'].includes(root.kind) ? root.kind : 'others';
  safeRoot.state = root.state === 'degraded' ? 'unreadable'
    : ['online','offline','unreadable','missing'].includes(root.state) ? root.state : 'missing';
  for (const field of ['createdAt', 'lastScanAt']) {
    if (Number.isFinite(root[field])) safeRoot[field] = Number(root[field]);
  }
  return safeRoot;
}

function publicPlaybackPlan(plan) {
  const result = {};
  for (const field of [
    'contractVersion', 'mode', 'transport', 'reasonCode', 'sourceId',
    'selectedVideoTrackId', 'selectedAudioTrackId', 'selectedSubtitleTrackId',
    'outputContainer', 'outputVideoCodec', 'outputAudioCodec', 'burnSubtitles',
    'toneMap', 'maxWidth', 'maxHeight', 'videoBitrateKbps', 'audioBitrateKbps',
  ]) {
    if (plan?.[field] !== undefined) result[field] = plan[field];
  }
  return result;
}

function publicMediaProbe(probe) {
  if (!probe || typeof probe !== 'object') return null;
  const result = {};
  for (const field of ['sourceId','container','videoCodec','audioCodec','hdrFormat']) {
    if (typeof probe[field] === 'string' && probe[field].length <= 256 && !probe[field].includes('\u0000')) result[field] = probe[field];
  }
  for (const field of ['durationSeconds','bitrateKbps','width','height','probedAt']) {
    if (Number.isFinite(probe[field]) && Number(probe[field]) >= 0) result[field] = Number(probe[field]);
  }
  result.hdr = probe.hdr === true;
  result.tracks = (Array.isArray(probe.tracks) ? probe.tracks : []).slice(0, 256).flatMap((track) => {
    if (!track || typeof track !== 'object' || typeof track.id !== 'string'
      || !Number.isSafeInteger(track.index) || !['video','audio','subtitle','data','unknown'].includes(track.kind)) return [];
    const safe = { id: track.id.slice(0, 128), index: track.index, kind: track.kind,
      default: track.default === true, forced: track.forced === true };
    for (const field of ['codec','language','title','profile','pixelFormat','colorTransfer','colorPrimaries','colorSpace']) {
      if (typeof track[field] === 'string' && track[field].length <= 200 && !track[field].includes('\u0000')) safe[field] = track[field];
    }
    for (const field of ['channels','width','height','frameRate']) {
      if (Number.isFinite(track[field]) && Number(track[field]) >= 0) safe[field] = Number(track[field]);
    }
    if (track.external === true) safe.external = true;
    return [safe];
  });
  result.chapters = (Array.isArray(probe.chapters) ? probe.chapters : []).slice(0, 10_000).flatMap((chapter) => (
    chapter && Number.isFinite(chapter.startMs) && Number.isFinite(chapter.endMs)
      && chapter.endMs > chapter.startMs && typeof chapter.title === 'string'
      ? [{ startMs: Number(chapter.startMs), endMs: Number(chapter.endMs), title: chapter.title.slice(0, 500) }]
      : []
  ));
  if (Array.isArray(probe.adapterGaps)) result.adapterGaps = probe.adapterGaps
    .filter((gap) => typeof gap === 'string' && gap.length <= 128 && !gap.includes('\u0000')).slice(0, 16);
  return result;
}

function discoveryDocument(version, health) {
  return {
    apiVersion: PUBLIC_API_VERSION,
    serverVersion: version,
    mediaCoreContractVersion: health.mediaCoreContractVersion,
    openapi: '/api/v1/openapi.json',
    client: { app: '/app/', admin: '/admin/', setup: '/setup/' },
    capabilities: {
      authentication: true,
      profiles: true,
      watchProgress: true,
      library: true,
      conditionalCatalog: true,
      artworkEditing: false,
      directStreaming: true,
      hlsTranscoding: Boolean(health.capabilities?.transcoding),
      playbackPlan: true,
      playbackModes: ['direct', 'remux', 'transcode'],
      trackSelection: true,
      mediaProbe: true,
      externalSidecarSubtitles: true,
      hardwareAcceleration: Boolean(health.capabilities?.hardwareAcceleration),
      profilePins: true,
      pairing: true,
      deviceCredentials: true,
      downloads: true,
      casting: { airplay: true, chromecast: true, dlna: true, receiverLaunch: 'client-native' },
    },
    authentication: {
      accountSession: 'Bearer',
      browserSession: { mode: 'same-origin-cookie', sessionMode: 'cookie', csrfHeader: 'X-Loom-CSRF',
        secure: true, sameSite: 'Strict', cleartextPolicy: 'memory-only-bearer' },
      deviceCredential: 'LoomDevice',
      pairingCapability: 'LoomPairing',
    },
    ...(health.server?.certificateFingerprint ? { certificateFingerprint: health.server.certificateFingerprint } : {}),
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
    '/api/v1/openapi.json': { get: { summary: 'Read this API description' } },
    '/api/v1/discovery': { get: { summary: 'Discover capabilities and client URLs' } },
    '/api/v1/health': { get: { summary: 'Read a safe unauthenticated health summary' } },
    '/api/v1/auth/onboarding': { get: { summary: 'Check whether owner onboarding is required' } },
    '/api/v1/auth/owner': { post: { summary: 'Create the first owner account' } },
    '/api/v1/auth/session': { post: { summary: 'Create an authenticated session' }, delete: { summary: 'Revoke the current session' } },
    '/api/v1/auth/me': { get: { summary: 'Return the authenticated account' } },
    '/api/v1/setup/state': { get: { summary: 'Read first-run setup status shared by /app and /admin' } },
    '/api/v1/setup/owner': { post: { summary: 'Create the first owner during setup' } },
    '/api/v1/setup/libraries': { get: { summary: 'List library folders added during setup' }, post: { summary: 'Add a library folder during setup' } },
    '/api/v1/setup/libraries/{rootId}': { delete: { summary: 'Remove a library folder during setup' } },
    '/api/v1/setup/libraries/check': { post: { summary: 'Check whether the server can read a folder' } },
    '/api/v1/setup/libraries/browse': { post: { summary: 'Browse folders visible to the server' } },
    '/api/v1/setup/libraries/search': { post: { summary: 'Search folders visible to the server' } },
    '/api/v1/setup/libraries/pick': { post: { summary: 'Open the desktop folder picker' } },
    '/api/v1/setup/metadata': { get: { summary: 'Read metadata provider settings' }, put: { summary: 'Save or skip metadata provider settings' } },
    '/api/v1/setup/metadata/test': { post: { summary: 'Test a metadata provider key' } },
    '/api/v1/setup/step': { post: { summary: 'Record setup progress' } },
    '/api/v1/setup/complete': { post: { summary: 'Finish setup and start the first scan' } },
    '/api/v1/library': { get: { summary: 'List the authenticated catalog' } },
    '/api/v1/library/catalog': { get: { summary: 'Read a profile-filtered catalog with ETag revalidation, or one title and its episodes using mediaId', parameters: [{ name: 'mediaId', in: 'query', required: false, schema: { type: 'string' } }] } },
    '/api/v1/library/series': { get: { summary: 'List episodes grouped into series and seasons' } },
    '/api/v1/library/roots': { get: { summary: 'List the authenticated library roots' }, post: { summary: 'Add a library root' } },
    '/api/v1/library/roots/{rootId}': { delete: { summary: 'Remove a library root' } },
    '/api/v1/library/{mediaId}': { get: { summary: 'Read one catalog item' } },
    '/api/v1/library/scan': { get: { summary: 'Read scan status' }, post: { summary: 'Start a library scan' } },
    '/api/v1/profiles': { get: { summary: 'List profiles' }, post: { summary: 'Create a profile' } },
    '/api/v1/profiles/{profileId}': { patch: { summary: 'Update a profile' }, delete: { summary: 'Remove a profile' } },
    '/api/v1/profiles/{profileId}/select': { post: { summary: 'Select the active profile' } },
    '/api/v1/profiles/selection': { get: { summary: 'Read the active profile selection' }, patch: { summary: 'Update automatic profile sign-in' }, delete: { summary: 'Clear the active profile selection' } },
    '/api/v1/profiles/selection/lock': { post: { summary: 'Lock the active profile selection' } },
    '/api/v1/profiles/{profileId}/pin': { put: { summary: 'Set or remove a profile PIN' } },
    '/api/v1/profiles/{profileId}/preferences': { get: { summary: 'Read profile preferences' }, patch: { summary: 'Replace profile preferences' } },
    '/api/v1/profiles/{profileId}/lists': { get: { summary: 'List profile list entries' } },
    '/api/v1/profiles/{profileId}/lists/{kind}/{mediaId}': { put: { summary: 'Add a profile list entry' }, delete: { summary: 'Remove a profile list entry' } },
    '/api/v1/profiles/{profileId}/track-preferences/{scope}': { get: { summary: 'Read playback track preferences' }, put: { summary: 'Replace playback track preferences' } },
    '/api/v1/profiles/{profileId}/progress': { get: { summary: 'List watch progress' } },
    '/api/v1/profiles/{profileId}/progress/{mediaId}': { get: { summary: 'Read progress' }, put: { summary: 'Save progress' } },
    '/api/v1/media/{mediaId}': { get: { summary: 'Read media playback links' } },
    '/api/v1/media/{mediaId}/direct': { get: { summary: 'Stream a browser-compatible file' } },
    '/api/v1/media/{mediaId}/direct/renew': { post: { summary: 'Renew a direct playback lease before idle expiry' } },
    '/api/v1/media/{mediaId}/playback-plan': { post: { summary: 'Choose direct playback or an HLS transcode for a client profile' } },
    '/api/v1/media/{mediaId}/subtitles/{trackId}': { get: { summary: 'Read an external subtitle through a playback capability' } },
    '/api/v1/cast/sessions': { post: { summary: 'Create a bounded cast capability' } },
    '/api/v1/cast/sessions/{castSessionId}': { patch: { summary: 'Renew or update a cast session' }, delete: { summary: 'Stop a cast session' } },
    '/api/v1/media/{mediaId}/transcode': { post: { summary: 'Start an HLS transcode' } },
    '/api/v1/media/{mediaId}/transcode/renew': { post: { summary: 'Renew an HLS playback lease before idle expiry' } },
    '/api/v1/media/{mediaId}/playback-session/renew': { post: { summary: 'Renew a direct or HLS playback lease' } },
    '/api/v1/media/{mediaId}/playback-session': { delete: { summary: 'Stop a direct or HLS playback lease' } },
    '/api/v1/users': { get: { summary: 'List scoped user accounts' }, post: { summary: 'Create a user account' } },
    '/api/v1/users/{userId}': { patch: { summary: 'Update a user account' }, delete: { summary: 'Remove a user account' } },
    '/api/v1/account/password': { post: { summary: 'Change or reset an account password' } },
    '/api/v1/devices': { get: { summary: 'List paired devices' } },
    '/api/v1/devices/{deviceId}': { delete: { summary: 'Revoke a paired device' } },
    '/api/v1/remote-policy': { get: { summary: 'Read remote access policy' }, patch: { summary: 'Update remote access policy' } },
    '/api/v1/audit-events': { get: { summary: 'Read redacted security audit events' } },
    '/api/v1/invitations': { get: { summary: 'List invitations' }, post: { summary: 'Create a scoped invitation' } },
    '/api/v1/invitations/{invitationId}/accept': { post: { summary: 'Accept a scoped invitation once' } },
    '/api/v1/invitations/{invitationId}': { delete: { summary: 'Revoke an invitation and its sessions' } },
    '/api/v1/invitations/session': { delete: { summary: 'Revoke the current invitation session' } },
    '/api/v1/downloads': { get: { summary: 'List offline download leases' }, post: { summary: 'Reserve an offline download lease' } },
    '/api/v1/downloads/{downloadId}': { delete: { summary: 'Revoke an offline download lease' } },
    '/api/v1/downloads/{downloadId}/content': { get: { summary: 'Read content using an offline download capability' } },
    '/api/v1/pairing/requests': { post: { summary: 'Request device pairing approval' } },
    '/api/v1/pairing/requests/{requestId}': { get: { summary: 'Claim an approved device credential once' } },
    '/api/v1/pairing/requests/{requestId}/approve': { post: { summary: 'Approve or deny a device pairing request' } },
    '/api/v1/diagnostics': { get: { summary: 'Read administrator diagnostics' } },
    '/api/v1/sessions': { get: { summary: 'List active playback sessions' } },
    '/api/v1/logs': { get: { summary: 'Read operational logs' } },
    '/api/v1/backups': { get: { summary: 'Read backup status' }, post: { summary: 'Create a backup' } },
    '/api/v1/backups/restore': { post: { summary: 'Validate and restore a backup as the configured owner' } },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      browserCookie: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
      csrf: { type: 'apiKey', in: 'header', name: 'X-Loom-CSRF' },
    },
  },
}));

/**
 * Versioned viewer/client API. Existing `/api/admin` and `/api/media` routes
 * remain intact; this handler is a stable adapter around those services.
 */
export function createPublicApiHandler({ service, clientState, mediaService, pairingService, remotePolicy, setupService, setupHooks = {}, getRuntimeHealth, version, requireSecureTransport = false, requireBootstrapSecret = true, proxyPolicy = createTrustedProxyPolicy(), castSessions = createCastSessionRegistry(), desktopSetupChannel, pickFolder, deploymentMode = 'standalone' }) {
  if (!service || !clientState || !mediaService || !pairingService || !remotePolicy) throw new Error('createPublicApiHandler requires server services.');
  const desktopChannel = desktopSetupChannel || createDesktopSetupChannel({ clientAddress: (req) => proxyPolicy.clientAddress(req) });

  async function waitForSetupScan(scan, principal, res) {
    if (!scan || scan.state !== 'scanning') return scan;
    let pollTimer;
    let stopped = false;
    let rejectWait;
    const interrupted = new Promise((_, reject) => { rejectWait = reject; });
    const disconnect = () => rejectWait(requestError(499, 'request_cancelled', 'The setup client disconnected.'));
    const deadline = setTimeout(() => rejectWait(requestError(504, 'setup_scan_timeout', 'The library is still scanning. Check scan status and retry setup completion.')), 30_000);
    res.once('close', disconnect);
    if (res.destroyed) disconnect();
    try {
      return await Promise.race([interrupted, (async () => {
        while (!stopped) {
          await new Promise((resolve) => { pollTimer = setTimeout(resolve, 250); });
          if (stopped) return;
          const current = await service.getScanStatus(principal);
          if (current?.id !== scan.id || current.state !== 'scanning') {
            if (current?.state === 'failed' || current?.state === 'interrupted') {
              throw requestError(500, 'setup_scan_failed', 'The library scan did not finish. Check the saved folders and retry.');
            }
            return current;
          }
        }
      })()]);
    } finally {
      stopped = true;
      clearTimeout(deadline);
      clearTimeout(pollTimer);
      res.off('close', disconnect);
    }
  }

  function isSecureRequest(req) {
    return proxyPolicy.isSecureRequest(req);
  }

  async function principalForRequest(req) {
    const invitation = await remotePolicy.authenticateInvitation(req);
    if (invitation) return invitation;
    if (req.headers.authorization || req.headers['x-loom-admin-token']) return service.authenticateRequest(req);
    const sessionToken = requestCookie(req, SESSION_COOKIE);
    if (!sessionToken) return service.authenticateRequest(req);
    if (!isSecureRequest(req)) {
      throw requestError(426, 'secure_transport_required', 'Browser cookie sessions require HTTPS.');
    }
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const csrfCookie = requestCookie(req, CSRF_COOKIE);
      const csrfHeader = Array.isArray(req.headers['x-loom-csrf']) ? '' : String(req.headers['x-loom-csrf'] || '');
      if (!sameOriginRequest(req) || !csrfCookie || !safeStringEqual(csrfCookie, csrfHeader)) {
        throw requestError(403, 'permission_denied', 'The browser session CSRF proof is missing or invalid.');
      }
    }
    req.__loomCookieSessionToken = sessionToken;
    return service.authenticateRequest({ ...req, headers: { ...req.headers, authorization: `Bearer ${sessionToken}` } });
  }

  async function requirePrincipal(req, permission) {
    const principal = await principalForRequest(req);
    if (!principal) throw requestError(401, 'auth_required', 'A valid LoomTV session is required.');
    if (principal.authentication === 'invitation-session') {
      const pathname = new URL(req.url || '/', 'https://loomtv.local').pathname;
      const invitationRoute = pathname.startsWith(`${PUBLIC_API_PREFIX}/library`)
        || pathname.startsWith(`${PUBLIC_API_PREFIX}/media/`)
        || pathname.startsWith(`${PUBLIC_API_PREFIX}/cast/`)
        || pathname.startsWith(`${PUBLIC_API_PREFIX}/downloads`)
        || pathname === `${PUBLIC_API_PREFIX}/invitations/session`
        || pathname === `${PUBLIC_API_PREFIX}/auth/me`;
      if (!invitationRoute) throw requestError(403, 'permission_denied', 'Invitation sessions cannot access this route.');
    }
    remotePolicy.assertPrincipal(req, principal, 'public');
    if (permission && !await service.authorizePrincipal(principal, permission)) {
      throw requestError(403, 'permission_denied', 'This account is not allowed to perform that action.');
    }
    return principal;
  }

  function canSeeAllProfiles(principal) {
    return hasPermission(principal, 'users.manage');
  }

  function requireSetupService() {
    if (!setupService) throw requestError(501, 'setup_unavailable', 'This server was started without the setup service.');
    return setupService;
  }

  /**
   * Report whether the server can read a folder now. A share that is offline
   * is still savable — the caller decides — because a NAS that is asleep at
   * setup time is a normal thing, not a configuration mistake.
   */
  async function inspectSetupFolder(target) {
    try {
      const stats = await fs.stat(target);
      if (!stats.isDirectory()) {
        return { accessible: false, retryable: false, reason: 'not_a_directory', message: 'That path is not a folder.' };
      }
      await fs.access(target);
      return { accessible: true, retryable: false, reason: 'online', message: 'The server can read this folder.' };
    } catch (error) {
      if (error?.code === 'EACCES') {
        return { accessible: false, retryable: true, reason: 'permission_denied', message: 'The server cannot read that folder. Check its permissions, or save it and retry later.' };
      }
      return { accessible: false, retryable: true, reason: 'unavailable', message: 'That folder is not reachable right now. Save it and LoomTV will pick it up once the share is back.' };
    }
  }

  /** Validate one of the keyed metadata providers without storing its secret. */
  async function testMetadataProvider(provider, apiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const id = ['tmdb', 'fanart', 'omdb', 'opensubtitles', 'tvdb'].includes(provider) ? provider : 'tmdb';
    const isReadToken = id === 'tmdb' && /^ey[A-Za-z0-9._-]{20,}$/.test(apiKey);
    const requests = {
      tmdb: {
        endpoint: isReadToken
          ? 'https://api.themoviedb.org/3/configuration'
          : `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(apiKey)}`,
        headers: isReadToken ? { Authorization: `Bearer ${apiKey}` } : {},
      },
      fanart: { endpoint: `https://webservice.fanart.tv/v3/movies/120?api_key=${encodeURIComponent(apiKey)}`, headers: {} },
      omdb: { endpoint: `https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&i=tt0133093`, headers: {} },
      opensubtitles: {
        endpoint: 'https://api.opensubtitles.com/api/v1/infos/languages',
        headers: { 'Api-Key': apiKey, 'User-Agent': 'LoomTV v1' },
      },
      tvdb: {
        endpoint: 'https://api4.thetvdb.com/v4/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: apiKey }),
      },
    };
    const labels = { tmdb: 'TMDB', fanart: 'Fanart.tv', omdb: 'OMDb', opensubtitles: 'OpenSubtitles', tvdb: 'TheTVDB' };
    const request = requests[id];
    try {
      const response = await fetch(request.endpoint, {
        method: request.method || 'GET',
        headers: { Accept: 'application/json', ...request.headers },
        body: request.body,
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, code: 'invalid_key', message: `${labels[id]} rejected that key.` };
      }
      if (!response.ok) return { ok: false, code: 'provider_error', message: `${labels[id]} replied with status ${response.status}.` };
      if (id === 'omdb') {
        const payload = await response.json().catch(() => ({}));
        if (payload?.Response === 'False') return { ok: false, code: 'invalid_key', message: String(payload.Error || 'OMDb rejected that key.') };
      }
      if (id === 'tvdb') {
        const payload = await response.json().catch(() => ({}));
        const token = payload?.data?.token || payload?.token;
        if (typeof token !== 'string' || !token) return { ok: false, code: 'invalid_key', message: 'TheTVDB did not return an access token.' };
      }
      return { ok: true, message: `${labels[id]} accepted the key.` };
    } catch (error) {
      return {
        ok: false,
        code: error?.name === 'AbortError' ? 'timeout' : 'unreachable',
        message: error?.name === 'AbortError'
          ? `${labels[id]} did not answer in time.`
          : `LoomTV could not reach ${labels[id]}. Check this server's internet access.`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function testSetupMetadata(provider, apiKey) {
    if (typeof setupHooks.testMetadata !== 'function') return testMetadataProvider(provider, apiKey);
    const verdict = await setupHooks.testMetadata({ provider, apiKey });
    return {
      ok: verdict?.ok === true,
      code: verdict?.code || (verdict?.ok === true ? undefined : 'invalid_key'),
      message: verdict?.message || (verdict?.ok === true ? 'The provider accepted the key.' : 'The provider rejected that key.'),
    };
  }

  async function playbackProfileContext(principal, req, media = undefined) {
    if (principal.authentication === 'invitation-session') {
      return remotePolicy.invitationProfileContext(principal, media);
    }
    return clientState.requireActivePlaybackProfile(principal.id, deviceIdForRequest(req, principal), media);
  }

  async function requireSelectedProfile(principal, req, profileId, media = undefined) {
    const active = await playbackProfileContext(principal, req, media);
    if (active.profileId !== profileId) throw requestError(403, 'permission_denied', 'The requested profile is not the active unlocked profile.');
    return active;
  }

  async function profileVisibleItems(principal, req) {
    await playbackProfileContext(principal, req);
    const visible = [];
    for (const item of await service.listLibraryItems(principal)) {
      try {
        await playbackProfileContext(principal, req, item);
        visible.push(item);
      } catch (error) {
        if (error?.code === 'permission_denied') continue;
        throw error;
      }
    }
    return visible;
  }

  async function requireLiveCastBinding(req, principal, record) {
    if (!record || record.principalId !== principal.id) {
      throw requestError(404, 'not_found', 'Cast session was not found.');
    }
    if (record.authenticationSessionId && record.authenticationSessionId !== principal.sessionId) {
      throw requestError(401, 'session_expired', 'The account session that created this cast is no longer active.');
    }
    if (record.invitationSessionId && record.invitationSessionId !== principal.invitationSessionId) {
      throw requestError(401, 'session_expired', 'The invitation session that created this cast is no longer active.');
    }
    const item = await service.getLibraryItem(record.mediaId, principal);
    if (!item) throw requestError(404, 'media_not_found', 'The cast media is no longer available.');
    const profile = await playbackProfileContext(principal, req, item);
    if (profile.profileId !== record.profileId || profile.deviceId !== record.deviceId
      || profile.selectionRevision !== record.selectionRevision) {
      throw requestError(409, 'stale_profile_selection', 'The profile selected for this cast has changed.');
    }
    const source = await mediaService.describeDirectCapability(record.mediaId, principal, profile, record.sourceId);
    if (source.sourceId !== record.sourceId || source.fileVersion !== record.fileVersion) {
      throw requestError(409, 'source_unavailable', 'The cast media source changed.');
    }
    return { item, profile };
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
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Loom-Admin-Token, X-Loom-Device-Id, X-Loom-CSRF',
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
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Loom-Admin-Token, X-Loom-Device-Id, X-Loom-CSRF',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return true;
    }

    const segments = pathname.slice(`${PUBLIC_API_PREFIX}/`.length).split('/').filter(Boolean);
    const resource = segments[0] || '';
    const pairingRoute = resource === 'pairing';
    const publicDiscovery = (resource === 'discovery' && req.method === 'GET')
      || (resource === 'health' && req.method === 'GET')
      || (resource === 'auth' && segments[1] === 'onboarding' && req.method === 'GET')
      || (resource === 'setup' && segments[1] === 'state' && req.method === 'GET')
      || (pathname === `${PUBLIC_API_PREFIX}/openapi.json` && (req.method === 'GET' || req.method === 'HEAD'));
    if ((pairingRoute || (requireSecureTransport && !publicDiscovery)) && !isSecureRequest(req)) {
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
      if (resource === 'pairing' && segments[1] === 'requests' && segments.length === 2 && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await pairingService.request({
          name: optionalString(body.name ?? body.deviceName, 'name', 80),
          kind: optionalString(body.kind ?? body.platform, 'kind', 32),
          permissions: body.permissions,
          certificateFingerprint: optionalString(body.certificateFingerprint, 'certificateFingerprint', 128),
          address: proxyPolicy.clientAddress(req),
        });
        remotePolicy.audit('pairing.request', 'created', req.__loomRemoteContext, null, { requestId: result.requestId });
        writeData(res, 202, result);
        return true;
      }
      if (resource === 'pairing' && segments[1] === 'requests' && segments.length === 3 && req.method === 'GET') {
        const authorization = String(req.headers.authorization || '');
        const match = /^LoomPairing\s+([A-Za-z0-9_-]{32,256})$/.exec(authorization.trim());
        if (!match) throw requestError(401, 'auth_required', 'A pairing request capability is required.');
        const result = await pairingService.status(decodeSegment(segments[2], 'requestId'), match[1], proxyPolicy.clientAddress(req));
        writeData(res, result.status === 'pending' ? 202 : 200, result);
        return true;
      }
      if (resource === 'pairing' && segments[1] === 'requests' && segments.length === 4
        && segments[3] === 'approve' && req.method === 'POST') {
        const principal = await requirePrincipal(req, 'devices.manage');
        const body = await readJsonBody(req);
        const requestId = decodeSegment(segments[2], 'requestId');
        const result = await pairingService.approve(requestId, {
          approved: body.approved !== false,
          accountId: optionalString(body.accountId, 'accountId', 128),
          permissions: body.permissions,
        }, principal);
        remotePolicy.audit('pairing.approve', result.status === 'denied' ? 'denied' : 'created', req.__loomRemoteContext, principal, { requestId });
        writeData(res, 200, result);
        return true;
      }
      if (resource === 'remote-policy' && segments.length === 1 && req.method === 'GET') {
        await requirePrincipal(req, 'admin.read');
        writeData(res, 200, remotePolicy.policy());
        return true;
      }
      if (resource === 'remote-policy' && segments.length === 1 && req.method === 'PATCH') {
        const principal = await requirePrincipal(req, 'remote.manage');
        writeData(res, 200, remotePolicy.updatePolicy(await readJsonBody(req), principal, req));
        return true;
      }
      if (resource === 'audit-events' && segments.length === 1 && req.method === 'GET') {
        await requirePrincipal(req, 'audit.read');
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
        const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
        writeData(res, 200, { events: remotePolicy.listAuditEvents({ limit, before }) });
        return true;
      }
      if (resource === 'invitations' && segments.length === 1 && req.method === 'POST') {
        const principal = await requirePrincipal(req, 'sharing.manage');
        writeData(res, 201, await remotePolicy.createInvitation(await readJsonBody(req), principal, req));
        return true;
      }
      if (resource === 'invitations' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'sharing.manage');
        writeData(res, 200, { invitations: remotePolicy.listInvitations(principal) });
        return true;
      }
      if (resource === 'invitations' && segments[1] === 'session' && segments.length === 2 && req.method === 'DELETE') {
        const principal = await requirePrincipal(req);
        remotePolicy.revokeInvitationSession(principal, req);
        res.writeHead(204, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
        res.end();
        return true;
      }
      if (resource === 'invitations' && segments.length === 3 && segments[2] === 'accept' && req.method === 'POST') {
        const match = /^LoomInvite\s+([A-Za-z0-9_-]{32,256})$/.exec(String(req.headers.authorization || '').trim());
        if (!match) throw requestError(401, 'auth_required', 'An invitation capability is required.');
        const body = await readJsonBody(req);
        writeData(res, 201, await remotePolicy.acceptInvitation(decodeSegment(segments[1], 'invitationId'), match[1],
          requiredString(body.deviceId, 'deviceId', 128), req));
        return true;
      }
      if (resource === 'invitations' && segments.length === 2 && req.method === 'DELETE') {
        const principal = await requirePrincipal(req, 'sharing.manage');
        remotePolicy.revokeInvitation(decodeSegment(segments[1], 'invitationId'), principal, req);
        res.writeHead(204, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
        res.end();
        return true;
      }
      if (resource === 'downloads' && segments.length === 1 && req.method === 'POST') {
        const principal = await requirePrincipal(req, 'downloads');
        writeData(res, 201, await remotePolicy.createDownload(await readJsonBody(req), principal, req));
        return true;
      }
      if (resource === 'downloads' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'downloads');
        writeData(res, 200, { downloads: remotePolicy.listDownloads(principal) });
        return true;
      }
      if (resource === 'downloads' && segments.length === 3 && segments[2] === 'content'
        && (req.method === 'GET' || req.method === 'HEAD')) {
        const downloadId = decodeSegment(segments[1], 'downloadId');
        const authorization = await remotePolicy.authorizeDownload(req, downloadId);
        res.__loomtvPublicApi = true;
        return mediaService.serveOfflineDownload(req, res, authorization);
      }
      if (resource === 'downloads' && segments.length === 2 && req.method === 'DELETE') {
        const principal = await requirePrincipal(req, 'downloads');
        remotePolicy.revokeDownload(decodeSegment(segments[1], 'downloadId'), principal, req);
        res.writeHead(204, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
        res.end();
        return true;
      }
      if (resource === 'cast' && segments[1] === 'sessions' && segments.length === 2 && req.method === 'POST') {
        const principal = await requirePrincipal(req, 'stream');
        const body = await readJsonBody(req);
        const mediaId = requiredString(body.mediaId, 'mediaId', 128);
        const transport = requiredString(body.transport, 'transport', 32).toLowerCase();
        const item = await service.getLibraryItem(mediaId, principal);
        if (!item) throw requestError(404, 'media_not_found', 'Media item was not found.');
        const profile = await playbackProfileContext(principal, req, item);
        const planned = await mediaService.planPlayback(mediaId, {
          sourceId: optionalString(body.sourceId, 'sourceId', 256),
          capabilities: normalizeClientPlaybackCapabilities(body.capabilities || {}),
          audioTrackId: body.audioTrackId === null ? null : optionalString(body.audioTrackId, 'audioTrackId', 128),
          subtitleTrackId: body.subtitleTrackId === null ? null : optionalString(body.subtitleTrackId, 'subtitleTrackId', 128),
        }, principal, profile);
        if (planned.plan.sourceAction !== 'direct') {
          throw requestError(422, 'playback_not_supported', 'This receiver requires a direct stream. Choose a compatible receiver or client.');
        }
        const source = await mediaService.describeDirectCapability(mediaId, principal, profile, planned.plan.sourceId);
        const boundProfile = bindAuthenticationSession({ ...profile, sourceId: source.sourceId, fileId: planned.sourceIdentity.fileId }, principal);
        const playback = mediaService.issuePlaybackToken(mediaId, principal.id, 'direct', boundProfile);
        const created = castSessions.create({
          transport,
          receiverName: optionalString(body.receiverName, 'receiverName', 120) || transport,
          principalId: principal.id,
          authenticationSessionId: principal.sessionId,
          invitationSessionId: principal.invitationSessionId,
          profileId: profile.profileId,
          deviceId: profile.deviceId,
          selectionRevision: profile.selectionRevision,
          mediaId,
          sourceId: source.sourceId,
          fileVersion: source.fileVersion,
          playbackSessionId: playback.sessionId,
          positionSeconds: Number.isFinite(body.positionSeconds) ? Number(body.positionSeconds) : 0,
        });
        remotePolicy.audit('cast.session.create', 'created', req.__loomRemoteContext, principal, { castSessionId: created.session.id, transport });
        writeData(res, 201, {
          session: created.session,
          mediaUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/direct?token=${encodeURIComponent(playback.token)}`,
          expiresAt: Math.min(created.session.expiresAt, playback.expiresAt),
          receiverLaunch: 'client-native',
        });
        return true;
      }
      if (resource === 'cast' && segments[1] === 'sessions' && segments.length === 3
        && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const principal = await requirePrincipal(req, 'stream');
        const castSessionId = decodeSegment(segments[2], 'castSessionId');
        const record = castSessions.read(castSessionId);
        await requireLiveCastBinding(req, principal, record);
        if (req.method === 'DELETE') {
          castSessions.remove(castSessionId);
          await mediaService.stopPlaybackSession(record.playbackSessionId, principal, record.mediaId);
          remotePolicy.audit('cast.session.stop', 'revoked', req.__loomRemoteContext, principal, { castSessionId, transport: record.transport });
          res.writeHead(204, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
          res.end();
          return true;
        }
        const body = await readJsonBody(req);
        const renewed = await mediaService.renewPlaybackSession(record.playbackSessionId, principal, record.mediaId, 'direct', req);
        if (!renewed) throw requestError(401, 'playback_session_invalid', 'The cast capability expired or was revoked.');
        const updated = castSessions.update(castSessionId, {
          state: optionalString(body.state, 'state', 16),
          positionSeconds: body.positionSeconds,
        });
        remotePolicy.audit('cast.session.update', 'updated', req.__loomRemoteContext, principal, { castSessionId, transport: record.transport });
        writeData(res, 200, {
          session: updated.session,
          mediaUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(record.mediaId)}/direct?token=${encodeURIComponent(renewed.token)}`,
          expiresAt: Math.min(updated.session.expiresAt, renewed.expiresAt),
        });
        return true;
      }
      // ── First-run setup ────────────────────────────────────────────────
      // One flow, one state. `/app` and `/admin` both redirect into `/setup`,
      // which drives these routes, so the two entry points cannot drift.
      if (resource === 'setup' && segments[1] === 'state' && segments.length === 2 && req.method === 'GET') {
        const setup = requireSetupService();
        const trusted = desktopChannel.isTrustedRequest(req);
        const runtimeHealth = typeof getRuntimeHealth === 'function'
          ? await getRuntimeHealth().catch(() => null)
          : null;
        const browseRootConfigured = runtimeHealth?.media?.configured !== false;
        writeData(res, 200, {
          ...await setup.status(),
          steps: SETUP_STEPS,
          deploymentMode,
          // Both desktop and web setup use the account password. Deployments
          // that opt into a claim secret expose that requirement explicitly.
          trustedDesktop: trusted,
          requiresBootstrapSecret: !trusted && requireBootstrapSecret,
          nativeFolderPicker: trusted && typeof pickFolder === 'function',
          folderBrowse: typeof service.listLibraryDirectories === 'function' && browseRootConfigured,
        });
        return true;
      }
      if (resource === 'setup' && segments[1] === 'owner' && segments.length === 2 && req.method === 'POST') {
        const setup = requireSetupService();
        if (await service.isOwnerConfigured()) throw requestError(409, 'owner_exists', 'The LoomTV owner has already been created.');
        const body = await readJsonBody(req);
        const sessionMode = body.sessionMode === undefined ? 'bearer' : body.sessionMode;
        if (!['bearer','cookie'].includes(sessionMode)) throw requestError(400, 'invalid_request', 'sessionMode must be bearer or cookie.');
        if (sessionMode === 'cookie' && (!isSecureRequest(req) || !sameOriginRequest(req))) {
          throw requestError(426, 'secure_transport_required', 'Browser cookie sessions require same-origin HTTPS.');
        }
        const trusted = desktopChannel.isTrustedRequest(req);
        const name = requiredString(body.name, 'name', 80);
        const result = await service.createOwner({
          name,
          password: requiredString(body.password, 'password', 256),
          ...(trusted || !requireBootstrapSecret
            ? { trustedChannel: true }
            : { bootstrapSecret: requiredString(body.bootstrapSecret, 'bootstrapSecret', 1_024) }),
          address: proxyPolicy.clientAddress(req),
        });
        if (typeof setupHooks.ownerCreated === 'function') {
          await setupHooks.ownerCreated({
            name,
            adminToken: result.adminToken,
            expiresAt: result.expiresAt,
          });
        }
        setup.begin({
          ownerName: name,
          serverName: optionalString(body.serverName, 'serverName', 80) || `${name}’s LoomTV`,
        });
        // The owner should land on a library, not on an empty profile chooser.
        let defaultProfile = null;
        try {
          defaultProfile = await clientState.createProfile({ name }, result.user?.id);
        } catch (error) {
          if (error?.code !== 'profile_exists') {
            await service.appendOperationalLog?.('warn', 'The default owner profile could not be created during setup.');
          }
        }
        remotePolicy.audit('auth.owner.create', 'created', req.__loomRemoteContext, result.user || null);
        const data = {
          user: result.user,
          expiresAt: result.expiresAt,
          sessionMode,
          setup: await setup.status(),
          ...(defaultProfile ? { profile: defaultProfile } : {}),
        };
        if (sessionMode === 'cookie') {
          const csrfToken = randomBytes(32).toString('base64url');
          writeData(res, 201, { ...data, csrfToken }, cookieSessionHeaders(result.adminToken, csrfToken, result.expiresAt));
        } else writeData(res, 201, { ...data, adminToken: result.adminToken });
        return true;
      }
      if (resource === 'setup' && segments[1] === 'libraries' && segments.length === 2 && req.method === 'GET') {
        requireSetupService();
        const principal = await requirePrincipal(req, 'library.manage');
        writeData(res, 200, { roots: await service.listLibraryRoots(principal) });
        return true;
      }
      if (resource === 'setup' && segments[1] === 'libraries' && segments.length === 2 && req.method === 'POST') {
        requireSetupService();
        const principal = await requirePrincipal(req, 'library.manage');
        const body = await readJsonBody(req);
        const requested = requiredString(body.path, 'path', 4_096);
        const kind = ['movies', 'tvShows', 'anime', 'others'].includes(body.kind) ? body.kind : 'others';
        const inspection = await inspectSetupFolder(path.resolve(requested));
        if (!inspection.accessible && body.allowUnavailable !== true) {
          writeJson(res, 409, { ok: false, error: { code: 'folder_unavailable', message: inspection.message, ...inspection } });
          return true;
        }
        const root = await service.addLibraryRoot({ path: requested, kind }, principal);
        writeData(res, 201, { root, inspection });
        return true;
      }
      if (resource === 'setup' && segments[1] === 'libraries' && segments[2] === 'check' && segments.length === 3 && req.method === 'POST') {
        requireSetupService();
        await requirePrincipal(req, 'library.manage');
        const body = await readJsonBody(req);
        writeData(res, 200, await inspectSetupFolder(path.resolve(requiredString(body.path, 'path', 4_096))));
        return true;
      }
      if (resource === 'setup' && segments[1] === 'libraries' && segments[2] === 'browse' && segments.length === 3 && req.method === 'POST') {
        requireSetupService();
        const principal = await requirePrincipal(req, 'library.manage');
        if (typeof service.listLibraryDirectories !== 'function') {
          throw requestError(501, 'browse_unavailable', 'This server cannot browse its own folders. Enter the server path instead.');
        }
        const body = await readJsonBody(req);
        const requested = optionalString(body.path, 'path', 4_096);
        writeData(res, 200, await service.listLibraryDirectories(requested ? { path: requested } : {}, principal));
        return true;
      }
      if (resource === 'setup' && segments[1] === 'libraries' && segments[2] === 'search' && segments.length === 3 && req.method === 'POST') {
        requireSetupService();
        const principal = await requirePrincipal(req, 'library.manage');
        if (typeof service.searchLibraryDirectories !== 'function') {
          throw requestError(501, 'search_unavailable', 'This server cannot search its folders. Enter the server path instead.');
        }
        const body = await readJsonBody(req);
        const query = requiredString(body.query, 'query', 120);
        writeData(res, 200, await service.searchLibraryDirectories({ query }, principal));
        return true;
      }
      if (resource === 'setup' && segments[1] === 'libraries' && segments[2] === 'pick' && segments.length === 3 && req.method === 'POST') {
        requireSetupService();
        await requirePrincipal(req, 'library.manage');
        if (!desktopChannel.isTrustedRequest(req) || typeof pickFolder !== 'function') {
          throw requestError(501, 'picker_unavailable', 'A native folder picker is available only in the LoomTV desktop app.');
        }
        const picked = await pickFolder();
        if (!picked) {
          writeData(res, 200, { cancelled: true });
          return true;
        }
        writeData(res, 200, { cancelled: false, path: picked, inspection: await inspectSetupFolder(picked) });
        return true;
      }
      if (resource === 'setup' && segments[1] === 'libraries' && segments.length === 3 && req.method === 'DELETE') {
        requireSetupService();
        const principal = await requirePrincipal(req, 'library.manage');
        await service.removeLibraryRoot(decodeSegment(segments[2], 'rootId'), principal);
        res.writeHead(204, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
        res.end();
        return true;
      }
      if (resource === 'setup' && segments[1] === 'metadata' && segments.length === 2 && req.method === 'GET') {
        const setup = requireSetupService();
        await requirePrincipal(req, 'library.manage');
        writeData(res, 200, setup.metadataSettings());
        return true;
      }
      if (resource === 'setup' && segments[1] === 'metadata' && segments.length === 2 && req.method === 'PUT') {
        const setup = requireSetupService();
        await requirePrincipal(req, 'library.manage');
        const body = await readJsonBody(req);
        const skipped = body.skip === true;
        const supportedProviders = ['tmdb', 'fanart', 'omdb', 'opensubtitles', 'tvdb'];
        const suppliedKeys = body.keys && typeof body.keys === 'object' && !Array.isArray(body.keys) ? body.keys : {};
        const keys = skipped ? {} : Object.fromEntries(supportedProviders.flatMap((provider) => {
          const value = provider === 'tmdb' && suppliedKeys[provider] === undefined ? body.apiKey : suppliedKeys[provider];
          const key = optionalString(value, `${provider}ApiKey`, 512);
          return key ? [[provider, key]] : [];
        }));
        if (body.verify !== false) {
          for (const [provider, apiKey] of Object.entries(keys)) {
            const verdict = await testSetupMetadata(provider, apiKey);
            if (!verdict.ok) {
              const error = requestError(400, verdict.code, verdict.message);
              error.provider = provider;
              throw error;
            }
          }
        }
        if (typeof setupHooks.saveMetadata === 'function') {
          await setupHooks.saveMetadata({
            keys,
            skipped,
          });
        }
        setup.saveMetadata({
          provider: optionalString(body.provider, 'provider', 32) || 'tmdb',
          keys,
          skipped,
        });
        writeData(res, 200, { ...setup.metadataSettings(), setup: await setup.status() });
        return true;
      }
      if (resource === 'setup' && segments[1] === 'metadata' && segments[2] === 'test' && segments.length === 3 && req.method === 'POST') {
        requireSetupService();
        await requirePrincipal(req, 'library.manage');
        const body = await readJsonBody(req);
        const provider = optionalString(body.provider, 'provider', 32) || 'tmdb';
        if (!['tmdb', 'fanart', 'omdb', 'opensubtitles', 'tvdb'].includes(provider)) throw requestError(400, 'invalid_request', 'Unknown metadata provider.');
        const verdict = await testSetupMetadata(provider, requiredString(body.apiKey, 'apiKey', 512));
        if (!verdict.ok) throw requestError(400, verdict.code, verdict.message);
        writeData(res, 200, verdict);
        return true;
      }
      if (resource === 'setup' && segments[1] === 'step' && segments.length === 2 && req.method === 'POST') {
        const setup = requireSetupService();
        await requirePrincipal(req, 'library.manage');
        const body = await readJsonBody(req);
        setup.setStep(requiredString(body.step, 'step', 32));
        writeData(res, 200, await setup.status());
        return true;
      }
      if (resource === 'setup' && segments[1] === 'complete' && segments.length === 2 && req.method === 'POST') {
        const setup = requireSetupService();
        const principal = await requirePrincipal(req, 'library.manage');
        const body = await readJsonBody(req).catch(() => ({}));
        const roots = await service.listLibraryRoots(principal);
        let scan = null;
        if (roots.some((root) => root.state === 'online')) {
          scan = await service.startLibraryScan({ mode: 'quick' }, principal).catch(() => null);
        }
        const record = setup.read();
        const desktopCompletion = typeof setupHooks.complete === 'function'
          ? Promise.resolve(setupHooks.complete({
            roots,
            ownerName: record.ownerName,
            serverName: record.serverName,
            language: record.language,
          }))
          : Promise.resolve();
        const [completedScan] = await Promise.all([
          waitForSetupScan(scan, principal, res),
          desktopCompletion,
        ]);
        setup.complete({ scanStarted: Boolean(scan) });
        writeData(res, 200, {
          setup: await setup.status(),
          scan: completedScan,
          redirect: body?.returnTo === 'admin' ? '/admin' : '/app/',
        });
        return true;
      }
      if (resource === 'auth' && segments[1] === 'onboarding' && req.method === 'GET') {
        writeData(res, 200, { ownerConfigured: await service.isOwnerConfigured(), apiVersion: PUBLIC_API_VERSION });
        return true;
      }
      if (resource === 'auth' && segments[1] === 'owner' && req.method === 'POST') {
        if (await service.isOwnerConfigured()) throw requestError(409, 'owner_exists', 'The LoomTV owner has already been created.');
        const body = await readJsonBody(req);
        const sessionMode = body.sessionMode === undefined ? 'bearer' : body.sessionMode;
        if (!['bearer','cookie'].includes(sessionMode)) throw requestError(400, 'invalid_request', 'sessionMode must be bearer or cookie.');
        if (sessionMode === 'cookie' && (!isSecureRequest(req) || !sameOriginRequest(req))) {
          throw requestError(426, 'secure_transport_required', 'Browser cookie sessions require same-origin HTTPS.');
        }
        const result = await service.createOwner({
          name: requiredString(body.name, 'name', 80),
          password: requiredString(body.password, 'password', 256),
          ...(requireBootstrapSecret ? { bootstrapSecret: optionalString(body.bootstrapSecret, 'bootstrapSecret', 1_024) } : { trustedChannel: true }),
          address: proxyPolicy.clientAddress(req),
        });
        remotePolicy.audit('auth.owner.create', 'created', req.__loomRemoteContext, result.user || null);
        if (sessionMode === 'cookie') {
          const csrfToken = randomBytes(32).toString('base64url');
          const { adminToken, ...safeResult } = result;
          writeData(res, 201, { ...safeResult, sessionMode, csrfToken }, cookieSessionHeaders(adminToken, csrfToken, result.expiresAt));
        } else writeData(res, 201, { ...result, sessionMode });
        return true;
      }
      if (resource === 'auth' && segments[1] === 'session' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const sessionMode = body.sessionMode === undefined ? 'bearer' : body.sessionMode;
        if (!['bearer','cookie'].includes(sessionMode)) throw requestError(400, 'invalid_request', 'sessionMode must be bearer or cookie.');
        if (sessionMode === 'cookie' && (!isSecureRequest(req) || !sameOriginRequest(req))) {
          throw requestError(426, 'secure_transport_required', 'Browser cookie sessions require same-origin HTTPS.');
        }
        const result = await service.createSession({
          username: optionalString(body.username, 'username', 80),
          password: requiredString(body.password, 'password', 256),
          address: proxyPolicy.clientAddress(req),
          deviceId: optionalString(req.headers['x-loom-device-id'], 'deviceId', 128),
        });
        remotePolicy.audit('auth.session.create', 'created', req.__loomRemoteContext, result.user || null);
        if (sessionMode === 'cookie') {
          const csrfToken = randomBytes(32).toString('base64url');
          const { adminToken, ...safeResult } = result;
          writeData(res, 200, { ...safeResult, sessionMode, csrfToken }, cookieSessionHeaders(adminToken, csrfToken, result.expiresAt));
        } else writeData(res, 200, { ...result, sessionMode });
        return true;
      }
      if (resource === 'auth' && segments[1] === 'session' && req.method === 'DELETE') {
        const principal = await requirePrincipal(req);
        if (principal.authentication === 'device-credential') {
          await pairingService.revokeSelf(principal.deviceId, principal, 'device_signed_out');
          await service.revokeDeviceSessions?.(principal.deviceId, 'device_signed_out');
          await clientState.revokeDeviceAccess?.(principal.deviceId);
          await mediaService.revokeDevice?.(principal.deviceId, 'device_signed_out');
        } else if (principal.authentication === 'account-session' || principal.authentication === 'device-session') {
          const revokeRequest = req.__loomCookieSessionToken
            ? { ...req, headers: { ...req.headers, authorization: `Bearer ${req.__loomCookieSessionToken}` } }
            : req;
          await service.revokeRequest(revokeRequest);
          if (principal.sessionId) {
            await mediaService.revokeAuthenticationSession?.(principal.sessionId, 'auth_session_revoked');
          }
        } else {
          throw requestError(400, 'invalid_request', 'The authenticated credential cannot be revoked through this route.');
        }
        remotePolicy.audit('auth.session.revoke', 'revoked', req.__loomRemoteContext, principal);
        res.writeHead(204, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION,
          ...(req.__loomCookieSessionToken ? clearCookieSessionHeaders() : {}) });
        res.end();
        return true;
      }
      if (resource === 'auth' && segments[1] === 'me' && req.method === 'GET') {
        const principal = await requirePrincipal(req);
        writeData(res, 200, { user: await service.getCurrentUser(principal) });
        return true;
      }
      if (resource === 'devices' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'devices.manage');
        writeData(res, 200, { devices: await pairingService.list(principal) });
        return true;
      }
      if (resource === 'devices' && segments.length === 2 && req.method === 'DELETE') {
        const principal = await requirePrincipal(req, 'devices.manage');
        const deviceId = decodeSegment(segments[1], 'deviceId');
        const revoked = await pairingService.revoke(deviceId, principal);
        await service.revokeDeviceSessions?.(deviceId, 'device_revoked');
        await clientState.revokeDeviceAccess?.(deviceId);
        await mediaService.revokeDevice?.(deviceId, 'device_revoked');
        remotePolicy.audit('device.revoke', 'revoked', req.__loomRemoteContext, principal, { deviceId });
        writeData(res, 200, revoked);
        return true;
      }
      if (resource === 'library' && segments[1] === 'catalog' && segments.length === 2 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'library.read');
        // Reauthorize before evaluating conditional requests, including after
        // profile switches or device revocation.
        const catalog = publicCatalog(await profileVisibleItems(principal, req), publicLibraryItem);
        const mediaId = url.searchParams.get('mediaId');
        const headers = { ETag: catalog.etag, 'Cache-Control': 'private, no-cache', Vary: 'Authorization, Cookie' };
        if (mediaId) {
          const item = catalog.items.find((entry) => entry.id === mediaId);
          if (!item) throw requestError(404, 'media_not_found', 'Media item was not found.');
          writeData(res, 200, { revision: catalog.revision, items: [item, ...catalog.items.filter((entry) => entry.seriesId === mediaId)] }, headers);
        } else if (req.headers['if-none-match']?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === catalog.etag)) {
          res.writeHead(304, { ...headers, [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
          res.end();
        } else {
          writeData(res, 200, { revision: catalog.revision, items: catalog.items }, headers);
        }
        return true;
      }
      if (resource === 'library' && segments.length === 1 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'library.read');
        writeData(res, 200, { items: (await profileVisibleItems(principal, req)).map(publicLibraryItem) });
        return true;
      }
      if (resource === 'library' && segments[1] === 'series' && segments.length === 2 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'library.read');
        const items = await profileVisibleItems(principal, req);
        const canonicalSeries = new Map(items.filter((item) => item.kind === 'series').map((item) => [item.id, item]));
        const seriesByKey = new Map();
        for (const item of items) {
          if (item.kind !== 'episode' || !item.series?.title) continue;
          const key = item.seriesId || `legacy-title:${item.series.title.toLowerCase()}`;
          const seriesItem = item.seriesId ? canonicalSeries.get(item.seriesId) : null;
          const entry = seriesByKey.get(key) || {
            ...(seriesItem ? publicLibraryItem(seriesItem) : {}),
            id: seriesItem?.id || null,
            title: seriesItem?.title || item.series.title,
            animeLikely: seriesItem?.animeLikely === true,
            seasons: new Map(),
          };
          if (item.animeLikely) entry.animeLikely = true;
          const seasonNumber = item.series.season ?? 1;
          const season = entry.seasons.get(seasonNumber) || { season: seasonNumber, episodes: [] };
          season.episodes.push({
            ...publicLibraryItem(item),
            seasonNumber,
            ...(Number.isFinite(item.series.episode) ? { episodeNumber: Number(item.series.episode) } : {}),
          });
          entry.seasons.set(seasonNumber, season);
          seriesByKey.set(key, entry);
        }
        const series = [...seriesByKey.values()]
          .map((entry) => ({
            ...(entry.id ? { id: entry.id } : {}),
            title: entry.title,
            animeLikely: entry.animeLikely,
            episodeCount: [...entry.seasons.values()].reduce((total, season) => total + season.episodes.length, 0),
            seasons: [...entry.seasons.values()]
              .sort((left, right) => left.season - right.season)
              .map((season) => ({
                ...season,
                episodes: season.episodes.sort((left, right) => (left.episodeNumber ?? 0) - (right.episodeNumber ?? 0)),
              })),
          }))
          .sort((left, right) => left.title.localeCompare(right.title));
        writeData(res, 200, { series });
        return true;
      }
      if (resource === 'library' && segments[1] === 'roots' && segments.length === 2 && (req.method === 'GET' || req.method === 'POST')) {
        const principal = await requirePrincipal(req, req.method === 'GET' ? 'library.read' : 'library.manage');
        if (req.method === 'GET') writeData(res, 200, { roots: (await service.listLibraryRoots(principal)).map(publicLibraryRoot) });
        else {
          const body = await readJsonBody(req);
          const kind = optionalString(body.kind, 'kind', 16) || 'others';
          if (!['movies','tv','anime','others'].includes(kind)) throw requestError(400, 'invalid_request', 'Library root kind is invalid.');
          writeData(res, 201, { root: publicLibraryRoot(await service.addLibraryRoot({
            path: requiredString(body.path, 'path', 4_096), kind: kind === 'tv' ? 'tvShows' : kind,
          }, principal)) });
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
        try { await playbackProfileContext(principal, req, item); } catch (error) {
          if (error?.code === 'permission_denied') throw requestError(404, 'media_not_found', 'Media item was not found.');
          throw error;
        }
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
      if (resource === 'profiles' && segments[1] === 'selection' && segments.length === 2
        && ['GET','PATCH','DELETE'].includes(req.method)) {
        const principal = await requirePrincipal(req);
        const deviceId = deviceIdForRequest(req, principal);
        let selection;
        if (req.method === 'GET') selection = await clientState.getActiveProfileState(principal.id, deviceId);
        else if (req.method === 'DELETE') selection = await clientState.clearActiveProfile(principal.id, deviceId);
        else {
          const body = await readJsonBody(req);
          if (typeof body.automaticSignIn !== 'boolean') throw requestError(400, 'invalid_request', 'automaticSignIn must be boolean.');
          selection = await clientState.setAutomaticSignIn(principal.id, deviceId, body.automaticSignIn);
        }
        writeData(res, 200, { selection });
        return true;
      }
      if (resource === 'profiles' && segments[1] === 'selection' && segments[2] === 'lock'
        && segments.length === 3 && req.method === 'POST') {
        const principal = await requirePrincipal(req);
        writeData(res, 200, { selection: await clientState.lockActiveProfile(principal.id, deviceIdForRequest(req, principal)) });
        return true;
      }
      if (resource === 'profiles' && segments.length === 2 && ['PATCH','DELETE'].includes(req.method)) {
        const principal = await requirePrincipal(req);
        const profileId = decodeSegment(segments[1], 'profileId');
        if (req.method === 'DELETE') {
          await clientState.removeProfile(profileId, principal.id, canSeeAllProfiles(principal));
          res.writeHead(204, { 'Cache-Control': 'no-store', [PUBLIC_API_HEADER]: PUBLIC_API_VERSION });
          res.end();
        } else {
          const body = await readJsonBody(req);
          writeData(res, 200, { profile: await clientState.updateProfile(profileId, body, principal.id, canSeeAllProfiles(principal)) });
        }
        return true;
      }
      if (resource === 'profiles' && segments.length === 3 && segments[2] === 'select' && req.method === 'POST') {
        const principal = await requirePrincipal(req);
        const body = await readJsonBody(req);
        writeData(res, 200, { profile: await clientState.selectProfile(
          decodeSegment(segments[1], 'profileId'), principal.id, canSeeAllProfiles(principal), deviceIdForRequest(req, principal),
          body.pin, proxyPolicy.clientAddress(req),
        ) });
        return true;
      }
      if (resource === 'profiles' && segments.length === 3 && segments[2] === 'pin' && req.method === 'PUT') {
        const principal = await requirePrincipal(req);
        const body = await readJsonBody(req);
        const pin = body.pin === null ? null : requiredString(body.pin, 'pin', 4);
        writeData(res, 200, { profile: await clientState.updateProfilePin(
          decodeSegment(segments[1], 'profileId'), pin, principal.id, canSeeAllProfiles(principal),
        ) });
        return true;
      }
      if (resource === 'profiles' && segments.length === 3 && segments[2] === 'preferences'
        && ['GET','PATCH'].includes(req.method)) {
        const principal = await requirePrincipal(req);
        const profileId = decodeSegment(segments[1], 'profileId');
        await requireSelectedProfile(principal, req, profileId);
        const preferences = req.method === 'GET'
          ? await clientState.getProfilePreferences(profileId, principal.id, false)
          : await clientState.saveProfilePreferences(profileId, await readJsonBody(req), principal.id, false);
        writeData(res, 200, { preferences });
        return true;
      }
      if (resource === 'profiles' && segments[2] === 'lists' && (segments.length === 3 || segments.length === 5)) {
        const principal = await requirePrincipal(req);
        const profileId = decodeSegment(segments[1], 'profileId');
        await requireSelectedProfile(principal, req, profileId);
        if (segments.length === 3 && req.method === 'GET') {
          const kind = url.searchParams.get('kind') || undefined;
          const entries = await clientState.getProfileLists(profileId, kind, principal.id, false);
          const visibleIds = new Set((await profileVisibleItems(principal, req)).map((item) => item.id));
          writeData(res, 200, { entries: entries.filter((entry) => visibleIds.has(entry.mediaId)) });
          return true;
        }
        if (segments.length === 5 && ['PUT','DELETE'].includes(req.method)) {
          const kind = decodeSegment(segments[3], 'kind');
          const mediaId = decodeSegment(segments[4], 'mediaId');
          if (req.method === 'PUT') {
            const media = await service.getLibraryItem(mediaId, principal);
            if (!media) throw requestError(404, 'media_not_found', 'Media item was not found.');
            await requireSelectedProfile(principal, req, profileId, media);
          }
          const entries = await clientState.setProfileListEntry(profileId, mediaId, kind, req.method === 'PUT', principal.id, false);
          writeData(res, 200, { entries });
          return true;
        }
      }
      if (resource === 'profiles' && segments.length === 4 && segments[2] === 'track-preferences'
        && ['GET','PUT'].includes(req.method)) {
        const principal = await requirePrincipal(req);
        const profileId = decodeSegment(segments[1], 'profileId');
        const scope = decodeSegment(segments[3], 'scope');
        await requireSelectedProfile(principal, req, profileId);
        const preferences = req.method === 'GET'
          ? await clientState.getTrackPreferences(profileId, scope, principal.id, false)
          : await clientState.saveTrackPreferences(profileId, scope, await readJsonBody(req), principal.id, false);
        writeData(res, 200, { preferences });
        return true;
      }
      if (resource === 'profiles' && segments.length >= 3 && segments[2] === 'progress') {
        const principal = await requirePrincipal(req);
        const profileId = decodeSegment(segments[1], 'profileId');
        await requireSelectedProfile(principal, req, profileId);
        if (segments.length === 3 && req.method === 'GET') {
          const progress = await clientState.listProgress(profileId, principal.id, false);
          const visibleIds = new Set((await profileVisibleItems(principal, req)).map((item) => item.id));
          writeData(res, 200, { progress: Object.fromEntries(Object.entries(progress).filter(([mediaId]) => visibleIds.has(mediaId))) });
          return true;
        }
        if (segments.length === 4 && (req.method === 'GET' || req.method === 'PUT' || req.method === 'POST')) {
          const mediaId = decodeSegment(segments[3], 'mediaId');
          const media = await service.getLibraryItem(mediaId, principal);
          if (!media) throw requestError(404, 'media_not_found', 'Media item was not found.');
          await requireSelectedProfile(principal, req, profileId, media);
          if (req.method === 'GET') writeData(res, 200, { progress: await clientState.getProgress(profileId, mediaId, principal.id, false) });
          else writeData(res, 200, { progress: await clientState.saveProgress(profileId, mediaId, await readJsonBody(req), principal.id, false) });
          return true;
        }
      }
      if (resource === 'media' && segments.length === 2 && req.method === 'GET') {
        const principal = await requirePrincipal(req, 'library.read');
        const mediaId = decodeSegment(segments[1], 'mediaId');
        const item = await service.getLibraryItem(mediaId, principal);
        if (!item) throw requestError(404, 'media_not_found', 'Media item was not found.');
        const deviceId = deviceIdForRequest(req, principal);
        const profileContext = await playbackProfileContext(principal, req, item);
        writeData(res, 200, {
          item: publicLibraryItem(item),
          playbackPlanUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/playback-plan`,
          directUrl: null,
          directRenewUrl: null,
          downloadUrl: null,
          downloadCreateUrl: `${PUBLIC_API_PREFIX}/downloads`,
          transcodeUrl: null,
        });
        return true;
      }
      if (resource === 'media' && segments.length === 3 && segments[2] === 'playback-plan' && req.method === 'POST') {
        const principal = await requirePrincipal(req, 'stream');
        const mediaId = decodeSegment(segments[1], 'mediaId');
        const body = await readJsonBody(req);
        const capabilities = normalizeClientPlaybackCapabilities(body.capabilities || body);
        const catalogItem = await service.getLibraryItem(mediaId, principal);
        if (!catalogItem) throw requestError(404, 'media_not_found', 'Media item was not found.');
        const profileContext = await playbackProfileContext(principal, req, catalogItem);
        const { item, probe, plan, sourceIdentity, externalSubtitle } = await mediaService.planPlayback(mediaId, {
          sourceId: optionalString(body.sourceId, 'sourceId', 256),
          capabilities,
          videoTrackId: optionalString(body.videoTrackId, 'videoTrackId', 128),
          audioTrackId: body.audioTrackId === null ? null : optionalString(body.audioTrackId, 'audioTrackId', 128),
          subtitleTrackId: body.subtitleTrackId === null ? null : optionalString(body.subtitleTrackId, 'subtitleTrackId', 128),
          startSeconds: Number.isFinite(body.startSeconds) ? Math.max(0, Number(body.startSeconds)) : 0,
        }, principal, profileContext);
        const tokenQuery = (token) => token ? `?token=${encodeURIComponent(token)}` : '';
        const boundProfileContext = bindAuthenticationSession({
          ...profileContext, sourceId: plan.sourceId, fileId: sourceIdentity.fileId,
          ...(externalSubtitle ? {
            externalSubtitleTrackId: externalSubtitle.trackId,
            externalSubtitleFileId: externalSubtitle.fileId,
          } : {}),
        }, principal);
        const directLease = plan.sourceAction === 'direct' && typeof mediaService.issuePlaybackToken === 'function'
          ? mediaService.issuePlaybackToken(mediaId, principal.id, 'direct', boundProfileContext)
          : null;
        const directToken = directLease?.token || null;
        const transcodePlan = plan.sourceAction === 'transcode'
          ? mediaService.issueTranscodePlan(mediaId, principal.id, plan, probe, {
            startSeconds: body.startSeconds,
            externalSubtitle,
          }, boundProfileContext, sourceIdentity)
          : null;
        const profileQuery = new URLSearchParams({
          ...(transcodePlan ? { planToken: transcodePlan.token } : {}),
          sourceId: plan.sourceId,
        });
        writeData(res, 200, {
          mediaCoreContractVersion: MEDIA_CORE_CONTRACT_VERSION,
          capabilities,
          plan: publicPlaybackPlan(plan),
          probe: publicMediaProbe(probe),
          item: publicLibraryItem(item),
          directUrl: plan.sourceAction === 'direct'
            ? `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/direct${tokenQuery(directToken)}`
            : null,
          ...(directLease ? {
            directRenewUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/direct/renew`,
            directExpiresAt: directLease.expiresAt,
            ...(directLease.sessionId ? { directSessionId: directLease.sessionId } : {}),
          } : {}),
          transcodeUrl: plan.sourceAction === 'transcode'
            ? `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/transcode?${profileQuery.toString()}`
            : null,
          subtitleUrl: externalSubtitle && plan.sourceAction === 'direct'
            ? `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/subtitles/${encodeURIComponent(externalSubtitle.trackId)}${tokenQuery(directToken)}`
            : null,
        });
        return true;
      }
      if (resource === 'media' && segments.length === 4 && segments[2] === 'subtitles'
        && (req.method === 'GET' || req.method === 'HEAD')) {
        const mediaId = decodeSegment(segments[1], 'mediaId');
        const trackId = decodeSegment(segments[3], 'trackId');
        const token = url.searchParams.get('token');
        if (!token) throw requestError(401, 'playback_session_invalid', 'A server-issued subtitle capability is required.');
        res.__loomtvPublicApi = true;
        return mediaService.serveExternalSubtitleCapability(req, res, { itemId: mediaId, trackId, token });
      }
      if (resource === 'media' && segments.length === 4
        && ((segments[2] === 'direct' && segments[3] === 'renew')
          || (segments[2] === 'transcode' && segments[3] === 'renew')
          || (segments[2] === 'playback-session' && segments[3] === 'renew'))
        && req.method === 'POST') {
        const mediaId = decodeSegment(segments[1], 'mediaId');
        let action = segments[2] === 'direct' ? 'direct' : 'hls';
        const body = await readJsonBody(req);
        if (segments[2] === 'playback-session') {
          action = body.action === 'direct' ? 'direct' : 'hls';
        }
        const permission = 'stream';
        const hasAuthenticatedBearer = Boolean(req.headers.authorization || req.headers['x-loom-admin-token']);
        const sessionIdentifier = url.searchParams.get('sessionId') || body.sessionId;
        let capabilityToken = url.searchParams.get('token') || body.token;
        let principal = null;
        if (hasAuthenticatedBearer) {
          try {
            principal = await requirePrincipal(req, permission);
          } catch (error) {
            if (!capabilityToken) capabilityToken = req.headers.authorization?.startsWith('Bearer ')
              ? req.headers.authorization.slice(7).trim()
              : req.headers['x-loom-admin-token'];
            if (!capabilityToken) throw error;
          }
        }
        if (!principal && !capabilityToken && sessionIdentifier) principal = await requirePrincipal(req, permission);
        const identifier = principal && sessionIdentifier
          ? sessionIdentifier
          : capabilityToken || sessionIdentifier;
        if (!identifier) throw requestError(400, 'playback_session_required', 'A playback session token or id is required.');
        const renewed = await mediaService.renewPlaybackSession?.(identifier, principal, mediaId, action, req);
        if (!renewed) throw requestError(401, 'playback_session_invalid', 'The playback session is expired, revoked, or not bound to this media item.');
        const tokenQuery = `?token=${encodeURIComponent(renewed.token)}`;
        writeData(res, 200, {
          sessionId: renewed.id,
          token: renewed.token,
          action,
          expiresAt: renewed.expiresAt,
          idleExpiresAt: renewed.idleExpiresAt,
          absoluteExpiresAt: renewed.absoluteExpiresAt,
          ...(action === 'hls'
            ? { playlistUrl: `/api/media/transcode/${encodeURIComponent(renewed.id)}/index.m3u8${tokenQuery}` }
            : {
              directUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/direct${tokenQuery}`,
              ...(renewed.profile?.externalSubtitleTrackId ? {
                subtitleUrl: `${PUBLIC_API_PREFIX}/media/${encodeURIComponent(mediaId)}/subtitles/${encodeURIComponent(renewed.profile.externalSubtitleTrackId)}${tokenQuery}`,
              } : {}),
            }),
        });
        return true;
      }
      if (resource === 'media' && segments.length === 3 && segments[2] === 'playback-session' && req.method === 'DELETE') {
        const mediaId = decodeSegment(segments[1], 'mediaId');
        const body = await readJsonBody(req);
        const hasAuthenticatedBearer = Boolean(req.headers.authorization || req.headers['x-loom-admin-token']);
        const sessionIdentifier = url.searchParams.get('sessionId') || body.sessionId;
        let capabilityToken = url.searchParams.get('token') || body.token;
        let principal = null;
        if (hasAuthenticatedBearer) {
          try {
            principal = await requirePrincipal(req, 'stream');
          } catch (error) {
            if (!capabilityToken) capabilityToken = req.headers.authorization?.startsWith('Bearer ')
              ? req.headers.authorization.slice(7).trim()
              : req.headers['x-loom-admin-token'];
            if (!capabilityToken) throw error;
          }
        }
        if (!principal && !capabilityToken && sessionIdentifier) principal = await requirePrincipal(req, 'stream');
        const identifier = principal && sessionIdentifier
          ? sessionIdentifier
          : capabilityToken || sessionIdentifier;
        if (!identifier) throw requestError(400, 'playback_session_required', 'A playback session token or id is required.');
        const stopped = await mediaService.stopPlaybackSession?.(identifier, principal, mediaId);
        if (!stopped) throw requestError(401, 'playback_session_invalid', 'The playback session is expired, revoked, or not owned by this account.');
        writeData(res, 200, stopped);
        return true;
      }
      if (resource === 'media' && segments.length === 3 && (segments[2] === 'direct' || segments[2] === 'download' || segments[2] === 'transcode')) {
        const mediaId = decodeSegment(segments[1], 'mediaId');
        if (segments[2] === 'download') {
          throw requestError(410, 'download_not_allowed', 'Create an offline download lease through POST /api/v1/downloads.');
        }
        if (segments[2] === 'transcode') await requirePrincipal(req, 'transcode');
        else if (!url.searchParams.get('token')) throw requestError(401, 'playback_session_invalid', 'A server-issued media capability is required.');
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
      if (res.destroyed) return true;
      const { status, code } = canonicalPublicError(error);
      if (resource === 'auth' || resource === 'pairing' || resource === 'devices') {
        remotePolicy.audit(`api.${resource}`, 'failed', req.__loomRemoteContext, null, { code, status });
      }
      const message = error?.code === 'setup_scan_timeout'
        ? 'The library is still scanning. Check scan status and retry setup completion.'
        : status >= 500 ? 'The hosted API request could not be completed.' : error?.message || 'The request was rejected.';
      const retryAfterSeconds = Number.isFinite(error?.retryAfter)
        ? Math.max(1, Math.ceil(error.retryAfter))
        : undefined;
      writeError(
        res,
        status,
        code,
        message,
        {
          ...(error?.retryable !== undefined ? { retryable: error.retryable === true } : {}),
          ...(error?.provider ? { provider: error.provider } : {}),
          ...(retryAfterSeconds ? { retryAfterMs: retryAfterSeconds * 1_000 } : {}),
        },
        retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {},
      );
      return true;
    }
  };
}

export { OPENAPI_DOCUMENT };
