/**
 * Provider-owned item identity for downstream catalog/search contracts.
 *
 * `addonId`, content `type`, and provider-owned `providerId` are the stable
 * identity. A catalog is only membership metadata; it must never be part of
 * the item key. The migration helper preserves the old catalog-scoped key so
 * callers can move persisted references without silently merging records.
 */

import {
  deepFreeze,
  failWith,
  isRecord,
  makeIssue,
  readInteger,
  readOpaqueReference,
  readReverseDnsId,
  readStringArray,
  readText,
  rejectForbiddenWireFields,
  strictRecord,
} from './validation.mjs';
import { encodeBase64Url } from './signed-bytes.mjs';

export const PLUGIN_ITEM_IDENTITY_VERSION = 1;
export const PLUGIN_ITEM_IDENTITY_KIND = 'plugin-item-identity';
export const PLUGIN_CATALOG_MEMBERSHIP_KIND = 'catalog-membership';
export const PLUGIN_CATALOG_RESULT_KIND = 'plugin-catalog-result';
export const PLUGIN_ITEM_KEY_PREFIX = 'loom-plugin:item:v1';
export const LEGACY_STREMIO_ITEM_KEY_PREFIX = 'loomtv-stremio-item-v1';

class PluginIdentityError extends Error {
  constructor(issues) {
    const normalizedIssues = Object.freeze(issues.map((entry) => Object.freeze({ ...entry })));
    const detail = normalizedIssues.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
    super(`Invalid plugin item identity${detail ? `: ${detail}` : '.'}`);
    this.name = 'PluginIdentityError';
    this.code = 'PLUGIN_IDENTITY_INVALID';
    this.issues = normalizedIssues;
  }
}

export { PluginIdentityError };

function identityPart(value, path) {
  return readText(value, path, PluginIdentityError, { maxLength: 512 });
}

function parseIdentityRecord(value, path = '$') {
  if (!isRecord(value)) failWith(PluginIdentityError, 'INVALID_TYPE', 'An item identity must be an object.', path);
  rejectForbiddenWireFields(value, path, PluginIdentityError);
  const allowed = new Set(['wireVersion', 'kind', 'addonId', 'type', 'providerId']);
  const issues = [];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(makeIssue(`${path}.${key}`, 'unknown_field', 'Unknown identity fields are not supported.'));
  }
  if (issues.length > 0) throw new PluginIdentityError(issues);
  if (value.wireVersion !== PLUGIN_ITEM_IDENTITY_VERSION) failWith(PluginIdentityError, 'UNSUPPORTED_VERSION', 'Unsupported item identity wire version.', `${path}.wireVersion`);
  if (value.kind !== PLUGIN_ITEM_IDENTITY_KIND) failWith(PluginIdentityError, 'INVALID_KIND', 'Unexpected item identity kind.', `${path}.kind`);
  return {
    wireVersion: PLUGIN_ITEM_IDENTITY_VERSION,
    kind: PLUGIN_ITEM_IDENTITY_KIND,
    addonId: readReverseDnsId(value.addonId, `${path}.addonId`, PluginIdentityError),
    type: identityPart(value.type, `${path}.type`),
    providerId: identityPart(value.providerId, `${path}.providerId`),
  };
}

export function parseWirePluginItemIdentity(input) {
  return deepFreeze(parseIdentityRecord(input));
}

export function createPluginItemIdentity(input) {
  if (!isRecord(input)) failWith(PluginIdentityError, 'INVALID_TYPE', 'An item identity must be an object.');
  return deepFreeze({
    wireVersion: PLUGIN_ITEM_IDENTITY_VERSION,
    kind: PLUGIN_ITEM_IDENTITY_KIND,
    addonId: readReverseDnsId(input.addonId, '$.addonId', PluginIdentityError),
    type: identityPart(input.type, '$.type'),
    providerId: identityPart(input.providerId, '$.providerId'),
  });
}

export function canonicalPluginItemKey(input) {
  const identity = input?.kind === PLUGIN_ITEM_IDENTITY_KIND ? parseIdentityRecord(input) : createPluginItemIdentity(input);
  return `${PLUGIN_ITEM_KEY_PREFIX}:${[identity.addonId, identity.type, identity.providerId]
    .map((part) => encodeURIComponent(part))
    .join(':')}`;
}

function legacyStremioKey(addonId, type, providerId) {
  const encodePart = (value) => encodeBase64Url(new TextEncoder().encode(value));
  return [LEGACY_STREMIO_ITEM_KEY_PREFIX, addonId, type, providerId].map(encodePart).join('.');
}

function parseMembershipRecord(value, path = '$') {
  if (!isRecord(value)) failWith(PluginIdentityError, 'INVALID_TYPE', 'A catalog membership must be an object.', path);
  rejectForbiddenWireFields(value, path, PluginIdentityError);
  strictRecord(value, new Set(['wireVersion', 'kind', 'catalogType', 'catalogId']), PluginIdentityError, 'A catalog membership');
  if (value.wireVersion !== PLUGIN_ITEM_IDENTITY_VERSION) failWith(PluginIdentityError, 'UNSUPPORTED_VERSION', 'Unsupported catalog membership wire version.', `${path}.wireVersion`);
  if (value.kind !== PLUGIN_CATALOG_MEMBERSHIP_KIND) failWith(PluginIdentityError, 'INVALID_KIND', 'Unexpected catalog membership kind.', `${path}.kind`);
  return {
    wireVersion: PLUGIN_ITEM_IDENTITY_VERSION,
    kind: PLUGIN_CATALOG_MEMBERSHIP_KIND,
    catalogType: identityPart(value.catalogType, `${path}.catalogType`),
    catalogId: identityPart(value.catalogId, `${path}.catalogId`),
  };
}

export function parseWireCatalogMembership(input) {
  return deepFreeze(parseMembershipRecord(input));
}

function parseCatalogItem(value, path, addonId, catalogType, catalogId) {
  strictRecord(value, new Set([
    'identity',
    'membership',
    'title',
    'description',
    'releaseInfo',
    'released',
    'rating',
    'runtime',
    'year',
    'genres',
    'artworkRef',
  ]), PluginIdentityError, 'A catalog item', { rejectWireClaims: true });
  const identity = parseIdentityRecord(value.identity, `${path}.identity`);
  const membership = parseMembershipRecord(value.membership, `${path}.membership`);
  if (identity.addonId !== addonId) failWith(PluginIdentityError, 'IDENTITY_MISMATCH', 'Item identity addonId must match the catalog result.', `${path}.identity.addonId`);
  if (membership.catalogType !== catalogType || membership.catalogId !== catalogId) {
    failWith(PluginIdentityError, 'MEMBERSHIP_MISMATCH', 'Catalog membership must match the containing catalog.', `${path}.membership`);
  }
  const rating = value.rating === undefined ? undefined : Number(value.rating);
  if (rating !== undefined && (!Number.isFinite(rating) || rating < 0 || rating > 10)) {
    failWith(PluginIdentityError, 'INVALID_VALUE', 'Catalog ratings must be between 0 and 10.', `${path}.rating`);
  }
  const year = value.year === undefined ? undefined : readInteger(value.year, `${path}.year`, PluginIdentityError, { max: 100_000 });
  const optionalText = (key, maxLength) => value[key] === undefined ? undefined : readText(value[key], `${path}.${key}`, PluginIdentityError, { maxLength });
  const description = optionalText('description', 2_000);
  const releaseInfo = optionalText('releaseInfo', 128);
  const released = optionalText('released', 128);
  const runtime = optionalText('runtime', 64);
  const artworkRef = value.artworkRef === undefined ? undefined : readOpaqueReference(value.artworkRef, `${path}.artworkRef`, PluginIdentityError);
  const genres = value.genres === undefined ? undefined : readStringArray(value.genres, `${path}.genres`, PluginIdentityError, { maxItems: 32, maxLength: 128 });
  return {
    identity,
    membership,
    itemKey: canonicalPluginItemKey(identity),
    title: readText(value.title, `${path}.title`, PluginIdentityError, { maxLength: 512 }),
    ...(description === undefined ? {} : { description }),
    ...(releaseInfo === undefined ? {} : { releaseInfo }),
    ...(released === undefined ? {} : { released }),
    ...(rating === undefined ? {} : { rating }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(year === undefined ? {} : { year }),
    ...(genres === undefined ? {} : { genres }),
    ...(artworkRef === undefined ? {} : { artworkRef }),
  };
}

export function parseWireCatalogResult(input) {
  strictRecord(input, new Set(['wireVersion', 'kind', 'addonId', 'catalogType', 'catalogId', 'revision', 'items']), PluginIdentityError, 'A plugin catalog result', { rejectWireClaims: true });
  if (input.wireVersion !== PLUGIN_ITEM_IDENTITY_VERSION) failWith(PluginIdentityError, 'UNSUPPORTED_VERSION', 'Unsupported catalog result wire version.', '$.wireVersion');
  if (input.kind !== PLUGIN_CATALOG_RESULT_KIND) failWith(PluginIdentityError, 'INVALID_KIND', 'Unexpected catalog result kind.', '$.kind');
  const addonId = readReverseDnsId(input.addonId, '$.addonId', PluginIdentityError);
  const catalogType = identityPart(input.catalogType, '$.catalogType');
  const catalogId = identityPart(input.catalogId, '$.catalogId');
  const revision = readInteger(input.revision, '$.revision', PluginIdentityError);
  if (!Array.isArray(input.items) || input.items.length > 1_000) failWith(PluginIdentityError, 'INVALID_ARRAY', 'Catalog results must contain at most 1,000 items.', '$.items');
  return deepFreeze({
    wireVersion: PLUGIN_ITEM_IDENTITY_VERSION,
    kind: PLUGIN_CATALOG_RESULT_KIND,
    addonId,
    catalogType,
    catalogId,
    revision,
    items: input.items.map((item, index) => parseCatalogItem(item, `$.items[${index}]`, addonId, catalogType, catalogId)),
  });
}

export function migrateLegacyCatalogItemIdentity(input) {
  strictRecord(input, new Set(['pluginId', 'catalogType', 'catalogId', 'itemId']), PluginIdentityError, 'A legacy catalog item identity');
  const addonId = readReverseDnsId(input.pluginId, '$.pluginId', PluginIdentityError);
  const catalogType = identityPart(input.catalogType, '$.catalogType');
  const catalogId = identityPart(input.catalogId, '$.catalogId');
  const providerId = identityPart(input.itemId, '$.itemId');
  const identity = createPluginItemIdentity({ addonId, type: catalogType, providerId });
  const membership = parseMembershipRecord({
    wireVersion: PLUGIN_ITEM_IDENTITY_VERSION,
    kind: PLUGIN_CATALOG_MEMBERSHIP_KIND,
    catalogType,
    catalogId,
  });
  const legacyKey = legacyStremioKey(addonId, catalogType, providerId);
  return deepFreeze({
    migrationVersion: 1,
    legacyKey,
    canonicalKey: canonicalPluginItemKey(identity),
    identity,
    membership,
  });
}
