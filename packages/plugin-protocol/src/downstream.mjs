/**
 * Host-mediated downstream plugin contracts.
 *
 * These declarations intentionally carry opaque references only. They do not
 * fetch, resolve, sign, proxy, install, or execute anything. A host may use
 * them to agree on the shape of a future implementation without exposing a
 * provider URL, local path, command, or executable to a renderer or client.
 */

export const PLUGIN_DOWNSTREAM_PROTOCOL_VERSION = 1;
export const PLUGIN_HOST_TRANSPORT = 'host-mediated';
export const PLUGIN_PROXY_TRANSPORT = 'host-mediated-proxy';
export const PLUGIN_NAMESPACE_PREFIX = 'loom-plugin';

export const PLUGIN_HOST_RUNTIME_KINDS = Object.freeze(['desktop', 'headless']);
export const PLUGIN_HOST_SURFACE_IDS = Object.freeze([
  'catalog.read',
  'catalog.search',
  'metadata.read',
  'subtitle.attachment',
  'playback.ticket',
  'catalog.signature',
  'update.signature',
  'executable.sandbox',
]);
export const PLUGIN_HOST_SURFACE_STATES = Object.freeze(['available', 'scaffolded', 'blocked']);
export const PLUGIN_PLAYBACK_SOURCE_KINDS = Object.freeze(['https-media', 'hls']);
export const PLUGIN_PLAYBACK_MODES = Object.freeze(['direct-proxy', 'hls-proxy']);
export const PLUGIN_SIGNING_ALGORITHMS = Object.freeze(['ed25519']);
export const PLUGIN_UPDATE_CHANNELS = Object.freeze(['stable', 'beta', 'canary']);

export const PLUGIN_TICKET_MAX_LIFETIME_MS = 15 * 60 * 1_000;
export const PLUGIN_CATALOG_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const PLUGIN_UPDATE_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

const pluginIdPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const signaturePattern = /^[A-Za-z0-9_-]{16,4096}$/;
const semVerPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const forbiddenTransportFields = new Set([
  'url',
  'href',
  'uri',
  'path',
  'filePath',
  'downloadUrl',
  'command',
  'executable',
  'argv',
  'entrypoint',
  'script',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function issue(path, code, message) {
  return { path, code, message };
}

function fail(code, message, path = '$') {
  throw new PluginDownstreamContractError([issue(path, code, message)]);
}

function addUnknownFields(value, allowed, path, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(issue(`${path}.${key}`, 'unknown_field', 'Unknown fields are not supported.'));
  }
}

function rejectRawTransportFields(value, path = '$', seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectRawTransportFields(entry, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenTransportFields.has(key)) {
      fail('RAW_TRANSPORT_FORBIDDEN', `Raw transport field ${key} is not allowed in a downstream plugin contract.`, `${path}.${key}`);
    }
    rejectRawTransportFields(child, `${path}.${key}`, seen);
  }
}

function requireRecord(value, allowed, kind) {
  if (!isRecord(value)) fail('INVALID_TYPE', `${kind} must be an object.`);
  rejectRawTransportFields(value);
  const issues = [];
  addUnknownFields(value, allowed, '$', issues);
  if (issues.length > 0) throw new PluginDownstreamContractError(issues);
  return value;
}

function text(value, path, { required = true, maxLength = 256 } = {}) {
  if (value === undefined) {
    if (required) fail('MISSING', 'A value is required.', path);
    return undefined;
  }
  if (typeof value !== 'string') fail('INVALID_TYPE', 'Expected a string.', path);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || controlCharacterPattern.test(normalized)) {
    fail('INVALID_VALUE', `Expected a non-empty string of at most ${maxLength} characters.`, path);
  }
  return normalized;
}

function opaqueReference(value, path) {
  const normalized = text(value, path);
  if (!referencePattern.test(normalized)) {
    fail('INVALID_REFERENCE', 'Expected an opaque reference token; URL and path separators are not allowed.', path);
  }
  return normalized;
}

function pluginId(value, path) {
  const normalized = text(value, path, { maxLength: 128 });
  if (!pluginIdPattern.test(normalized)) fail('INVALID_PLUGIN_ID', 'Expected a lowercase reverse-DNS plugin ID.', path);
  return normalized;
}

function integer(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `Expected an integer between ${min} and ${max}.`, path);
  }
  return value;
}

function timeWindow(issuedAt, expiresAt, path, maxLifetime) {
  const issued = integer(issuedAt, `${path}.issuedAt`);
  const expires = integer(expiresAt, `${path}.expiresAt`);
  if (expires <= issued) fail('INVALID_WINDOW', 'expiresAt must be later than issuedAt.', `${path}.expiresAt`);
  if (expires - issued > maxLifetime) {
    fail('INVALID_WINDOW', `The validity window must not exceed ${maxLifetime} milliseconds.`, path);
  }
  return { issuedAt: issued, expiresAt: expires };
}

function profileBinding(value, path = '$.profile') {
  if (!isRecord(value)) fail('INVALID_PROFILE_BINDING', 'A profile binding must be an object.', path);
  rejectRawTransportFields(value, path);
  const issues = [];
  addUnknownFields(value, new Set(['deviceRef', 'profileId', 'selectionRevision']), path, issues);
  if (issues.length > 0) throw new PluginDownstreamContractError(issues);
  return {
    deviceRef: opaqueReference(value.deviceRef, `${path}.deviceRef`),
    profileId: opaqueReference(value.profileId, `${path}.profileId`),
    selectionRevision: integer(value.selectionRevision, `${path}.selectionRevision`),
  };
}

function optionalText(value, path, maxLength = 256) {
  return value === undefined ? undefined : text(value, path, { maxLength });
}

function optionalOpaqueReference(value, path) {
  return value === undefined ? undefined : opaqueReference(value, path);
}

function namespaceText(value, path, maxLength = 128) {
  return text(value, path, { maxLength });
}

function namespaceKey(plugin, catalogType, catalogId) {
  return [PLUGIN_NAMESPACE_PREFIX, plugin, 'catalog', catalogType, catalogId]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

function itemNamespaceKey(plugin, catalogType, catalogId, itemId) {
  return `${namespaceKey(plugin, catalogType, catalogId)}:item:${encodeURIComponent(itemId)}`;
}

function normalizeStringArray(value, path, { maxItems = 32, maxLength = 128 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail('INVALID_ARRAY', `Expected an array with at most ${maxItems} entries.`, path);
  }
  const result = value.map((entry, index) => text(entry, `${path}[${index}]`, { maxLength }));
  if (new Set(result).size !== result.length) fail('DUPLICATE_VALUE', 'Array values must be unique.', path);
  return result;
}

function normalizeModes(value, path) {
  const modes = Array.isArray(value) ? value : [value];
  if (modes.length < 1 || modes.length > PLUGIN_PLAYBACK_MODES.length) {
    fail('INVALID_ARRAY', 'At least one and at most two playback modes are required.', path);
  }
  const normalized = modes.map((entry, index) => {
    if (!PLUGIN_PLAYBACK_MODES.includes(entry)) fail('UNSUPPORTED_MODE', 'The requested playback mode is not host-mediated.', `${path}[${index}]`);
    return entry;
  });
  if (new Set(normalized).size !== normalized.length) fail('DUPLICATE_VALUE', 'Playback modes must be unique.', path);
  return normalized;
}

function normalizeSignature(value, path) {
  const normalized = text(value, path, { maxLength: 4_096 });
  if (!signaturePattern.test(normalized)) fail('INVALID_SIGNATURE', 'Expected a base64url-encoded signature.', path);
  return normalized;
}

function normalizeDigest(value, path) {
  const normalized = text(value, path, { maxLength: 64 });
  if (!sha256Pattern.test(normalized)) fail('INVALID_DIGEST', 'Expected a lowercase SHA-256 digest.', path);
  return normalized;
}

function normalizeSemVer(value, path) {
  const normalized = text(value, path, { maxLength: 64 });
  if (!semVerPattern.test(normalized)) fail('INVALID_VERSION', 'Expected a SemVer release version.', path);
  return normalized;
}

function normalizeAlgorithm(value, path) {
  if (!PLUGIN_SIGNING_ALGORITHMS.includes(value)) fail('UNSUPPORTED_ALGORITHM', 'Only the reviewed Ed25519 signature algorithm is supported.', path);
  return value;
}

function normalizeHostApiRange(value, path) {
  return text(value, path, { maxLength: 128 });
}

function normalizeCatalogItem(value, path, plugin, catalogType, catalogId) {
  requireRecord(value, new Set(['id', 'type', 'title', 'description', 'releaseInfo', 'released', 'rating', 'runtime', 'year', 'genres', 'artworkRef']), 'A signed catalog item');
  const itemId = text(value.id, `${path}.id`, { maxLength: 256 });
  const type = namespaceText(value.type, `${path}.type`, 64);
  const title = text(value.title, `${path}.title`, { maxLength: 512 });
  const rating = value.rating === undefined ? undefined : Number(value.rating);
  if (rating !== undefined && (!Number.isFinite(rating) || rating < 0 || rating > 10)) {
    fail('INVALID_VALUE', 'Catalog ratings must be between 0 and 10.', `${path}.rating`);
  }
  const year = value.year === undefined ? undefined : integer(value.year, `${path}.year`, { min: 0, max: 100_000 });
  return {
    id: itemId,
    itemKey: itemNamespaceKey(plugin, catalogType, catalogId, itemId),
    type,
    title,
    ...(optionalText(value.description, `${path}.description`, 2_000) === undefined ? {} : { description: optionalText(value.description, `${path}.description`, 2_000) }),
    ...(optionalText(value.releaseInfo, `${path}.releaseInfo`, 128) === undefined ? {} : { releaseInfo: optionalText(value.releaseInfo, `${path}.releaseInfo`, 128) }),
    ...(optionalText(value.released, `${path}.released`, 128) === undefined ? {} : { released: optionalText(value.released, `${path}.released`, 128) }),
    ...(rating === undefined ? {} : { rating }),
    ...(optionalText(value.runtime, `${path}.runtime`, 64) === undefined ? {} : { runtime: optionalText(value.runtime, `${path}.runtime`, 64) }),
    ...(year === undefined ? {} : { year }),
    ...(value.genres === undefined ? {} : { genres: normalizeStringArray(value.genres, `${path}.genres`, { maxItems: 32, maxLength: 128 }) }),
    ...(value.artworkRef === undefined ? {} : { artworkRef: opaqueReference(value.artworkRef, `${path}.artworkRef`) }),
  };
}

function normalizeCatalogPayload(value, plugin, path = '$.payload') {
  requireRecord(value, new Set(['namespace', 'catalogType', 'catalogId', 'revision', 'items']), 'A signed catalog payload');
  const catalogType = namespaceText(value.catalogType, `${path}.catalogType`, 64);
  const catalogId = namespaceText(value.catalogId, `${path}.catalogId`, 128);
  const expectedNamespace = namespaceKey(plugin, catalogType, catalogId);
  const namespace = text(value.namespace, `${path}.namespace`, { maxLength: 512 });
  if (namespace !== expectedNamespace) fail('NAMESPACE_MISMATCH', 'The catalog namespace must be derived from the signing plugin and catalog identity.', `${path}.namespace`);
  const revision = integer(value.revision, `${path}.revision`);
  if (!Array.isArray(value.items) || value.items.length > 1_000) fail('INVALID_ARRAY', 'Signed catalogs must contain at most 1,000 items.', `${path}.items`);
  return {
    namespace,
    catalogType,
    catalogId,
    revision,
    items: value.items.map((item, index) => normalizeCatalogItem(item, `${path}.items[${index}]`, plugin, catalogType, catalogId)),
  };
}

/**
 * Canonical JSON for signing and verification implementations. This only
 * canonicalizes data; it does not create or verify a signature.
 */
export function canonicalizeSignedDocument(value) {
  rejectRawTransportFields(value);
  const seen = new Set();
  const normalize = (entry, path) => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) fail('INVALID_JSON_VALUE', 'Signed documents may contain only finite numbers.', path);
      return entry;
    }
    if (typeof entry !== 'object') fail('INVALID_JSON_VALUE', 'Signed documents may contain only JSON values.', path);
    if (seen.has(entry)) fail('INVALID_JSON_VALUE', 'Signed documents must not contain cycles.', path);
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map((child, index) => normalize(child, `${path}[${index}]`));
    const result = {};
    for (const key of Object.keys(entry).sort()) {
      if (entry[key] === undefined) fail('INVALID_JSON_VALUE', 'Signed documents must not contain undefined values.', `${path}.${key}`);
      result[key] = normalize(entry[key], `${path}.${key}`);
    }
    return result;
  };
  return JSON.stringify(normalize(value, '$'));
}

export class PluginDownstreamContractError extends Error {
  constructor(issues) {
    const normalizedIssues = Object.freeze(issues.map((entry) => Object.freeze({ ...entry })));
    const detail = normalizedIssues.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
    super(`Invalid host-mediated plugin contract${detail ? `: ${detail}` : '.'}`);
    this.name = 'PluginDownstreamContractError';
    this.code = 'PLUGIN_DOWNSTREAM_CONTRACT_INVALID';
    this.issues = normalizedIssues;
  }
}

export function createPluginSearchNamespace(input) {
  const value = requireRecord(input, new Set(['pluginId', 'catalogType', 'catalogId']), 'A plugin search namespace');
  const addonId = pluginId(value.pluginId, '$.pluginId');
  const catalogType = namespaceText(value.catalogType, '$.catalogType', 64);
  const catalogId = namespaceText(value.catalogId, '$.catalogId', 128);
  return deepFreeze({
    contractVersion: PLUGIN_DOWNSTREAM_PROTOCOL_VERSION,
    kind: 'plugin-search-namespace',
    transport: PLUGIN_HOST_TRANSPORT,
    pluginId: addonId,
    catalogType,
    catalogId,
    namespace: `${PLUGIN_NAMESPACE_PREFIX}:${addonId}`,
    namespaceKey: namespaceKey(addonId, catalogType, catalogId),
  });
}

export function namespacePluginCatalogItem(input) {
  const value = requireRecord(input, new Set(['pluginId', 'catalogType', 'catalogId', 'itemId']), 'A plugin catalog item namespace');
  const namespace = createPluginSearchNamespace({
    pluginId: value.pluginId,
    catalogType: value.catalogType,
    catalogId: value.catalogId,
  });
  const itemId = text(value.itemId, '$.itemId', { maxLength: 256 });
  return deepFreeze({
    ...namespace,
    kind: 'plugin-catalog-item-namespace',
    itemId,
    itemKey: itemNamespaceKey(namespace.pluginId, namespace.catalogType, namespace.catalogId, itemId),
  });
}

export function createPluginSearchRequest(input) {
  const value = requireRecord(input, new Set(['pluginId', 'catalogType', 'catalogId', 'query', 'page', 'limit', 'profile']), 'A plugin search request');
  const namespace = createPluginSearchNamespace({
    pluginId: value.pluginId,
    catalogType: value.catalogType,
    catalogId: value.catalogId,
  });
  let query = '';
  if (value.query !== undefined) {
    if (typeof value.query !== 'string') fail('INVALID_TYPE', 'Expected a string.', '$.query');
    query = value.query.trim() === '' ? '' : text(value.query, '$.query', { maxLength: 200 });
  }
  const page = value.page === undefined ? 0 : integer(value.page, '$.page', { max: 10_000 });
  const limit = value.limit === undefined ? 50 : integer(value.limit, '$.limit', { min: 1, max: 200 });
  return deepFreeze({
    contractVersion: PLUGIN_DOWNSTREAM_PROTOCOL_VERSION,
    transport: PLUGIN_HOST_TRANSPORT,
    ...namespace,
    kind: 'plugin-search-request',
    query,
    page,
    limit,
    ...(value.profile === undefined ? {} : { profile: profileBinding(value.profile) }),
  });
}

export function createSubtitleAttachmentRequest(input) {
  const value = requireRecord(input, new Set([
    'pluginId',
    'mediaRef',
    'subtitleRef',
    'language',
    'format',
    'profile',
    'issuedAt',
    'expiresAt',
  ]), 'A subtitle attachment request');
  const addonId = pluginId(value.pluginId, '$.pluginId');
  const window = timeWindow(value.issuedAt, value.expiresAt, '$', PLUGIN_TICKET_MAX_LIFETIME_MS);
  return deepFreeze({
    contractVersion: PLUGIN_DOWNSTREAM_PROTOCOL_VERSION,
    kind: 'subtitle-attachment-request',
    transport: PLUGIN_HOST_TRANSPORT,
    pluginId: addonId,
    mediaRef: opaqueReference(value.mediaRef, '$.mediaRef'),
    subtitleRef: opaqueReference(value.subtitleRef, '$.subtitleRef'),
    ...(value.language === undefined ? {} : { language: text(value.language, '$.language', { maxLength: 32 }) }),
    ...(value.format === undefined ? {} : { format: opaqueReference(value.format, '$.format') }),
    profile: profileBinding(value.profile),
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    authorization: {
      profileBound: true,
      selectionRevisionRequired: true,
      pairingRevalidated: true,
      hostResolvesSource: true,
    },
  });
}

export function createSubtitleAttachmentReceipt(input) {
  const value = requireRecord(input, new Set([
    'requestRef',
    'pluginId',
    'mediaRef',
    'profile',
    'status',
    'attachmentRef',
    'reasonCode',
    'issuedAt',
    'expiresAt',
  ]), 'A subtitle attachment receipt');
  const status = value.status;
  if (status !== 'accepted' && status !== 'rejected') fail('INVALID_STATUS', 'Subtitle attachment status must be accepted or rejected.', '$.status');
  const window = timeWindow(value.issuedAt, value.expiresAt, '$', PLUGIN_TICKET_MAX_LIFETIME_MS);
  const attachmentRef = optionalOpaqueReference(value.attachmentRef, '$.attachmentRef');
  const reasonCode = optionalOpaqueReference(value.reasonCode, '$.reasonCode');
  if (status === 'accepted' && !attachmentRef) fail('MISSING', 'Accepted subtitle attachments require an opaque attachment reference.', '$.attachmentRef');
  if (status === 'rejected' && !reasonCode) fail('MISSING', 'Rejected subtitle attachments require an opaque reason code.', '$.reasonCode');
  if (status === 'accepted' && reasonCode) fail('INVALID_VALUE', 'Accepted subtitle attachments must not include a rejection reason.', '$.reasonCode');
  if (status === 'rejected' && attachmentRef) fail('INVALID_VALUE', 'Rejected subtitle attachments must not include an attachment reference.', '$.attachmentRef');
  return deepFreeze({
    contractVersion: PLUGIN_DOWNSTREAM_PROTOCOL_VERSION,
    kind: 'subtitle-attachment-receipt',
    transport: PLUGIN_HOST_TRANSPORT,
    requestRef: opaqueReference(value.requestRef, '$.requestRef'),
    pluginId: pluginId(value.pluginId, '$.pluginId'),
    mediaRef: opaqueReference(value.mediaRef, '$.mediaRef'),
    profile: profileBinding(value.profile),
    status,
    ...(attachmentRef ? { attachmentRef } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
  });
}

export function createPlaybackTicketRequest(input) {
  const value = requireRecord(input, new Set([
    'pluginId',
    'mediaRef',
    'sourceRef',
    'sourceKind',
    'requestedModes',
    'profile',
    'issuedAt',
  ]), 'A playback ticket request');
  if (!PLUGIN_PLAYBACK_SOURCE_KINDS.includes(value.sourceKind)) {
    fail('UNSUPPORTED_SOURCE_KIND', 'Only HTTPS media and HLS sources may enter the future playback proxy contract.', '$.sourceKind');
  }
  const requestedModes = normalizeModes(value.requestedModes || (value.sourceKind === 'hls' ? 'hls-proxy' : 'direct-proxy'), '$.requestedModes');
  return deepFreeze({
    contractVersion: PLUGIN_DOWNSTREAM_PROTOCOL_VERSION,
    kind: 'playback-ticket-request',
    transport: PLUGIN_HOST_TRANSPORT,
    pluginId: pluginId(value.pluginId, '$.pluginId'),
    mediaRef: opaqueReference(value.mediaRef, '$.mediaRef'),
    sourceRef: opaqueReference(value.sourceRef, '$.sourceRef'),
    sourceKind: value.sourceKind,
    requestedModes,
    profile: profileBinding(value.profile),
    issuedAt: integer(value.issuedAt, '$.issuedAt'),
    authorization: {
      profileBound: true,
      selectionRevisionRequired: true,
      pairingRevalidated: true,
      approvalRevalidated: true,
      sourceResolvedByHost: true,
    },
  });
}

export function createPlaybackTicket(input) {
  const value = requireRecord(input, new Set([
    'ticketRef',
    'requestRef',
    'pluginId',
    'mediaRef',
    'sourceRef',
    'sourceKind',
    'profile',
    'issuedAt',
    'expiresAt',
  ]), 'A playback ticket');
  if (!PLUGIN_PLAYBACK_SOURCE_KINDS.includes(value.sourceKind)) fail('UNSUPPORTED_SOURCE_KIND', 'The playback ticket source kind is not host-mediated.', '$.sourceKind');
  const window = timeWindow(value.issuedAt, value.expiresAt, '$', PLUGIN_TICKET_MAX_LIFETIME_MS);
  return deepFreeze({
    contractVersion: PLUGIN_DOWNSTREAM_PROTOCOL_VERSION,
    kind: 'playback-ticket',
    transport: PLUGIN_PROXY_TRANSPORT,
    ticketRef: opaqueReference(value.ticketRef, '$.ticketRef'),
    requestRef: opaqueReference(value.requestRef, '$.requestRef'),
    pluginId: pluginId(value.pluginId, '$.pluginId'),
    mediaRef: opaqueReference(value.mediaRef, '$.mediaRef'),
    sourceRef: opaqueReference(value.sourceRef, '$.sourceRef'),
    sourceKind: value.sourceKind,
    profile: profileBinding(value.profile),
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    proxyPolicy: {
      methods: Object.freeze(['GET', 'HEAD']),
      rangeRequests: true,
      redirects: 'deny',
      cache: 'no-store',
      revalidateProfile: true,
      revalidatePairing: true,
      revalidateApproval: true,
    },
  });
}

export function createPluginHostParityDescriptor(input) {
  const value = requireRecord(input, new Set(['runtime', 'hostApiVersion', 'surfaces']), 'A plugin host parity descriptor');
  if (!PLUGIN_HOST_RUNTIME_KINDS.includes(value.runtime)) fail('INVALID_RUNTIME', 'Plugin host runtime must be desktop or headless.', '$.runtime');
  const hostApiVersion = normalizeSemVer(value.hostApiVersion, '$.hostApiVersion');
  if (!Array.isArray(value.surfaces) || value.surfaces.length !== PLUGIN_HOST_SURFACE_IDS.length) {
    fail('INVALID_ARRAY', `A parity descriptor must describe all ${PLUGIN_HOST_SURFACE_IDS.length} host surfaces.`, '$.surfaces');
  }
  const seen = new Set();
  const surfaces = value.surfaces.map((surface, index) => {
    const path = `$.surfaces[${index}]`;
    requireRecord(surface, new Set(['id', 'state', 'gate']), 'A plugin host surface');
    if (!PLUGIN_HOST_SURFACE_IDS.includes(surface.id)) fail('UNKNOWN_SURFACE', 'Unknown plugin host surface.', `${path}.id`);
    if (seen.has(surface.id)) fail('DUPLICATE_VALUE', 'Plugin host surfaces must be unique.', `${path}.id`);
    seen.add(surface.id);
    if (!PLUGIN_HOST_SURFACE_STATES.includes(surface.state)) fail('INVALID_STATUS', 'Unknown plugin host surface state.', `${path}.state`);
    const gate = optionalText(surface.gate, `${path}.gate`, 256);
    return { id: surface.id, state: surface.state, ...(gate === undefined ? {} : { gate }) };
  });
  for (const surfaceId of PLUGIN_HOST_SURFACE_IDS) {
    if (!seen.has(surfaceId)) fail('MISSING', `Parity descriptor is missing surface ${surfaceId}.`, '$.surfaces');
  }
  return deepFreeze({
    contractVersion: PLUGIN_DOWNSTREAM_PROTOCOL_VERSION,
    kind: 'plugin-host-parity',
    transport: PLUGIN_HOST_TRANSPORT,
    runtime: value.runtime,
    hostApiVersion,
    surfaces,
    prohibited: Object.freeze(['raw-url-playback', 'raw-url-subtitles', 'executable-plugin-code']),
  });
}

export function createSignedCatalogEnvelope(input) {
  const value = requireRecord(input, new Set([
    'publisherId',
    'pluginId',
    'keyId',
    'signatureAlgorithm',
    'sequence',
    'issuedAt',
    'expiresAt',
    'payloadDigest',
    'signature',
    'payload',
  ]), 'A signed catalog envelope');
  const publisherId = pluginId(value.publisherId, '$.publisherId');
  const addonId = pluginId(value.pluginId, '$.pluginId');
  const window = timeWindow(value.issuedAt, value.expiresAt, '$', PLUGIN_CATALOG_MAX_LIFETIME_MS);
  const payload = normalizeCatalogPayload(value.payload, addonId);
  return deepFreeze({
    contractVersion: PLUGIN_DOWNSTREAM_PROTOCOL_VERSION,
    kind: 'signed-catalog',
    transport: PLUGIN_HOST_TRANSPORT,
    publisherId,
    pluginId: addonId,
    keyId: opaqueReference(value.keyId, '$.keyId'),
    signatureAlgorithm: normalizeAlgorithm(value.signatureAlgorithm, '$.signatureAlgorithm'),
    sequence: integer(value.sequence, '$.sequence'),
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    payloadDigest: normalizeDigest(value.payloadDigest, '$.payloadDigest'),
    signature: normalizeSignature(value.signature, '$.signature'),
    payload,
    verification: {
      publisherKeyMustBePinned: true,
      digestMustMatchCanonicalPayload: true,
      sequenceMustNotRegress: true,
      expiryMustBeCheckedBeforeUse: true,
    },
  });
}

export function createSignedUpdateEnvelope(input) {
  const value = requireRecord(input, new Set([
    'publisherId',
    'pluginId',
    'keyId',
    'signatureAlgorithm',
    'sequence',
    'issuedAt',
    'expiresAt',
    'version',
    'hostApiRange',
    'channel',
    'artifactRef',
    'artifactSha256',
    'artifactSize',
    'payloadDigest',
    'signature',
    'requiresRestart',
  ]), 'A signed update envelope');
  const window = timeWindow(value.issuedAt, value.expiresAt, '$', PLUGIN_UPDATE_MAX_LIFETIME_MS);
  const channel = value.channel;
  if (!PLUGIN_UPDATE_CHANNELS.includes(channel)) fail('INVALID_CHANNEL', 'Unknown plugin update channel.', '$.channel');
  const artifactSize = integer(value.artifactSize, '$.artifactSize', { min: 1, max: 2_000_000_000 });
  if (typeof value.requiresRestart !== 'boolean') fail('INVALID_TYPE', 'requiresRestart must be boolean.', '$.requiresRestart');
  return deepFreeze({
    contractVersion: PLUGIN_DOWNSTREAM_PROTOCOL_VERSION,
    kind: 'signed-update',
    transport: PLUGIN_HOST_TRANSPORT,
    publisherId: pluginId(value.publisherId, '$.publisherId'),
    pluginId: pluginId(value.pluginId, '$.pluginId'),
    keyId: opaqueReference(value.keyId, '$.keyId'),
    signatureAlgorithm: normalizeAlgorithm(value.signatureAlgorithm, '$.signatureAlgorithm'),
    sequence: integer(value.sequence, '$.sequence'),
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    version: normalizeSemVer(value.version, '$.version'),
    hostApiRange: normalizeHostApiRange(value.hostApiRange, '$.hostApiRange'),
    channel,
    artifactRef: opaqueReference(value.artifactRef, '$.artifactRef'),
    artifactSha256: normalizeDigest(value.artifactSha256, '$.artifactSha256'),
    artifactSize,
    payloadDigest: normalizeDigest(value.payloadDigest, '$.payloadDigest'),
    signature: normalizeSignature(value.signature, '$.signature'),
    requiresRestart: value.requiresRestart,
    verification: {
      publisherKeyMustBePinned: true,
      digestMustMatchHostFetchedArtifact: true,
      sequenceMustNotRegress: true,
      expiryMustBeCheckedBeforeStaging: true,
      installMustRemainHostControlled: true,
    },
  });
}
