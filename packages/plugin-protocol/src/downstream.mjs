/**
 * Pre-phase downstream plugin contracts.
 *
 * The public wire parsers accept untrusted DTOs only. Verification and
 * authorization return host-only values branded by private WeakMaps. No
 * function in this module fetches, resolves, proxies, installs, or executes a
 * provider, and no contract contains a raw URL, filesystem path, command, or
 * executable entrypoint.
 */

import { canonicalizeJcs } from './signed-bytes.mjs';
import { canonicalPluginItemKey, createPluginItemIdentity } from './identity.mjs';
import { readVerifiedMarketplaceAddon } from './marketplace.mjs';
import { isReadyHostRuntimeLease } from './runtime-lifecycle.mjs';
import {
  deepFreeze,
  failWith,
  isRecord,
  makeIssue,
  readEnum,
  readInteger,
  readOpaqueReference,
  readReverseDnsId,
  readSemVer,
  readText,
  readTimeWindow,
  strictRecord,
} from './validation.mjs';

export const PLUGIN_DOWNSTREAM_PROTOCOL_VERSION = 2;
export const PLUGIN_WIRE_VERSION = 2;
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

export const PLUGIN_TICKET_MAX_LIFETIME_MS = 15 * 60 * 1_000;
export const PLUGIN_CATALOG_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const verifiedRequestRecords = new WeakMap();
const authorizedRequestRecords = new WeakMap();
const hostAuthorizationRecords = new WeakMap();
const planRecords = new WeakMap();

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

function fail(code, message, path = '$') {
  failWith(PluginDownstreamContractError, code, message, path);
}

function wireRecord(value, allowed, kind) {
  return strictRecord(value, allowed, PluginDownstreamContractError, kind, { rejectWireClaims: true });
}

function wireVersionAndKind(value, expectedKind) {
  if (value.wireVersion !== PLUGIN_WIRE_VERSION) fail('UNSUPPORTED_VERSION', 'Unsupported downstream wire version.', '$.wireVersion');
  if (value.kind !== expectedKind) fail('INVALID_KIND', `Expected ${expectedKind}.`, '$.kind');
  if (value.transport !== PLUGIN_HOST_TRANSPORT) fail('INVALID_TRANSPORT', 'Downstream wire DTOs must use the host-mediated transport.', '$.transport');
}

function readAddonId(value, path = '$.addonId') {
  return readReverseDnsId(value, path, PluginDownstreamContractError);
}

function readOptionalText(value, path, maxLength) {
  return value === undefined ? undefined : readText(value, path, PluginDownstreamContractError, { maxLength });
}

function normalizeModes(value, sourceKind, path) {
  const modes = value === undefined ? [sourceKind === 'hls' ? 'hls-proxy' : 'direct-proxy'] : Array.isArray(value) ? value : [value];
  if (modes.length < 1 || modes.length > PLUGIN_PLAYBACK_MODES.length) fail('INVALID_ARRAY', 'At least one and at most two playback modes are required.', path);
  const normalized = modes.map((mode, index) => readEnum(mode, PLUGIN_PLAYBACK_MODES, `${path}[${index}]`, PluginDownstreamContractError, 'playback mode'));
  if (new Set(normalized).size !== normalized.length) fail('DUPLICATE_VALUE', 'Playback modes must be unique.', path);
  return normalized;
}

function readCatalogFields(value, path = '$') {
  return {
    catalogType: readText(value.catalogType, `${path}.catalogType`, PluginDownstreamContractError, { maxLength: 128 }),
    catalogId: readText(value.catalogId, `${path}.catalogId`, PluginDownstreamContractError, { maxLength: 256 }),
  };
}

function requireCapability(addon, capability) {
  if (!addon.capabilities.includes(capability)) fail('CAPABILITY_NOT_DECLARED', `The verified add-on does not declare ${capability}.`, '$.capabilities');
  if (addon.risk.executable) fail('PHASE9_SANDBOX_REQUIRED', 'Executable add-ons remain blocked until the Phase 9 sandbox gate is approved.', '$.risk.executable');
}

function requireCatalogMembership(addon, catalogType, catalogId) {
  if (!addon.catalogs.some((catalog) => catalog.type === catalogType && catalog.id === catalogId)) {
    fail('CATALOG_NOT_DECLARED', 'The verified add-on does not declare this catalog membership.', '$.catalog');
  }
}

function requireAddonUsable(addon, context) {
  if (addon.review.state !== 'approved' || (addon.review.expiresAt !== undefined && context.now >= addon.review.expiresAt)) {
    fail('ADDON_REVIEW_REQUIRED', 'The add-on is not currently approved for host-mediated use.', '$.review');
  }
  if (addon.revocation.state !== 'active' || (addon.revocation.effectiveAt !== undefined && context.now >= addon.revocation.effectiveAt)) {
    fail('ADDON_REVOKED', 'The add-on is revoked for host-mediated use.', '$.revocation');
  }
}

function requireHostAuthorizationContext(value) {
  const record = hostAuthorizationRecords.get(value);
  if (!record) fail('HOST_AUTHORIZATION_REQUIRED', 'A host-owned authorization context is mandatory.');
  return record;
}

function requireAllowedAddon(addon, context, capability) {
  const allowed = context.allowedAddons.find((entry) => entry.addonId === addon.addonId);
  if (!allowed || !allowed.capabilities.includes(capability)) {
    fail('HOST_PERMISSION_REQUIRED', 'The host authorization snapshot does not grant this add-on capability.', '$.allowedAddons');
  }
}

function bindingFor(context) {
  return {
    deviceRef: context.deviceRef,
    profileId: context.profileId,
    selectionRevision: context.selectionRevision,
    authorizationEpoch: context.authorizationEpoch,
  };
}

function createVerifiedRequest(kind, wire, addon, extra) {
  const verified = Object.freeze({
    wireVersion: PLUGIN_WIRE_VERSION,
    kind,
    transport: PLUGIN_HOST_TRANSPORT,
    addonId: addon.addonId,
    ...extra,
  });
  verifiedRequestRecords.set(verified, { wire, addon, kind });
  return verified;
}

function authorizeRequest(verified, capability, outputKind, fields, hostContext) {
  const record = verifiedRequestRecords.get(verified);
  if (!record) fail('VERIFIED_REQUEST_REQUIRED', 'A host-verified request is required.');
  const context = requireHostAuthorizationContext(hostContext);
  requireCapability(record.addon, capability);
  requireAddonUsable(record.addon, context);
  requireAllowedAddon(record.addon, context, capability);
  const authorized = Object.freeze({
    wireVersion: PLUGIN_WIRE_VERSION,
    kind: outputKind,
    transport: PLUGIN_HOST_TRANSPORT,
    addonId: record.addon.addonId,
    ...fields(record.wire),
    binding: bindingFor(context),
  });
  authorizedRequestRecords.set(authorized, { verified, addon: record.addon, wire: record.wire, context, capability });
  return authorized;
}

export function parseWireSearchRequest(input) {
  const value = wireRecord(input, new Set(['wireVersion', 'kind', 'transport', 'addonId', 'catalogType', 'catalogId', 'query', 'page', 'limit']), 'A plugin search request');
  wireVersionAndKind(value, 'plugin-search-request');
  const { catalogType, catalogId } = readCatalogFields(value);
  let query = '';
  if (value.query !== undefined) {
    if (typeof value.query !== 'string') fail('INVALID_TYPE', 'Expected a string.', '$.query');
    query = value.query.trim() === '' ? '' : readText(value.query, '$.query', PluginDownstreamContractError, { maxLength: 200 });
  }
  return deepFreeze({
    wireVersion: PLUGIN_WIRE_VERSION,
    kind: 'plugin-search-request',
    transport: PLUGIN_HOST_TRANSPORT,
    addonId: readAddonId(value.addonId),
    catalogType,
    catalogId,
    query,
    page: value.page === undefined ? 0 : readInteger(value.page, '$.page', PluginDownstreamContractError, { max: 10_000 }),
    limit: value.limit === undefined ? 50 : readInteger(value.limit, '$.limit', PluginDownstreamContractError, { min: 1, max: 200 }),
  });
}

export function parseWireSubtitleAttachmentRequest(input) {
  const value = wireRecord(input, new Set([
    'wireVersion',
    'kind',
    'transport',
    'addonId',
    'requestRef',
    'mediaRef',
    'subtitleRef',
    'language',
    'format',
  ]), 'A subtitle attachment request');
  wireVersionAndKind(value, 'subtitle-attachment-request');
  const language = readOptionalText(value.language, '$.language', 32);
  const format = value.format === undefined ? undefined : readOpaqueReference(value.format, '$.format', PluginDownstreamContractError);
  return deepFreeze({
    wireVersion: PLUGIN_WIRE_VERSION,
    kind: 'subtitle-attachment-request',
    transport: PLUGIN_HOST_TRANSPORT,
    addonId: readAddonId(value.addonId),
    requestRef: readOpaqueReference(value.requestRef, '$.requestRef', PluginDownstreamContractError),
    mediaRef: readOpaqueReference(value.mediaRef, '$.mediaRef', PluginDownstreamContractError),
    subtitleRef: readOpaqueReference(value.subtitleRef, '$.subtitleRef', PluginDownstreamContractError),
    ...(language === undefined ? {} : { language }),
    ...(format === undefined ? {} : { format }),
  });
}

export function parseWirePlaybackTicketRequest(input) {
  const value = wireRecord(input, new Set([
    'wireVersion',
    'kind',
    'transport',
    'addonId',
    'requestRef',
    'mediaRef',
    'sourceRef',
    'sourceKind',
    'requestedModes',
  ]), 'A playback ticket request');
  wireVersionAndKind(value, 'playback-ticket-request');
  const sourceKind = readEnum(value.sourceKind, PLUGIN_PLAYBACK_SOURCE_KINDS, '$.sourceKind', PluginDownstreamContractError, 'playback source kind');
  return deepFreeze({
    wireVersion: PLUGIN_WIRE_VERSION,
    kind: 'playback-ticket-request',
    transport: PLUGIN_HOST_TRANSPORT,
    addonId: readAddonId(value.addonId),
    requestRef: readOpaqueReference(value.requestRef, '$.requestRef', PluginDownstreamContractError),
    mediaRef: readOpaqueReference(value.mediaRef, '$.mediaRef', PluginDownstreamContractError),
    sourceRef: readOpaqueReference(value.sourceRef, '$.sourceRef', PluginDownstreamContractError),
    sourceKind,
    requestedModes: normalizeModes(value.requestedModes, sourceKind, '$.requestedModes'),
  });
}

export function verifyWireSearchRequest(input, verifiedAddon) {
  const wire = parseWireSearchRequest(input);
  const addon = readVerifiedMarketplaceAddon(verifiedAddon);
  if (addon.addonId !== wire.addonId) fail('ADDON_MISMATCH', 'The search request add-on must match the verified marketplace add-on.', '$.addonId');
  requireCapability(addon, 'metadata.catalog');
  requireCatalogMembership(addon, wire.catalogType, wire.catalogId);
  return createVerifiedRequest('verified-plugin-search-request', wire, addon, {
    catalogType: wire.catalogType,
    catalogId: wire.catalogId,
    query: wire.query,
    page: wire.page,
    limit: wire.limit,
  });
}

export function verifyWireSubtitleAttachmentRequest(input, verifiedAddon) {
  const wire = parseWireSubtitleAttachmentRequest(input);
  const addon = readVerifiedMarketplaceAddon(verifiedAddon);
  if (addon.addonId !== wire.addonId) fail('ADDON_MISMATCH', 'The subtitle request add-on must match the verified marketplace add-on.', '$.addonId');
  requireCapability(addon, 'subtitle.provider');
  return createVerifiedRequest('verified-subtitle-attachment-request', wire, addon, {
    requestRef: wire.requestRef,
    mediaRef: wire.mediaRef,
    subtitleRef: wire.subtitleRef,
    ...(wire.language === undefined ? {} : { language: wire.language }),
    ...(wire.format === undefined ? {} : { format: wire.format }),
  });
}

export function verifyWirePlaybackTicketRequest(input, verifiedAddon) {
  const wire = parseWirePlaybackTicketRequest(input);
  const addon = readVerifiedMarketplaceAddon(verifiedAddon);
  if (addon.addonId !== wire.addonId) fail('ADDON_MISMATCH', 'The playback request add-on must match the verified marketplace add-on.', '$.addonId');
  requireCapability(addon, 'playback.provider');
  return createVerifiedRequest('verified-playback-ticket-request', wire, addon, {
    requestRef: wire.requestRef,
    mediaRef: wire.mediaRef,
    sourceRef: wire.sourceRef,
    sourceKind: wire.sourceKind,
    requestedModes: wire.requestedModes,
  });
}

export function createHostOnlyAuthorizationContext(input) {
  if (!isRecord(input)) fail('INVALID_TYPE', 'A host authorization context must be an object.');
  const allowed = new Set(['deviceRef', 'profileId', 'selectionRevision', 'authorizationEpoch', 'now', 'allowedAddons']);
  const issues = [];
  for (const key of Object.keys(input)) if (!allowed.has(key)) issues.push(makeIssue(`$.${key}`, 'unknown_field', 'Unknown host authorization fields are not supported.'));
  if (issues.length > 0) throw new PluginDownstreamContractError(issues);
  if (!Array.isArray(input.allowedAddons) || input.allowedAddons.length > 256) fail('INVALID_ARRAY', 'The host authorization snapshot must contain at most 256 add-ons.', '$.allowedAddons');
  const allowedAddons = input.allowedAddons.map((entry, index) => {
    strictRecord(entry, new Set(['addonId', 'capabilities']), PluginDownstreamContractError, 'A host add-on authorization entry');
    const capabilities = entry.capabilities;
    if (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 16) fail('INVALID_ARRAY', 'Host capability grants must be a bounded array.', `$.allowedAddons[${index}].capabilities`);
    const normalizedCapabilities = capabilities.map((capability, capabilityIndex) => readText(capability, `$.allowedAddons[${index}].capabilities[${capabilityIndex}]`, PluginDownstreamContractError, { maxLength: 128 }));
    if (new Set(normalizedCapabilities).size !== normalizedCapabilities.length) fail('DUPLICATE_VALUE', 'Host capability grants must be unique.', `$.allowedAddons[${index}].capabilities`);
    return {
      addonId: readAddonId(entry.addonId, `$.allowedAddons[${index}].addonId`),
      capabilities: Object.freeze(normalizedCapabilities),
    };
  });
  if (new Set(allowedAddons.map((entry) => entry.addonId)).size !== allowedAddons.length) fail('DUPLICATE_VALUE', 'Host add-on authorization entries must be unique.', '$.allowedAddons');
  const context = Object.freeze({ kind: 'host-authorization-context' });
  hostAuthorizationRecords.set(context, Object.freeze({
    deviceRef: readOpaqueReference(input.deviceRef, '$.deviceRef', PluginDownstreamContractError),
    profileId: readOpaqueReference(input.profileId, '$.profileId', PluginDownstreamContractError),
    selectionRevision: readInteger(input.selectionRevision, '$.selectionRevision', PluginDownstreamContractError),
    authorizationEpoch: readInteger(input.authorizationEpoch, '$.authorizationEpoch', PluginDownstreamContractError),
    now: readInteger(input.now, '$.now', PluginDownstreamContractError),
    allowedAddons: Object.freeze(allowedAddons),
  }));
  return context;
}

export function authorizeVerifiedSearchRequest(verified, hostContext) {
  const record = verifiedRequestRecords.get(verified);
  if (!record || record.kind !== 'verified-plugin-search-request') fail('VERIFIED_REQUEST_REQUIRED', 'A host-verified search request is required.');
  return authorizeRequest(verified, 'metadata.catalog', 'authorized-plugin-search-request', (wire) => ({
    catalogType: wire.catalogType,
    catalogId: wire.catalogId,
    query: wire.query,
    page: wire.page,
    limit: wire.limit,
  }), hostContext);
}

export function authorizeVerifiedSubtitleAttachmentRequest(verified, hostContext) {
  const record = verifiedRequestRecords.get(verified);
  if (!record || record.kind !== 'verified-subtitle-attachment-request') fail('VERIFIED_REQUEST_REQUIRED', 'A host-verified subtitle request is required.');
  return authorizeRequest(verified, 'subtitle.provider', 'authorized-subtitle-attachment-request', (wire) => ({
    requestRef: wire.requestRef,
    mediaRef: wire.mediaRef,
    subtitleRef: wire.subtitleRef,
    ...(wire.language === undefined ? {} : { language: wire.language }),
    ...(wire.format === undefined ? {} : { format: wire.format }),
  }), hostContext);
}

export function authorizeVerifiedPlaybackTicketRequest(verified, hostContext) {
  const record = verifiedRequestRecords.get(verified);
  if (!record || record.kind !== 'verified-playback-ticket-request') fail('VERIFIED_REQUEST_REQUIRED', 'A host-verified playback request is required.');
  return authorizeRequest(verified, 'playback.provider', 'authorized-playback-ticket-request', (wire) => ({
    requestRef: wire.requestRef,
    mediaRef: wire.mediaRef,
    sourceRef: wire.sourceRef,
    sourceKind: wire.sourceKind,
    requestedModes: wire.requestedModes,
  }), hostContext);
}

export function isAuthorizedPluginRequest(value) {
  return authorizedRequestRecords.has(value);
}

export function createSubtitleAttachmentPlan(authorized) {
  const record = authorizedRequestRecords.get(authorized);
  if (!record || record.capability !== 'subtitle.provider') fail('AUTHORIZED_REQUEST_REQUIRED', 'An authorized subtitle request is required.');
  const plan = Object.freeze({
    kind: 'subtitle-attachment-plan',
    transport: PLUGIN_HOST_TRANSPORT,
    addonId: record.addon.addonId,
    requestRef: record.wire.requestRef,
    mediaRef: record.wire.mediaRef,
    subtitleRef: record.wire.subtitleRef,
    binding: authorized.binding,
    hostResolvesSource: true,
    maxAttachmentBytes: 10 * 1_024 * 1_024,
    status: 'host-resolution-required',
  });
  planRecords.set(plan, { kind: 'subtitle', authorized, record });
  return plan;
}

export function createPlaybackProxyPlan(authorized) {
  const record = authorizedRequestRecords.get(authorized);
  if (!record || record.capability !== 'playback.provider') fail('AUTHORIZED_REQUEST_REQUIRED', 'An authorized playback request is required.');
  const plan = Object.freeze({
    kind: 'playback-proxy-plan',
    transport: PLUGIN_PROXY_TRANSPORT,
    addonId: record.addon.addonId,
    requestRef: record.wire.requestRef,
    mediaRef: record.wire.mediaRef,
    sourceRef: record.wire.sourceRef,
    sourceKind: record.wire.sourceKind,
    requestedModes: record.wire.requestedModes,
    binding: authorized.binding,
    hostResolvesSource: true,
    rawUrlAllowed: false,
    status: 'ready-runtime-required',
  });
  planRecords.set(plan, { kind: 'playback', authorized, record });
  return plan;
}

export function createSubtitleAttachmentReceipt(authorized, input) {
  const record = authorizedRequestRecords.get(authorized);
  if (!record || record.capability !== 'subtitle.provider') fail('AUTHORIZED_REQUEST_REQUIRED', 'An authorized subtitle request is required.');
  strictRecord(input, new Set(['status', 'attachmentRef', 'reasonCode']), PluginDownstreamContractError, 'A host subtitle attachment result');
  const status = readEnum(input.status, ['accepted', 'rejected'], '$.status', PluginDownstreamContractError, 'subtitle attachment status');
  const attachmentRef = input.attachmentRef === undefined ? undefined : readOpaqueReference(input.attachmentRef, '$.attachmentRef', PluginDownstreamContractError);
  const reasonCode = input.reasonCode === undefined ? undefined : readOpaqueReference(input.reasonCode, '$.reasonCode', PluginDownstreamContractError);
  if (status === 'accepted' && (!attachmentRef || reasonCode)) fail('INVALID_RESULT', 'Accepted subtitle results require only an attachmentRef.', '$');
  if (status === 'rejected' && (!reasonCode || attachmentRef)) fail('INVALID_RESULT', 'Rejected subtitle results require only a reasonCode.', '$');
  return deepFreeze({
    kind: 'subtitle-attachment-receipt',
    transport: PLUGIN_HOST_TRANSPORT,
    addonId: record.addon.addonId,
    requestRef: record.wire.requestRef,
    mediaRef: record.wire.mediaRef,
    status,
    ...(attachmentRef === undefined ? {} : { attachmentRef }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    binding: authorized.binding,
  });
}

export function createHostPlaybackTicket(authorized, runtimeLease, input) {
  const record = authorizedRequestRecords.get(authorized);
  if (!record || record.capability !== 'playback.provider') fail('AUTHORIZED_REQUEST_REQUIRED', 'An authorized playback request is required.');
  if (!isReadyHostRuntimeLease(runtimeLease)) fail('RUNTIME_NOT_READY', 'Playback tickets require a host runtime lease in the ready state.');
  strictRecord(input, new Set(['ticketRef', 'issuedAt', 'expiresAt']), PluginDownstreamContractError, 'A host playback ticket');
  const window = readTimeWindow(input.issuedAt, input.expiresAt, '$', PluginDownstreamContractError, PLUGIN_TICKET_MAX_LIFETIME_MS);
  return deepFreeze({
    kind: 'playback-ticket',
    transport: PLUGIN_PROXY_TRANSPORT,
    ticketRef: readOpaqueReference(input.ticketRef, '$.ticketRef', PluginDownstreamContractError),
    requestRef: record.wire.requestRef,
    addonId: record.addon.addonId,
    mediaRef: record.wire.mediaRef,
    sourceKind: record.wire.sourceKind,
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    binding: authorized.binding,
    proxyPolicy: {
      methods: Object.freeze(['GET', 'HEAD']),
      rangeRequests: true,
      redirects: 'deny',
      cache: 'no-store',
      hostResolvesDestination: true,
      recheckAuthorizationAtUse: true,
    },
  });
}

export function createPluginSearchNamespace(input) {
  strictRecord(input, new Set(['addonId', 'catalogType', 'catalogId']), PluginDownstreamContractError, 'A plugin search namespace');
  const addonId = readAddonId(input.addonId);
  const { catalogType, catalogId } = readCatalogFields(input);
  const namespaceKey = [PLUGIN_NAMESPACE_PREFIX, 'catalog', 'v1', addonId, catalogType, catalogId]
    .map((part) => encodeURIComponent(part))
    .join(':');
  return deepFreeze({
    wireVersion: PLUGIN_WIRE_VERSION,
    kind: 'plugin-search-namespace',
    transport: PLUGIN_HOST_TRANSPORT,
    addonId,
    catalogType,
    catalogId,
    namespaceKey,
  });
}

export function namespacePluginCatalogItem(input) {
  strictRecord(input, new Set(['addonId', 'catalogType', 'catalogId', 'type', 'providerId']), PluginDownstreamContractError, 'A plugin catalog item namespace');
  const namespace = createPluginSearchNamespace(input);
  const type = readText(input.type, '$.type', PluginDownstreamContractError, { maxLength: 512 });
  const providerId = readText(input.providerId, '$.providerId', PluginDownstreamContractError, { maxLength: 512 });
  const itemKey = canonicalPluginItemKey(createPluginItemIdentity({ addonId: namespace.addonId, type, providerId }));
  return deepFreeze({ ...namespace, kind: 'plugin-catalog-item-namespace', type, providerId, itemKey });
}

export function createPluginHostParityDescriptor(input) {
  strictRecord(input, new Set(['runtime', 'hostApiVersion', 'surfaces']), PluginDownstreamContractError, 'A plugin host parity descriptor');
  const runtime = readEnum(input.runtime, PLUGIN_HOST_RUNTIME_KINDS, '$.runtime', PluginDownstreamContractError, 'plugin host runtime');
  const hostApiVersion = readSemVer(input.hostApiVersion, '$.hostApiVersion', PluginDownstreamContractError);
  if (!Array.isArray(input.surfaces) || input.surfaces.length !== PLUGIN_HOST_SURFACE_IDS.length) fail('INVALID_ARRAY', `Parity must describe all ${PLUGIN_HOST_SURFACE_IDS.length} host surfaces.`, '$.surfaces');
  const seen = new Set();
  const surfaces = input.surfaces.map((surface, index) => {
    strictRecord(surface, new Set(['id', 'state', 'gate']), PluginDownstreamContractError, 'A plugin host surface');
    const path = `$.surfaces[${index}]`;
    const id = readEnum(surface.id, PLUGIN_HOST_SURFACE_IDS, `${path}.id`, PluginDownstreamContractError, 'host surface');
    if (seen.has(id)) fail('DUPLICATE_VALUE', 'Host surfaces must be unique.', `${path}.id`);
    seen.add(id);
    return {
      id,
      state: readEnum(surface.state, PLUGIN_HOST_SURFACE_STATES, `${path}.state`, PluginDownstreamContractError, 'host surface state'),
      ...(surface.gate === undefined ? {} : { gate: readText(surface.gate, `${path}.gate`, PluginDownstreamContractError, { maxLength: 256 }) }),
    };
  });
  if (seen.size !== PLUGIN_HOST_SURFACE_IDS.length) fail('MISSING', 'Parity must describe each host surface exactly once.', '$.surfaces');
  return deepFreeze({
    wireVersion: PLUGIN_WIRE_VERSION,
    kind: 'plugin-host-parity',
    transport: PLUGIN_HOST_TRANSPORT,
    runtime,
    hostApiVersion,
    surfaces,
    scope: 'pre-phase-scaffold',
    prohibited: Object.freeze(['raw-url-playback', 'raw-url-subtitles', 'executable-plugin-code']),
  });
}

export function canonicalizeSignedDocument(value) {
  return canonicalizeJcs(value);
}

export function isWireRequest(value) {
  return isRecord(value) && typeof value.kind === 'string' && value.wireVersion === PLUGIN_WIRE_VERSION;
}

// This helper is intentionally host-only; it is not a ticket issuer or a proxy.
export function isHostOnlyAuthorizationContext(value) {
  return hostAuthorizationRecords.has(value);
}
