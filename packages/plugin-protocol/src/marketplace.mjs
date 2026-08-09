/**
 * Host-verified marketplace, catalog, and update contracts.
 *
 * The parser accepts untrusted JSON-shaped DTOs. Verification and
 * authorization require values stored in private WeakMaps, so a renderer or
 * provider cannot manufacture a verified add-on, host verifier, or update
 * approval by copying object fields. This module never downloads, installs,
 * launches, or exposes an artifact URL.
 */

import {
  canonicalizeJcs,
  decodeEd25519PublicKey,
  decodeEd25519Signature,
  domainSeparatedSignedBytes,
} from './signed-bytes.mjs';
import { parseWireCatalogResult } from './identity.mjs';
import {
  deepFreeze,
  compareSemVerStrings,
  failWith,
  isRecord,
  readBoolean,
  readEnum,
  readInteger,
  readOpaqueReference,
  readPublicHttpsOrigin,
  readReverseDnsId,
  readSemVer,
  readSha256,
  readStringArray,
  readText,
  readTimeWindow,
  strictRecord,
} from './validation.mjs';

export const PLUGIN_MARKETPLACE_WIRE_VERSION = 1;
export const PLUGIN_MARKETPLACE_INDEX_KIND = 'plugin-marketplace-index';
export const PLUGIN_PLUGIN_UPDATE_KIND = 'plugin-update';
export const PLUGIN_RENDERER_MARKETPLACE_KIND = 'marketplace-index-renderer';
export const PLUGIN_RENDERER_UPDATE_KIND = 'plugin-update-renderer';

export const PLUGIN_CAPABILITY_TYPES = Object.freeze([
  'metadata.catalog',
  'subtitle.provider',
  'playback.provider',
]);
export const PLUGIN_MARKETPLACE_RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const PLUGIN_REVIEW_STATES = Object.freeze(['unreviewed', 'pending', 'approved', 'rejected', 'expired']);
export const PLUGIN_REVOCATION_STATES = Object.freeze(['active', 'revoked']);
export const PLUGIN_UPDATE_CHANNELS = Object.freeze(['stable', 'beta', 'canary']);
export const PLUGIN_UPDATE_ARTIFACT_KINDS = Object.freeze(['declarative-index', 'executable-plugin']);
export const PLUGIN_UPDATE_STATUS = Object.freeze(['verified', 'quarantined-phase9']);

export const PLUGIN_MARKETPLACE_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
export const PLUGIN_UPDATE_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

const verifiedIndexRecords = new WeakMap();
const verifiedAddonRecords = new WeakMap();
const marketplaceContextRecords = new WeakMap();
const verifiedUpdateRecords = new WeakMap();
const updateContextRecords = new WeakMap();
const verifiedCatalogRecords = new WeakMap();
const parsedSignedCatalogRecords = new WeakSet();

export class PluginMarketplaceContractError extends Error {
  constructor(issues) {
    const normalizedIssues = Object.freeze(issues.map((entry) => Object.freeze({ ...entry })));
    const detail = normalizedIssues.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
    super(`Invalid plugin marketplace contract${detail ? `: ${detail}` : '.'}`);
    this.name = 'PluginMarketplaceContractError';
    this.code = 'PLUGIN_MARKETPLACE_CONTRACT_INVALID';
    this.issues = normalizedIssues;
  }
}

function fail(code, message, path = '$') {
  failWith(PluginMarketplaceContractError, code, message, path);
}

function parseRisk(value, path) {
  strictRecord(value, new Set([
    'level',
    'network',
    'metadata',
    'subtitle',
    'playback',
    'artwork',
    'profile',
    'executable',
    'updates',
  ]), PluginMarketplaceContractError, 'An add-on risk declaration');
  const flags = ['network', 'metadata', 'subtitle', 'playback', 'artwork', 'profile', 'executable', 'updates'];
  return {
    level: readEnum(value.level, PLUGIN_MARKETPLACE_RISK_LEVELS, `${path}.level`, PluginMarketplaceContractError, 'risk level'),
    ...Object.fromEntries(flags.map((flag) => [flag, readBoolean(value[flag], `${path}.${flag}`, PluginMarketplaceContractError)])),
  };
}

function parseReview(value, path) {
  strictRecord(value, new Set(['state', 'reviewedAt', 'reviewerRef', 'expiresAt']), PluginMarketplaceContractError, 'An add-on review declaration');
  const state = readEnum(value.state, PLUGIN_REVIEW_STATES, `${path}.state`, PluginMarketplaceContractError, 'review state');
  const reviewedAt = value.reviewedAt === undefined ? undefined : readInteger(value.reviewedAt, `${path}.reviewedAt`, PluginMarketplaceContractError);
  const reviewerRef = value.reviewerRef === undefined ? undefined : readOpaqueReference(value.reviewerRef, `${path}.reviewerRef`, PluginMarketplaceContractError);
  const expiresAt = value.expiresAt === undefined ? undefined : readInteger(value.expiresAt, `${path}.expiresAt`, PluginMarketplaceContractError);
  if (state === 'approved' && (reviewedAt === undefined || reviewerRef === undefined)) {
    fail('INVALID_REVIEW', 'Approved add-ons require reviewedAt and reviewerRef.', path);
  }
  return {
    state,
    ...(reviewedAt === undefined ? {} : { reviewedAt }),
    ...(reviewerRef === undefined ? {} : { reviewerRef }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function parseRevocation(value, path) {
  strictRecord(value, new Set(['state', 'effectiveAt', 'reasonCode', 'sequence']), PluginMarketplaceContractError, 'An add-on revocation declaration');
  const state = readEnum(value.state, PLUGIN_REVOCATION_STATES, `${path}.state`, PluginMarketplaceContractError, 'revocation state');
  const effectiveAt = value.effectiveAt === undefined ? undefined : readInteger(value.effectiveAt, `${path}.effectiveAt`, PluginMarketplaceContractError);
  const sequence = value.sequence === undefined ? undefined : readInteger(value.sequence, `${path}.sequence`, PluginMarketplaceContractError);
  const reasonCode = value.reasonCode === undefined ? undefined : readOpaqueReference(value.reasonCode, `${path}.reasonCode`, PluginMarketplaceContractError);
  if (state === 'revoked' && (effectiveAt === undefined || reasonCode === undefined)) {
    fail('INVALID_REVOCATION', 'Revoked add-ons require effectiveAt and reasonCode.', path);
  }
  if (state === 'active' && (effectiveAt !== undefined || reasonCode !== undefined)) {
    fail('INVALID_REVOCATION', 'Active declarations cannot carry revocation activation fields.', path);
  }
  return {
    state,
    ...(effectiveAt === undefined ? {} : { effectiveAt }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(sequence === undefined ? {} : { sequence }),
  };
}

function parseRollback(value, path) {
  strictRecord(value, new Set(['allowed', 'minimumSequence', 'maximumVersion', 'requiresHostApproval']), PluginMarketplaceContractError, 'Rollback metadata');
  const allowed = readBoolean(value.allowed, `${path}.allowed`, PluginMarketplaceContractError);
  const minimumSequence = readInteger(value.minimumSequence, `${path}.minimumSequence`, PluginMarketplaceContractError);
  const maximumVersion = value.maximumVersion === undefined ? undefined : readSemVer(value.maximumVersion, `${path}.maximumVersion`, PluginMarketplaceContractError);
  const requiresHostApproval = readBoolean(value.requiresHostApproval, `${path}.requiresHostApproval`, PluginMarketplaceContractError);
  if (allowed && !requiresHostApproval) fail('INVALID_ROLLBACK', 'Rollback must require explicit host approval.', path);
  if (!allowed && maximumVersion !== undefined) fail('INVALID_ROLLBACK', 'A disabled rollback cannot declare a maximum version.', path);
  return {
    allowed,
    minimumSequence,
    ...(maximumVersion === undefined ? {} : { maximumVersion }),
    requiresHostApproval,
  };
}

function parseKeyTransition(value, path) {
  if (value === undefined) return undefined;
  strictRecord(value, new Set(['fromKeyId', 'toKeyId', 'validFrom', 'graceUntil', 'proofSignature']), PluginMarketplaceContractError, 'A publisher key transition');
  const validFrom = readInteger(value.validFrom, `${path}.validFrom`, PluginMarketplaceContractError);
  const graceUntil = readInteger(value.graceUntil, `${path}.graceUntil`, PluginMarketplaceContractError);
  if (graceUntil < validFrom) fail('INVALID_KEY_TRANSITION', 'graceUntil must not precede validFrom.', path);
  const proofSignature = readText(value.proofSignature, `${path}.proofSignature`, PluginMarketplaceContractError, { maxLength: 512 });
  decodeEd25519Signature(proofSignature, `${path}.proofSignature`);
  return {
    fromKeyId: readOpaqueReference(value.fromKeyId, `${path}.fromKeyId`, PluginMarketplaceContractError),
    toKeyId: readOpaqueReference(value.toKeyId, `${path}.toKeyId`, PluginMarketplaceContractError),
    validFrom,
    graceUntil,
    proofSignature,
  };
}

function parseCatalogMembership(value, path) {
  strictRecord(value, new Set(['type', 'id', 'name']), PluginMarketplaceContractError, 'A marketplace catalog membership');
  return {
    type: readText(value.type, `${path}.type`, PluginMarketplaceContractError, { maxLength: 128 }),
    id: readText(value.id, `${path}.id`, PluginMarketplaceContractError, { maxLength: 256 }),
    name: readText(value.name, `${path}.name`, PluginMarketplaceContractError, { maxLength: 256 }),
  };
}

function parseAddon(value, path, publisherId) {
  strictRecord(value, new Set([
    'addonId',
    'publisherId',
    'name',
    'version',
    'manifestOrigin',
    'capabilities',
    'catalogs',
    'risk',
    'review',
    'revocation',
    'keyTransition',
    'rollback',
  ]), PluginMarketplaceContractError, 'A marketplace add-on declaration');
  const addonId = readReverseDnsId(value.addonId, `${path}.addonId`, PluginMarketplaceContractError);
  const addonPublisherId = readReverseDnsId(value.publisherId, `${path}.publisherId`, PluginMarketplaceContractError);
  if (addonPublisherId !== publisherId) fail('PUBLISHER_MISMATCH', 'Add-on publisherId must match the signed index publisherId.', `${path}.publisherId`);
  const capabilities = readStringArray(value.capabilities, `${path}.capabilities`, PluginMarketplaceContractError, { maxItems: 16, maxLength: 128 });
  if (capabilities.some((capability) => !PLUGIN_CAPABILITY_TYPES.includes(capability))) {
    fail('UNSUPPORTED_CAPABILITY', 'The marketplace contains a capability outside the reviewed host allowlist.', `${path}.capabilities`);
  }
  if (!Array.isArray(value.catalogs) || value.catalogs.length > 256) fail('INVALID_ARRAY', 'An add-on may declare at most 256 catalog memberships.', `${path}.catalogs`);
  const catalogs = value.catalogs.map((catalog, index) => parseCatalogMembership(catalog, `${path}.catalogs[${index}]`));
  const membershipKeys = new Set(catalogs.map((catalog) => `${catalog.type}\u0000${catalog.id}`));
  if (membershipKeys.size !== catalogs.length) fail('DUPLICATE_VALUE', 'Catalog memberships must be unique within an add-on.', `${path}.catalogs`);
  return {
    addonId,
    publisherId: addonPublisherId,
    name: readText(value.name, `${path}.name`, PluginMarketplaceContractError, { maxLength: 256 }),
    version: readSemVer(value.version, `${path}.version`, PluginMarketplaceContractError),
    manifestOrigin: readPublicHttpsOrigin(value.manifestOrigin, `${path}.manifestOrigin`, PluginMarketplaceContractError),
    capabilities,
    catalogs,
    risk: parseRisk(value.risk, `${path}.risk`),
    review: parseReview(value.review, `${path}.review`),
    revocation: parseRevocation(value.revocation, `${path}.revocation`),
    ...(value.keyTransition === undefined ? {} : { keyTransition: parseKeyTransition(value.keyTransition, `${path}.keyTransition`) }),
    rollback: parseRollback(value.rollback, `${path}.rollback`),
  };
}

function parseIndex(value) {
  strictRecord(value, new Set([
    'wireVersion',
    'kind',
    'indexId',
    'sequence',
    'issuedAt',
    'expiresAt',
    'publisherId',
    'publisherKeyId',
    'keyTransition',
    'rollback',
    'addons',
    'signatureAlgorithm',
    'signature',
  ]), PluginMarketplaceContractError, 'A marketplace index');
  if (value.wireVersion !== PLUGIN_MARKETPLACE_WIRE_VERSION) fail('UNSUPPORTED_VERSION', 'Unsupported marketplace wire version.', '$.wireVersion');
  if (value.kind !== PLUGIN_MARKETPLACE_INDEX_KIND) fail('INVALID_KIND', 'Unexpected marketplace index kind.', '$.kind');
  const window = readTimeWindow(value.issuedAt, value.expiresAt, '$', PluginMarketplaceContractError, PLUGIN_MARKETPLACE_MAX_LIFETIME_MS);
  const publisherId = readReverseDnsId(value.publisherId, '$.publisherId', PluginMarketplaceContractError);
  const signatureAlgorithm = readEnum(value.signatureAlgorithm, ['ed25519'], '$.signatureAlgorithm', PluginMarketplaceContractError, 'signature algorithm');
  const signature = readText(value.signature, '$.signature', PluginMarketplaceContractError, { maxLength: 512 });
  decodeEd25519Signature(signature, '$.signature');
  if (!Array.isArray(value.addons) || value.addons.length > 1_000) fail('INVALID_ARRAY', 'Marketplace indexes may contain at most 1,000 add-ons.', '$.addons');
  const addons = value.addons.map((addon, index) => parseAddon(addon, `$.addons[${index}]`, publisherId));
  if (new Set(addons.map((addon) => addon.addonId)).size !== addons.length) fail('DUPLICATE_VALUE', 'Marketplace add-on IDs must be unique.', '$.addons');
  return {
    wireVersion: PLUGIN_MARKETPLACE_WIRE_VERSION,
    kind: PLUGIN_MARKETPLACE_INDEX_KIND,
    indexId: readOpaqueReference(value.indexId, '$.indexId', PluginMarketplaceContractError),
    sequence: readInteger(value.sequence, '$.sequence', PluginMarketplaceContractError),
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    publisherId,
    publisherKeyId: readOpaqueReference(value.publisherKeyId, '$.publisherKeyId', PluginMarketplaceContractError),
    ...(value.keyTransition === undefined ? {} : { keyTransition: parseKeyTransition(value.keyTransition, '$.keyTransition') }),
    rollback: parseRollback(value.rollback, '$.rollback'),
    addons,
    signatureAlgorithm,
    signature,
  };
}

export function parseWireMarketplaceIndex(input) {
  return deepFreeze(parseIndex(input));
}

function unsignedPayload(value) {
  const { signature: _signature, ...payload } = value;
  return payload;
}

function signedCatalogPayload(value) {
  return {
    ...unsignedPayload(value),
    payload: {
      ...value.payload,
      items: value.payload.items.map(({ itemKey: _itemKey, ...item }) => item),
    },
  };
}

function transitionPayload(index, transition) {
  return {
    kind: 'publisher-key-transition',
    publisherId: index.publisherId,
    fromKeyId: transition.fromKeyId,
    toKeyId: transition.toKeyId,
    validFrom: transition.validFrom,
    graceUntil: transition.graceUntil,
  };
}

function requireMarketplaceContext(value) {
  const record = marketplaceContextRecords.get(value);
  if (!record) fail('HOST_CONTEXT_REQUIRED', 'A host marketplace verification context is required.');
  return record;
}

function resolveKey(context, publisherId, keyId, path) {
  const resolved = context.resolvePublisherKey({ publisherId, keyId });
  if (!isRecord(resolved) || typeof resolved.publicKey !== 'string') fail('PUBLISHER_KEY_UNAVAILABLE', 'The host could not resolve the trusted publisher key.', path);
  const publicKey = decodeEd25519PublicKey(resolved.publicKey, `${path}.publicKey`);
  if (resolved.revoked === true) fail('PUBLISHER_KEY_REVOKED', 'The publisher key is revoked.', path);
  return { ...resolved, publicKey };
}

function verifySignature(context, key, signature, bytes, path, purpose) {
  const signatureBytes = decodeEd25519Signature(signature, path);
  if (context.verifySignature({ algorithm: 'ed25519', publicKey: key.publicKey, signature: signatureBytes, message: bytes, purpose }) !== true) {
    fail('SIGNATURE_INVALID', 'The host signature verifier rejected the signed bytes.', path);
  }
}

function sequenceScope(value) {
  return {
    publisherId: value.publisherId,
    ...(value.addonId === undefined ? {} : { addonId: value.addonId }),
    kind: value.kind,
  };
}

function sequencePayload(value) {
  return canonicalizeJcs(value.kind === 'signed-catalog' ? signedCatalogPayload(value) : unsignedPayload(value));
}

function checkSequenceAndRollback(index, context) {
  const scope = sequenceScope(index);
  const previousSequence = typeof context.getLastAcceptedSequence === 'function'
    ? context.getLastAcceptedSequence(scope)
    : undefined;
  if (previousSequence === undefined) return;
  const previous = readInteger(previousSequence, '$.host.lastAcceptedSequence', PluginMarketplaceContractError);
  if (index.sequence === previous) {
    const acceptedPayload = context.getLastAcceptedPayload?.(scope);
    if (typeof acceptedPayload !== 'string' || acceptedPayload !== sequencePayload(index)) {
      fail('SEQUENCE_FORK', 'A different signed payload reused an accepted sequence.', '$.sequence');
    }
    return;
  }
  if (index.sequence > previous) return;
  const rollbackVersionAllowed = index.version === undefined
    ? index.rollback.maximumVersion === undefined
    : index.rollback.maximumVersion !== undefined && compareSemVerStrings(index.version, index.rollback.maximumVersion) <= 0;
  if (!index.rollback.allowed
      || !index.rollback.requiresHostApproval
      || !rollbackVersionAllowed
      || index.sequence < index.rollback.minimumSequence
      || context.approveRollback?.({ previousSequence: previous, nextSequence: index.sequence, ...scope }) !== true) {
    fail('SEQUENCE_REGRESSION', 'The signed marketplace sequence regressed without an approved rollback.', '$.sequence');
  }
}

function checkKeyTransition(index, context, currentKey) {
  if (!index.keyTransition) return;
  const transition = index.keyTransition;
  if (transition.fromKeyId !== index.publisherKeyId) fail('INVALID_KEY_TRANSITION', 'The key transition must start at the index signing key.', '$.keyTransition.fromKeyId');
  if (context.now < transition.validFrom || context.now > transition.graceUntil) fail('KEY_TRANSITION_EXPIRED', 'The key transition is outside its validity window.', '$.keyTransition');
  resolveKey(context, index.publisherId, transition.toKeyId, '$.keyTransition.toKeyId');
  verifySignature(
    context,
    currentKey,
    transition.proofSignature,
    domainSeparatedSignedBytes('marketplace-index', transitionPayload(index, transition)),
    '$.keyTransition.proofSignature',
    'publisher-key-transition',
  );
}

export function createHostMarketplaceVerificationContext(input) {
  if (!isRecord(input)) fail('INVALID_TYPE', 'A host marketplace verification context must be an object.');
  if (typeof input.now !== 'number' || !Number.isSafeInteger(input.now)) fail('INVALID_INTEGER', 'Host verification time must be an integer.', '$.now');
  if (typeof input.resolvePublisherKey !== 'function') fail('INVALID_CONTEXT', 'Host verification must resolve pinned publisher keys.', '$.resolvePublisherKey');
  if (typeof input.verifySignature !== 'function') fail('INVALID_CONTEXT', 'Host verification must provide a signature verifier.', '$.verifySignature');
  if (typeof input.isPublisherTrusted !== 'function') fail('INVALID_CONTEXT', 'Host verification must provide a publisher trust decision.', '$.isPublisherTrusted');
  if (typeof input.isHostApiRangeSupported !== 'function') fail('INVALID_CONTEXT', 'Host verification must enforce update host API compatibility.', '$.isHostApiRangeSupported');
  const context = Object.freeze({ kind: 'host-marketplace-verification-context' });
  marketplaceContextRecords.set(context, deepFreeze({ ...input }));
  return context;
}

export function verifyWireMarketplaceIndex(input, hostContext) {
  const index = parseIndex(input);
  const context = requireMarketplaceContext(hostContext);
  if (context.isPublisherTrusted({ publisherId: index.publisherId }) !== true) fail('PUBLISHER_UNTRUSTED', 'The marketplace publisher is not trusted.', '$.publisherId');
  if (context.now < index.issuedAt || context.now >= index.expiresAt) fail('INDEX_EXPIRED', 'The marketplace index is outside its validity window.', '$');
  checkSequenceAndRollback(index, context);
  const signingKey = resolveKey(context, index.publisherId, index.publisherKeyId, '$.publisherKeyId');
  verifySignature(context, signingKey, index.signature, domainSeparatedSignedBytes('marketplace-index', unsignedPayload(index)), '$.signature', 'marketplace-index');
  checkKeyTransition(index, context, signingKey);
  const verifiedIndex = deepFreeze({
    wireVersion: index.wireVersion,
    kind: index.kind,
    indexId: index.indexId,
    sequence: index.sequence,
    issuedAt: index.issuedAt,
    expiresAt: index.expiresAt,
    addons: index.addons,
  });
  verifiedIndexRecords.set(verifiedIndex, deepFreeze({ index, context }));
  for (const addon of verifiedIndex.addons) verifiedAddonRecords.set(addon, deepFreeze({ addon, verifiedIndex }));
  return verifiedIndex;
}

export function isVerifiedMarketplaceIndex(value) {
  return verifiedIndexRecords.has(value);
}

export function isVerifiedMarketplaceAddon(value) {
  return verifiedAddonRecords.has(value);
}

/** @internal Host-only accessor used by downstream authorization. */
export function readVerifiedMarketplaceAddon(value) {
  const record = verifiedAddonRecords.get(value);
  if (!record) fail('VERIFIED_ADDON_REQUIRED', 'A host-verified marketplace add-on is required.');
  return record.addon;
}

export function projectMarketplaceIndexForRenderer(value) {
  const record = verifiedIndexRecords.get(value);
  if (!record) fail('VERIFIED_INDEX_REQUIRED', 'A host-verified marketplace index is required.');
  return deepFreeze({
    wireVersion: PLUGIN_MARKETPLACE_WIRE_VERSION,
    kind: PLUGIN_RENDERER_MARKETPLACE_KIND,
    indexId: value.indexId,
    sequence: value.sequence,
    expiresAt: value.expiresAt,
    addons: value.addons.map((addon) => ({
      addonId: addon.addonId,
      name: addon.name,
      version: addon.version,
      capabilities: addon.capabilities,
      catalogs: addon.catalogs.map((catalog) => ({ type: catalog.type, id: catalog.id, name: catalog.name })),
      risk: addon.risk,
      review: {
        state: addon.review.state,
        ...(addon.review.expiresAt === undefined ? {} : { expiresAt: addon.review.expiresAt }),
      },
      revocation: {
        state: addon.revocation.state,
        ...(addon.revocation.effectiveAt === undefined ? {} : { effectiveAt: addon.revocation.effectiveAt }),
      },
      executableStatus: addon.risk.executable ? 'quarantined-phase9' : 'declarative-only',
    })),
  });
}

function parseUpdate(value) {
  strictRecord(value, new Set([
    'wireVersion',
    'kind',
    'publisherId',
    'addonId',
    'version',
    'channel',
    'artifactKind',
    'artifactRef',
    'artifactSha256',
    'artifactSize',
    'manifestOrigin',
    'keyId',
    'sequence',
    'issuedAt',
    'expiresAt',
    'hostApiRange',
    'requiresRestart',
    'rollback',
    'review',
    'revocation',
    'signatureAlgorithm',
    'signature',
  ]), PluginMarketplaceContractError, 'A signed plugin update');
  if (value.wireVersion !== PLUGIN_MARKETPLACE_WIRE_VERSION) fail('UNSUPPORTED_VERSION', 'Unsupported update wire version.', '$.wireVersion');
  if (value.kind !== PLUGIN_PLUGIN_UPDATE_KIND) fail('INVALID_KIND', 'Unexpected plugin update kind.', '$.kind');
  const window = readTimeWindow(value.issuedAt, value.expiresAt, '$', PluginMarketplaceContractError, PLUGIN_UPDATE_MAX_LIFETIME_MS);
  const signature = readText(value.signature, '$.signature', PluginMarketplaceContractError, { maxLength: 512 });
  decodeEd25519Signature(signature, '$.signature');
  return {
    wireVersion: PLUGIN_MARKETPLACE_WIRE_VERSION,
    kind: PLUGIN_PLUGIN_UPDATE_KIND,
    publisherId: readReverseDnsId(value.publisherId, '$.publisherId', PluginMarketplaceContractError),
    addonId: readReverseDnsId(value.addonId, '$.addonId', PluginMarketplaceContractError),
    version: readSemVer(value.version, '$.version', PluginMarketplaceContractError),
    channel: readEnum(value.channel, PLUGIN_UPDATE_CHANNELS, '$.channel', PluginMarketplaceContractError, 'update channel'),
    artifactKind: readEnum(value.artifactKind, PLUGIN_UPDATE_ARTIFACT_KINDS, '$.artifactKind', PluginMarketplaceContractError, 'artifact kind'),
    artifactRef: readOpaqueReference(value.artifactRef, '$.artifactRef', PluginMarketplaceContractError),
    artifactSha256: readSha256(value.artifactSha256, '$.artifactSha256', PluginMarketplaceContractError),
    artifactSize: readInteger(value.artifactSize, '$.artifactSize', PluginMarketplaceContractError, { min: 1, max: 2_000_000_000 }),
    manifestOrigin: readPublicHttpsOrigin(value.manifestOrigin, '$.manifestOrigin', PluginMarketplaceContractError),
    keyId: readOpaqueReference(value.keyId, '$.keyId', PluginMarketplaceContractError),
    sequence: readInteger(value.sequence, '$.sequence', PluginMarketplaceContractError),
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    hostApiRange: readText(value.hostApiRange, '$.hostApiRange', PluginMarketplaceContractError, { maxLength: 128 }),
    requiresRestart: readBoolean(value.requiresRestart, '$.requiresRestart', PluginMarketplaceContractError),
    rollback: parseRollback(value.rollback, '$.rollback'),
    review: parseReview(value.review, '$.review'),
    revocation: parseRevocation(value.revocation, '$.revocation'),
    signatureAlgorithm: readEnum(value.signatureAlgorithm, ['ed25519'], '$.signatureAlgorithm', PluginMarketplaceContractError, 'signature algorithm'),
    signature,
  };
}

export function parseWirePluginUpdate(input) {
  return deepFreeze(parseUpdate(input));
}

export function verifyWirePluginUpdate(input, hostContext, verifiedAddon) {
  const update = parseUpdate(input);
  const context = requireMarketplaceContext(hostContext);
  const addon = readVerifiedMarketplaceAddon(verifiedAddon);
  if (addon.addonId !== update.addonId || addon.publisherId !== update.publisherId) fail('UPDATE_IDENTITY_MISMATCH', 'The update must match the host-verified marketplace add-on.', '$');
  if (addon.manifestOrigin !== update.manifestOrigin) fail('MANIFEST_ORIGIN_MISMATCH', 'The update manifest origin must match the verified add-on origin.', '$.manifestOrigin');
  if (context.isPublisherTrusted({ publisherId: update.publisherId }) !== true) fail('PUBLISHER_UNTRUSTED', 'The update publisher is not trusted.', '$.publisherId');
  if (context.now < update.issuedAt || context.now >= update.expiresAt) fail('UPDATE_EXPIRED', 'The signed update is outside its validity window.', '$');
  if (update.review.state !== 'approved' || update.review.expiresAt === undefined || context.now >= update.review.expiresAt) {
    fail('UPDATE_REVIEW_EXPIRED', 'The update does not have a current approved review.', '$.review');
  }
  if (update.revocation.state === 'revoked' && update.revocation.effectiveAt <= context.now) {
    fail('UPDATE_REVOKED', 'The update revocation is effective.', '$.revocation');
  }
  if (context.isHostApiRangeSupported({ range: update.hostApiRange }) !== true) {
    fail('HOST_API_INCOMPATIBLE', 'The update hostApiRange does not include the current host API.', '$.hostApiRange');
  }
  checkSequenceAndRollback(update, context);
  const key = resolveKey(context, update.publisherId, update.keyId, '$.keyId');
  verifySignature(context, key, update.signature, domainSeparatedSignedBytes('update', unsignedPayload(update)), '$.signature', 'plugin-update');
  const status = update.artifactKind === 'executable-plugin' ? 'quarantined-phase9' : 'verified';
  const verifiedUpdate = Object.freeze({
    wireVersion: update.wireVersion,
    kind: update.kind,
    addonId: update.addonId,
    publisherId: update.publisherId,
    version: update.version,
    channel: update.channel,
    artifactKind: update.artifactKind,
    artifactSize: update.artifactSize,
    artifactSha256: update.artifactSha256,
    issuedAt: update.issuedAt,
    expiresAt: update.expiresAt,
    requiresRestart: update.requiresRestart,
    status,
    installable: false,
    reasonCode: status === 'quarantined-phase9' ? 'PHASE9_SANDBOX_REQUIRED' : 'HOST_STAGING_REQUIRED',
  });
  verifiedUpdateRecords.set(verifiedUpdate, deepFreeze({ update, context, verifiedAddon }));
  return verifiedUpdate;
}

export function isVerifiedPluginUpdate(value) {
  return verifiedUpdateRecords.has(value);
}

export function createHostUpdateAuthorizationContext(input) {
  if (!isRecord(input)) fail('INVALID_TYPE', 'A host update authorization context must be an object.');
  if (typeof input.approveDeclarativeUpdate !== 'function') fail('INVALID_CONTEXT', 'Host update authorization must approve declarative staging.', '$.approveDeclarativeUpdate');
  const context = Object.freeze({ kind: 'host-update-authorization-context' });
  if (typeof input.now !== 'number' || !Number.isSafeInteger(input.now)) fail('INVALID_INTEGER', 'Host update authorization time must be an integer.', '$.now');
  updateContextRecords.set(context, deepFreeze({ ...input }));
  return context;
}

export function authorizeVerifiedPluginUpdate(verifiedUpdate, hostUpdateContext) {
  const record = verifiedUpdateRecords.get(verifiedUpdate);
  if (!record) fail('VERIFIED_UPDATE_REQUIRED', 'A host-verified update is required.');
  const context = updateContextRecords.get(hostUpdateContext);
  if (!context) fail('HOST_CONTEXT_REQUIRED', 'A host update authorization context is required.');
  if (record.update.artifactKind === 'executable-plugin') {
    fail('UPDATE_QUARANTINED_PHASE9', 'Executable artifact updates remain quarantined until the Phase 9 sandbox gate is approved.', '$.artifactKind');
  }
  if (record.update.review.state !== 'approved'
      || record.update.review.expiresAt === undefined
      || context.now >= record.update.review.expiresAt
      || (record.update.revocation.state === 'revoked' && record.update.revocation.effectiveAt <= context.now)) {
    fail('UPDATE_NOT_AUTHORIZABLE', 'Only approved and active declarative updates may reach host staging.', '$');
  }
  if (context.approveDeclarativeUpdate({ addonId: record.update.addonId, version: record.update.version, sequence: record.update.sequence }) !== true) {
    fail('UPDATE_NOT_APPROVED', 'The host did not approve declarative update staging.', '$');
  }
  return deepFreeze({
    kind: 'authorized-plugin-update',
    addonId: record.update.addonId,
    version: record.update.version,
    artifactKind: 'declarative-index',
    artifactSize: record.update.artifactSize,
    artifactSha256: record.update.artifactSha256,
    status: 'host-staging-approved',
    installable: false,
  });
}

export function projectPluginUpdateForRenderer(value) {
  const record = verifiedUpdateRecords.get(value);
  if (!record) fail('VERIFIED_UPDATE_REQUIRED', 'A host-verified update is required.');
  return deepFreeze({
    wireVersion: PLUGIN_MARKETPLACE_WIRE_VERSION,
    kind: PLUGIN_RENDERER_UPDATE_KIND,
    addonId: value.addonId,
    version: value.version,
    channel: value.channel,
    artifactKind: value.artifactKind,
    status: value.status,
    installable: false,
    reasonCode: value.reasonCode,
  });
}

function parseSignedCatalog(value) {
  strictRecord(value, new Set([
    'wireVersion',
    'kind',
    'publisherId',
    'addonId',
    'keyId',
    'sequence',
    'issuedAt',
    'expiresAt',
    'signatureAlgorithm',
    'signature',
    'rollback',
    'payload',
  ]), PluginMarketplaceContractError, 'A signed catalog envelope');
  if (value.wireVersion !== 2) fail('UNSUPPORTED_VERSION', 'Unsupported signed catalog wire version.', '$.wireVersion');
  if (value.kind !== 'signed-catalog') fail('INVALID_KIND', 'Unexpected signed catalog kind.', '$.kind');
  const window = readTimeWindow(value.issuedAt, value.expiresAt, '$', PluginMarketplaceContractError, 24 * 60 * 60 * 1_000);
  const signature = readText(value.signature, '$.signature', PluginMarketplaceContractError, { maxLength: 512 });
  decodeEd25519Signature(signature, '$.signature');
  return {
    wireVersion: 2,
    kind: 'signed-catalog',
    publisherId: readReverseDnsId(value.publisherId, '$.publisherId', PluginMarketplaceContractError),
    addonId: readReverseDnsId(value.addonId, '$.addonId', PluginMarketplaceContractError),
    keyId: readOpaqueReference(value.keyId, '$.keyId', PluginMarketplaceContractError),
    sequence: readInteger(value.sequence, '$.sequence', PluginMarketplaceContractError),
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    signatureAlgorithm: readEnum(value.signatureAlgorithm, ['ed25519'], '$.signatureAlgorithm', PluginMarketplaceContractError, 'signature algorithm'),
    signature,
    rollback: parseRollback(value.rollback, '$.rollback'),
    payload: parseWireCatalogResult(value.payload),
  };
}

export function parseWireSignedCatalog(input) {
  const catalog = deepFreeze(parseSignedCatalog(input));
  parsedSignedCatalogRecords.add(catalog);
  return catalog;
}

export function verifyWireSignedCatalog(input, hostContext, verifiedAddon) {
  const catalog = parsedSignedCatalogRecords.has(input) ? input : parseSignedCatalog(input);
  const context = requireMarketplaceContext(hostContext);
  const addon = readVerifiedMarketplaceAddon(verifiedAddon);
  if (catalog.publisherId !== addon.publisherId || catalog.addonId !== addon.addonId || catalog.payload.addonId !== addon.addonId) {
    fail('CATALOG_IDENTITY_MISMATCH', 'The signed catalog must match the verified marketplace add-on and publisher.', '$');
  }
  if (!addon.catalogs.some((membership) => membership.type === catalog.payload.catalogType && membership.id === catalog.payload.catalogId)) {
    fail('CATALOG_NOT_DECLARED', 'The signed catalog is not a declared add-on catalog membership.', '$.payload');
  }
  if (context.isPublisherTrusted({ publisherId: catalog.publisherId }) !== true) fail('PUBLISHER_UNTRUSTED', 'The catalog publisher is not trusted.', '$.publisherId');
  if (context.now < catalog.issuedAt || context.now >= catalog.expiresAt) fail('CATALOG_EXPIRED', 'The signed catalog is outside its validity window.', '$');
  checkSequenceAndRollback(catalog, context);
  const key = resolveKey(context, catalog.publisherId, catalog.keyId, '$.keyId');
  verifySignature(context, key, catalog.signature, domainSeparatedSignedBytes('catalog', signedCatalogPayload(catalog)), '$.signature', 'signed-catalog');
  const verified = Object.freeze({
    wireVersion: 2,
    kind: 'signed-catalog',
    publisherId: catalog.publisherId,
    addonId: catalog.addonId,
    sequence: catalog.sequence,
    issuedAt: catalog.issuedAt,
    expiresAt: catalog.expiresAt,
    payload: catalog.payload,
  });
  verifiedCatalogRecords.set(verified, deepFreeze({ catalog, verifiedAddon }));
  return verified;
}

export function isVerifiedSignedCatalog(value) {
  return verifiedCatalogRecords.has(value);
}

export function projectSignedCatalogForRenderer(value) {
  const record = verifiedCatalogRecords.get(value);
  if (!record) fail('VERIFIED_CATALOG_REQUIRED', 'A host-verified catalog is required.');
  return deepFreeze({
    wireVersion: 2,
    kind: 'signed-catalog-renderer',
    addonId: value.addonId,
    catalogType: value.payload.catalogType,
    catalogId: value.payload.catalogId,
    revision: value.payload.revision,
    items: value.payload.items,
  });
}

export function signedPayloadJson(value) {
  const parsed = value?.kind === PLUGIN_PLUGIN_UPDATE_KIND
    ? parseUpdate(value)
    : value?.kind === 'signed-catalog'
      ? parseSignedCatalog(value)
      : parseIndex(value);
  return canonicalizeJcs(parsed.kind === 'signed-catalog' ? signedCatalogPayload(parsed) : unsignedPayload(parsed));
}
