import assert from 'node:assert/strict';
import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  authorizeVerifiedSearchRequest,
  authorizeVerifiedPlaybackTicketRequest,
  createHostOnlyAuthorizationContext,
  createHostPlaybackTicket,
  createPlaybackProxyPlan,
  createPluginSearchNamespace,
  namespacePluginCatalogItem,
  parseWirePlaybackTicketRequest,
  parseWireSearchRequest,
  verifyWirePlaybackTicketRequest,
  verifyWireSearchRequest,
  verifyWireSubtitleAttachmentRequest,
} from '../src/downstream.mjs';
import {
  createHostRuntimeLease,
  isReadyHostRuntimeLease,
  transitionHostRuntimeLease,
} from '../src/runtime-lifecycle.mjs';
import {
  authorizeVerifiedPluginUpdate,
  createHostMarketplaceVerificationContext,
  createHostUpdateAuthorizationContext,
  parseWireSignedCatalog,
  projectMarketplaceIndexForRenderer,
  projectSignedCatalogForRenderer,
  projectPluginUpdateForRenderer,
  verifyWireMarketplaceIndex,
  verifyWireSignedCatalog,
  verifyWirePluginUpdate,
} from '../src/marketplace.mjs';
import {
  canonicalPluginItemKey,
  migrateLegacyCatalogItemIdentity,
  parseWireCatalogResult,
} from '../src/identity.mjs';
import {
  PLUGIN_SIGNING_TEST_VECTORS,
  bytesToHex,
  canonicalizeJcs,
  decodeEd25519PublicKey,
  decodeEd25519Signature,
  domainSeparatedSignedBytes,
  encodeBase64Url,
  hexToBytes,
} from '../src/signed-bytes.mjs';

const zeroSignature = encodeBase64Url(new Uint8Array(64));
const zeroPublicKey = encodeBase64Url(new Uint8Array(32));

function hasIssueCode(code) {
  return (error) => Array.isArray(error?.issues)
    && error.issues.some((issue) => issue.code === code);
}

function marketplaceIndex() {
  return {
    wireVersion: 1,
    kind: 'plugin-marketplace-index',
    indexId: 'index-1',
    sequence: 1,
    issuedAt: 100,
    expiresAt: 200,
    publisherId: 'publisher.example',
    publisherKeyId: 'key-1',
    rollback: { allowed: false, minimumSequence: 1, requiresHostApproval: true },
    addons: [{
      addonId: 'addon.example',
      publisherId: 'publisher.example',
      name: 'Example add-on',
      version: '1.0.0',
      manifestOrigin: 'https://addons.example',
      capabilities: ['metadata.catalog', 'subtitle.provider', 'playback.provider'],
      catalogs: [{ type: 'movie', id: 'catalog', name: 'Movies' }],
      risk: {
        level: 'medium',
        network: true,
        metadata: true,
        subtitle: true,
        playback: true,
        artwork: false,
        profile: false,
        executable: false,
        updates: false,
      },
      review: { state: 'approved', reviewedAt: 100, reviewerRef: 'review-1', expiresAt: 200 },
      revocation: { state: 'active' },
      rollback: { allowed: false, minimumSequence: 1, requiresHostApproval: true },
    }],
    signatureAlgorithm: 'ed25519',
    signature: zeroSignature,
  };
}

function hostMarketplaceContext() {
  return createHostMarketplaceVerificationContext({
    now: 150,
    resolvePublisherKey: () => ({ publicKey: zeroPublicKey }),
    verifySignature: () => true,
    isPublisherTrusted: () => true,
    isHostApiRangeSupported: ({ range }) => range === '^1.0.0',
  });
}

function verifiedAddon() {
  return verifyWireMarketplaceIndex(marketplaceIndex(), hostMarketplaceContext()).addons[0];
}

function hostAuthorizationContext() {
  return createHostOnlyAuthorizationContext({
    deviceRef: 'device-1',
    profileId: 'profile-1',
    selectionRevision: 7,
    authorizationEpoch: 11,
    revocationEpoch: 3,
    now: 150,
    isAuthorizationCurrent: (binding) => binding.authorizationEpoch === 11 && binding.revocationEpoch === 3,
    isAddonCurrentlyAuthorized: ({ addonId }) => addonId === 'addon.example',
    allowedAddons: [{
      addonId: 'addon.example',
      capabilities: ['metadata.catalog', 'subtitle.provider', 'playback.provider'],
    }],
  });
}

test('catalog item namespaces pick only namespace fields and retain strict validation', () => {
  const input = { addonId: 'addon.example', catalogType: 'movie', catalogId: 'popular', type: 'movie', providerId: 'tt123' };
  const item = namespacePluginCatalogItem(input);
  assert.equal(item.namespaceKey, createPluginSearchNamespace({ addonId: input.addonId, catalogType: input.catalogType, catalogId: input.catalogId }).namespaceKey);
  assert.equal(item.itemKey, namespacePluginCatalogItem({ ...input, catalogId: 'search' }).itemKey);
  assert.notEqual(item.itemKey, namespacePluginCatalogItem({ ...input, addonId: 'other.example' }).itemKey);
  assert.equal(item.providerId, 'tt123');
  assert.equal(Object.isFrozen(item), true);
  assert.throws(() => createPluginSearchNamespace(input), /Unknown fields/);
  assert.throws(() => namespacePluginCatalogItem({ ...input, unexpected: true }), /Unknown fields/);
  assert.throws(() => namespacePluginCatalogItem({ ...input, providerId: '' }));
});

test('JCS sorts numeric-looking keys recursively without changing array order', () => {
  const value = { 2: 'two', 10: 'ten', nested: [{ 2: false, 10: null }, 3, 1], '01': -0 };
  const expected = '{"01":0,"10":"ten","2":"two","nested":[{"10":null,"2":false},3,1]}';
  assert.equal(canonicalizeJcs(value), expected);
  assert.equal(new TextDecoder().decode(domainSeparatedSignedBytes('catalog', value)), `LoomTV-Plugin-Signature/v1\u0000catalog\u0000${expected}`);
  assert.equal(canonicalizeJcs(JSON.parse('{"__proto__":{"2":2,"10":10}}')), '{"__proto__":{"10":10,"2":2}}');
  assert.equal(canonicalizeJcs({ '\u20ac': 1, '\r': 2, '\ufb33': 3, '1': 4, '\ud83d\ude00': 5, '\u0080': 6, '\u00f6': 7 }), '{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}');
  assert.equal(canonicalizeJcs(JSON.parse('[333333333.33333329, 1e30, 4.50, 2e-3, 1e-27, -0]')), '[333333333.3333333,1e+30,4.5,0.002,1e-27,0]');
});

test('JCS retains JSON value constraints and rejects trailing lone surrogates', () => {
  for (const value of [NaN, Infinity, undefined, 1n, new Date(), { a: undefined }, [undefined], Array(1), { [Symbol('key')]: 1 }, '\ud800', '\udc00', { ['bad\ud800']: 1 }]) {
    assert.throws(() => canonicalizeJcs(value));
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeJcs(cyclic), hasIssueCode('CYCLIC_VALUE'));
  const extraArray = [1];
  extraArray.extra = 2;
  assert.throws(() => canonicalizeJcs(extraArray), hasIssueCode('INVALID_ARRAY'));
  const shared = { 10: 10, 2: 2 };
  assert.equal(canonicalizeJcs([shared, shared]), '[{"10":10,"2":2},{"10":10,"2":2}]');
});

test('wire search DTOs round-trip without host claims', () => {
  const wire = parseWireSearchRequest({
    wireVersion: 2,
    kind: 'plugin-search-request',
    transport: 'host-mediated',
    addonId: 'addon.example',
    catalogType: 'movie',
    catalogId: 'catalog',
    query: 'alpha',
    page: 0,
    limit: 25,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(wire)), wire);
  const verified = verifyWireSearchRequest(wire, verifiedAddon());
  assert.throws(() => authorizeVerifiedSearchRequest(verified), /host-owned authorization context/);
  const authorized = authorizeVerifiedSearchRequest(verified, hostAuthorizationContext());
  assert.equal(authorized.binding.selectionRevision, 7);
  assert.equal(Object.hasOwn(authorized, 'authorization'), false);
  assert.equal(Object.hasOwn(authorized, 'revalidation'), false);
});

test('wire parsers reject caller identity claims and raw transport fields', () => {
  const base = {
    wireVersion: 2,
    kind: 'playback-ticket-request',
    transport: 'host-mediated',
    addonId: 'addon.example',
    requestRef: 'request-1',
    mediaRef: 'media-1',
    sourceRef: 'source-1',
    sourceKind: 'https-media',
    requestedModes: ['direct-proxy'],
  };
  for (const field of ['profile', 'authorization', 'revalidation', 'deviceRef', 'url', 'path', 'command', 'executable']) {
    assert.throws(() => parseWirePlaybackTicketRequest({ ...base, [field]: field === 'profile' ? {} : 'claim' }), /host-only or raw transport field|Unknown fields/);
  }
  assert.throws(() => parseWireSearchRequest({
    wireVersion: 2,
    kind: 'plugin-search-request',
    transport: 'host-mediated',
    addonId: 'addon.example',
    catalogType: 'movie',
    catalogId: 'catalog',
    query: 'x',
    page: 0,
    limit: 10,
    profile: { profileId: 'caller-claim' },
  }), /host-only or raw transport field/);
});

test('subtitle and playback verification require marketplace capabilities', () => {
  const addon = verifiedAddon();
  const subtitle = verifyWireSubtitleAttachmentRequest({
    wireVersion: 2,
    kind: 'subtitle-attachment-request',
    transport: 'host-mediated',
    addonId: 'addon.example',
    requestRef: 'request-2',
    mediaRef: 'media-1',
    subtitleRef: 'subtitle-1',
    language: 'en',
    format: 'vtt',
  }, addon);
  const playback = verifyWirePlaybackTicketRequest({
    wireVersion: 2,
    kind: 'playback-ticket-request',
    transport: 'host-mediated',
    addonId: 'addon.example',
    requestRef: 'request-3',
    mediaRef: 'media-1',
    sourceRef: 'source-1',
    sourceKind: 'hls',
    requestedModes: ['hls-proxy'],
  }, addon);
  assert.equal(subtitle.kind, 'verified-subtitle-attachment-request');
  assert.equal(playback.kind, 'verified-playback-ticket-request');
});

test('future playback tickets require the corrected ready runtime lifecycle', () => {
  const playback = verifyWirePlaybackTicketRequest({
    wireVersion: 2,
    kind: 'playback-ticket-request',
    transport: 'host-mediated',
    addonId: 'addon.example',
    requestRef: 'request-4',
    mediaRef: 'media-1',
    sourceRef: 'source-1',
    sourceKind: 'https-media',
    requestedModes: ['direct-proxy'],
  }, verifiedAddon());
  const authorized = authorizeVerifiedPlaybackTicketRequest(playback, hostAuthorizationContext());
  const plan = createPlaybackProxyPlan(authorized);
  let lease = createHostRuntimeLease({ addonId: 'addon.example', runtimeId: 'runtime-1', state: 'absent', lifecycleEpoch: 0, authorizationEpoch: 11, revocationEpoch: 3 });
  lease = transitionHostRuntimeLease(lease, 'starting');
  assert.equal(isReadyHostRuntimeLease(lease), false);
  assert.throws(() => createHostPlaybackTicket(authorized, lease, { ticketRef: 'ticket-1', issuedAt: 150, expiresAt: 200 }), hasIssueCode('RUNTIME_NOT_READY'));
  lease = transitionHostRuntimeLease(lease, 'ready');
  assert.equal(isReadyHostRuntimeLease(lease), true);
  const ticket = createHostPlaybackTicket(authorized, lease, { ticketRef: 'ticket-1', issuedAt: 150, expiresAt: 200 });
  assert.equal(ticket.proxyPolicy.hostResolvesDestination, true);
  assert.equal(Object.hasOwn(ticket, 'url'), false);
  assert.equal(plan.rawUrlAllowed, false);
  assert.equal(ticket.runtimeBinding.lifecycleEpoch, lease.lifecycleEpoch);

  let otherLease = createHostRuntimeLease({ addonId: 'other.example', runtimeId: 'runtime-2', state: 'absent', lifecycleEpoch: 0, authorizationEpoch: 11, revocationEpoch: 3 });
  otherLease = transitionHostRuntimeLease(transitionHostRuntimeLease(otherLease, 'starting'), 'ready');
  assert.throws(() => createHostPlaybackTicket(authorized, otherLease, { ticketRef: 'ticket-2', issuedAt: 150, expiresAt: 200 }), hasIssueCode('RUNTIME_ADDON_MISMATCH'));
  const staleLease = lease;
  lease = transitionHostRuntimeLease(lease, 'draining');
  assert.throws(() => createHostPlaybackTicket(authorized, staleLease, { ticketRef: 'ticket-3', issuedAt: 150, expiresAt: 200 }), hasIssueCode('RUNTIME_NOT_READY'));
});

test('catalog identity is stable across memberships and legacy migration is explicit', () => {
  const first = migrateLegacyCatalogItemIdentity({ pluginId: 'addon.example', catalogType: 'movie', catalogId: 'one', itemId: 'provider-42' });
  const second = migrateLegacyCatalogItemIdentity({ pluginId: 'addon.example', catalogType: 'movie', catalogId: 'two', itemId: 'provider-42' });
  assert.equal(first.canonicalKey, second.canonicalKey);
  assert.equal(first.legacyKey, second.legacyKey);
  assert.equal(first.legacyKey, 'bG9vbXR2LXN0cmVtaW8taXRlbS12MQ.YWRkb24uZXhhbXBsZQ.bW92aWU.cHJvdmlkZXItNDI');
  assert.equal(first.identity.addonId, 'addon.example');
  assert.equal(first.identity.providerId, 'provider-42');
  assert.equal(canonicalPluginItemKey(first.identity), first.canonicalKey);
  assert.equal(first.canonicalKey.startsWith('loom-plugin:item:v1:'), true);
  assert.equal(first.canonicalKey.startsWith('loom-plugin%3Aitem%3Av1'), false);

  const catalogOne = parseWireCatalogResult({
    wireVersion: 1,
    kind: 'plugin-catalog-result',
    addonId: 'addon.example',
    catalogType: 'movie',
    catalogId: 'one',
    revision: 1,
    items: [{
      identity: { wireVersion: 1, kind: 'plugin-item-identity', addonId: 'addon.example', type: 'movie', providerId: 'provider-42' },
      membership: { wireVersion: 1, kind: 'catalog-membership', catalogType: 'movie', catalogId: 'one' },
      title: 'Movie',
    }],
  });
  assert.equal(catalogOne.items[0].itemKey, first.canonicalKey);
  assert.throws(() => parseWireCatalogResult({
    wireVersion: 1,
    kind: 'plugin-catalog-result',
    addonId: 'addon.example',
    catalogType: 'movie',
    catalogId: 'one',
    revision: 1,
    items: [{
      identity: { wireVersion: 1, kind: 'plugin-item-identity', addonId: 'other.example', type: 'movie', providerId: 'provider-42' },
      membership: { wireVersion: 1, kind: 'catalog-membership', catalogType: 'movie', catalogId: 'one' },
      title: 'Movie',
    }],
  }), /IDENTITY_MISMATCH|identity addonId/);
});

test('signed-byte vectors are exact and reject non-64-byte signatures', () => {
  const vector = PLUGIN_SIGNING_TEST_VECTORS.find((entry) => entry.name === 'jcs-domain-separated-catalog-object');
  assert.equal(bytesToHex(domainSeparatedSignedBytes(vector.domain, vector.payload)), vector.signedBytesHex);
  assert.equal(decodeEd25519Signature(PLUGIN_SIGNING_TEST_VECTORS[0].signatureBase64Url).byteLength, 64);
  assert.throws(() => decodeEd25519Signature(encodeBase64Url(new Uint8Array(63))), /exactly 64 bytes/);
  assert.throws(() => decodeEd25519Signature(encodeBase64Url(new Uint8Array(65))), /exactly 64 bytes/);
  assert.equal(hexToBytes(PLUGIN_SIGNING_TEST_VECTORS[0].publicKeyHex).byteLength, 32);
  assert.equal(decodeEd25519PublicKey(PLUGIN_SIGNING_TEST_VECTORS[0].publicKeyBase64Url).byteLength, 32);
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(PLUGIN_SIGNING_TEST_VECTORS[0].publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
  assert.equal(verifyEd25519(null, Buffer.alloc(0), publicKey, Buffer.from(PLUGIN_SIGNING_TEST_VECTORS[0].signatureHex, 'hex')), true);
});

test('renderer projections omit marketplace signing and origin details', () => {
  const verified = verifyWireMarketplaceIndex(marketplaceIndex(), hostMarketplaceContext());
  const projection = projectMarketplaceIndexForRenderer(verified);
  assert.equal(Object.hasOwn(projection, 'publisherId'), false);
  assert.equal(Object.hasOwn(projection.addons[0], 'publisherId'), false);
  assert.equal(Object.hasOwn(projection.addons[0], 'manifestOrigin'), false);
  assert.equal(Object.hasOwn(projection.addons[0], 'rollback'), false);
  assert.equal(Object.hasOwn(projection.addons[0], 'keyTransition'), false);
  assert.equal(Object.isFrozen(verified.addons[0].review), true);
  assert.throws(() => { verified.addons[0].review.state = 'rejected'; }, TypeError);
});

test('signed catalogs bind the verified add-on while keeping derived item keys out of signed bytes', () => {
  const signed = parseWireSignedCatalog({
    wireVersion: 2,
    kind: 'signed-catalog',
    publisherId: 'publisher.example',
    addonId: 'addon.example',
    keyId: 'key-1',
    sequence: 1,
    issuedAt: 100,
    expiresAt: 200,
    signatureAlgorithm: 'ed25519',
    signature: zeroSignature,
    rollback: { allowed: false, minimumSequence: 1, requiresHostApproval: true },
    payload: {
      wireVersion: 1,
      kind: 'plugin-catalog-result',
      addonId: 'addon.example',
      catalogType: 'movie',
      catalogId: 'catalog',
      revision: 1,
      items: [{
        identity: { wireVersion: 1, kind: 'plugin-item-identity', addonId: 'addon.example', type: 'movie', providerId: 'provider-42' },
        membership: { wireVersion: 1, kind: 'catalog-membership', catalogType: 'movie', catalogId: 'catalog' },
        title: 'Movie',
      }],
    },
  });
  const verified = verifyWireSignedCatalog(signed, hostMarketplaceContext(), verifiedAddon());
  const projection = projectSignedCatalogForRenderer(verified);
  assert.equal(projection.items[0].itemKey.startsWith('loom-plugin:item:v1:'), true);
  assert.equal(Object.hasOwn(projection, 'signature'), false);
});

test('executable updates remain quarantined after signature verification', () => {
  const addon = verifiedAddon();
  const update = {
    wireVersion: 1,
    kind: 'plugin-update',
    publisherId: 'publisher.example',
    addonId: 'addon.example',
    version: '1.1.0',
    channel: 'stable',
    artifactKind: 'executable-plugin',
    artifactRef: 'artifact-1',
    artifactSha256: 'a'.repeat(64),
    artifactSize: 100,
    manifestOrigin: 'https://addons.example',
    keyId: 'key-1',
    sequence: 2,
    issuedAt: 100,
    expiresAt: 200,
    hostApiRange: '^1.0.0',
    requiresRestart: true,
    rollback: { allowed: false, minimumSequence: 2, requiresHostApproval: true },
    review: { state: 'approved', reviewedAt: 100, reviewerRef: 'review-1', expiresAt: 200 },
    revocation: { state: 'active' },
    signatureAlgorithm: 'ed25519',
    signature: zeroSignature,
  };
  const verified = verifyWirePluginUpdate(update, hostMarketplaceContext(), addon);
  assert.equal(verified.status, 'quarantined-phase9');
  assert.equal(verified.installable, false);
  assert.equal(projectPluginUpdateForRenderer(verified).artifactKind, 'executable-plugin');
  assert.throws(
    () => authorizeVerifiedPluginUpdate(verified, createHostUpdateAuthorizationContext({ now: 150, approveDeclarativeUpdate: () => true })),
    hasIssueCode('UPDATE_QUARANTINED_PHASE9'),
  );
});

test('v2 schema covers normalized output receipts, tickets, and optional defaulted request fields', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/plugin-downstream.v2.schema.json', import.meta.url), 'utf8'));
  const refs = schema.oneOf.map((entry) => entry.$ref);
  assert.equal(refs.includes('#/$defs/subtitleReceipt'), true);
  assert.equal(refs.includes('#/$defs/playbackTicket'), true);
  assert.equal(schema.$defs.searchRequest.required.includes('query'), false);
  assert.equal(schema.$defs.playbackRequest.required.includes('requestedModes'), false);
  assert.equal(schema.$defs.hostParity.properties.surfaces.allOf.length, 8);
});
