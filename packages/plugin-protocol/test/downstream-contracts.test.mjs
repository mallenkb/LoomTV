import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorizeVerifiedSearchRequest,
  authorizeVerifiedPlaybackTicketRequest,
  createHostOnlyAuthorizationContext,
  createHostPlaybackTicket,
  createPlaybackProxyPlan,
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
  parseWireMarketplaceIndex,
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
  decodeEd25519PublicKey,
  decodeEd25519Signature,
  domainSeparatedSignedBytes,
  encodeBase64Url,
  hexToBytes,
} from '../src/signed-bytes.mjs';

const zeroSignature = encodeBase64Url(new Uint8Array(64));
const zeroPublicKey = encodeBase64Url(new Uint8Array(32));

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
    now: 150,
    allowedAddons: [{
      addonId: 'addon.example',
      capabilities: ['metadata.catalog', 'subtitle.provider', 'playback.provider'],
    }],
  });
}

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
  let lease = createHostRuntimeLease({ addonId: 'addon.example', runtimeId: 'runtime-1', state: 'absent', lifecycleEpoch: 0 });
  lease = transitionHostRuntimeLease(lease, 'starting');
  assert.equal(isReadyHostRuntimeLease(lease), false);
  assert.throws(() => createHostPlaybackTicket(authorized, lease, { ticketRef: 'ticket-1', issuedAt: 150, expiresAt: 200 }), /RUNTIME_NOT_READY/);
  lease = transitionHostRuntimeLease(lease, 'ready');
  assert.equal(isReadyHostRuntimeLease(lease), true);
  const ticket = createHostPlaybackTicket(authorized, lease, { ticketRef: 'ticket-1', issuedAt: 150, expiresAt: 200 });
  assert.equal(ticket.proxyPolicy.hostResolvesDestination, true);
  assert.equal(Object.hasOwn(ticket, 'url'), false);
  assert.equal(plan.rawUrlAllowed, false);
});

test('catalog identity is stable across memberships and legacy migration is explicit', () => {
  const first = migrateLegacyCatalogItemIdentity({ pluginId: 'addon.example', catalogType: 'movie', catalogId: 'one', itemId: 'provider-42' });
  const second = migrateLegacyCatalogItemIdentity({ pluginId: 'addon.example', catalogType: 'movie', catalogId: 'two', itemId: 'provider-42' });
  assert.equal(first.canonicalKey, second.canonicalKey);
  assert.notEqual(first.legacyKey, second.legacyKey);
  assert.equal(first.identity.addonId, 'addon.example');
  assert.equal(first.identity.providerId, 'provider-42');
  assert.equal(canonicalPluginItemKey(first.identity), first.canonicalKey);

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
});

test('renderer projections omit marketplace signing and origin details', () => {
  const verified = verifyWireMarketplaceIndex(marketplaceIndex(), hostMarketplaceContext());
  const projection = projectMarketplaceIndexForRenderer(verified);
  assert.equal(Object.hasOwn(projection, 'publisherId'), false);
  assert.equal(Object.hasOwn(projection.addons[0], 'publisherId'), false);
  assert.equal(Object.hasOwn(projection.addons[0], 'manifestOrigin'), false);
  assert.equal(Object.hasOwn(projection.addons[0], 'rollback'), false);
  assert.equal(Object.hasOwn(projection.addons[0], 'keyTransition'), false);
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
  assert.throws(() => authorizeVerifiedPluginUpdate(verified, createHostUpdateAuthorizationContext({ approveDeclarativeUpdate: () => true })), /PHASE9_SANDBOX_REQUIRED/);
});
