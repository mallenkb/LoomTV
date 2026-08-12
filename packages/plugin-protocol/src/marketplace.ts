export declare const PLUGIN_MARKETPLACE_WIRE_VERSION: 1;
export declare const PLUGIN_MARKETPLACE_INDEX_KIND: 'plugin-marketplace-index';
export declare const PLUGIN_PLUGIN_UPDATE_KIND: 'plugin-update';
export declare const PLUGIN_RENDERER_MARKETPLACE_KIND: 'marketplace-index-renderer';
export declare const PLUGIN_RENDERER_UPDATE_KIND: 'plugin-update-renderer';
export declare const PLUGIN_CAPABILITY_TYPES: readonly ['metadata.catalog', 'subtitle.provider', 'playback.provider'];
export declare const PLUGIN_MARKETPLACE_RISK_LEVELS: readonly ['low', 'medium', 'high', 'critical'];
export declare const PLUGIN_REVIEW_STATES: readonly ['unreviewed', 'pending', 'approved', 'rejected', 'expired'];
export declare const PLUGIN_REVOCATION_STATES: readonly ['active', 'revoked'];
export declare const PLUGIN_UPDATE_CHANNELS: readonly ['stable', 'beta', 'canary'];
export declare const PLUGIN_UPDATE_ARTIFACT_KINDS: readonly ['declarative-index', 'executable-plugin'];
export declare const PLUGIN_UPDATE_STATUS: readonly ['verified', 'quarantined-phase9'];
export declare const PLUGIN_MARKETPLACE_MAX_LIFETIME_MS: 604800000;
export declare const PLUGIN_UPDATE_MAX_LIFETIME_MS: 604800000;

export type PluginMarketplaceCapabilityType = (typeof PLUGIN_CAPABILITY_TYPES)[number];
export type PluginMarketplaceRiskLevel = (typeof PLUGIN_MARKETPLACE_RISK_LEVELS)[number];
export type PluginReviewState = (typeof PLUGIN_REVIEW_STATES)[number];
export type PluginRevocationState = (typeof PLUGIN_REVOCATION_STATES)[number];
export type PluginUpdateChannel = (typeof PLUGIN_UPDATE_CHANNELS)[number];
export type PluginUpdateArtifactKind = (typeof PLUGIN_UPDATE_ARTIFACT_KINDS)[number];
export type PluginUpdateStatus = (typeof PLUGIN_UPDATE_STATUS)[number];

export interface PluginMarketplaceContractIssue {
  path: string;
  code: string;
  message: string;
}

export declare class PluginMarketplaceContractError extends Error {
  readonly name: 'PluginMarketplaceContractError';
  readonly code: 'PLUGIN_MARKETPLACE_CONTRACT_INVALID';
  readonly issues: readonly PluginMarketplaceContractIssue[];
}

export interface PluginMarketplaceRisk {
  level: PluginMarketplaceRiskLevel;
  network: boolean;
  metadata: boolean;
  subtitle: boolean;
  playback: boolean;
  artwork: boolean;
  profile: boolean;
  executable: boolean;
  updates: boolean;
}

export interface PluginMarketplaceReview {
  state: PluginReviewState;
  reviewedAt?: number;
  reviewerRef?: string;
  expiresAt?: number;
}

export interface PluginMarketplaceRevocation {
  state: PluginRevocationState;
  effectiveAt?: number;
  reasonCode?: string;
  sequence?: number;
}

export interface PluginMarketplaceRollback {
  allowed: boolean;
  minimumSequence: number;
  maximumVersion?: string;
  requiresHostApproval: boolean;
}

export interface PluginPublisherKeyTransition {
  fromKeyId: string;
  toKeyId: string;
  validFrom: number;
  graceUntil: number;
  proofSignature: string;
}

export interface PluginMarketplaceCatalogMembership {
  type: string;
  id: string;
  name: string;
}

export interface PluginMarketplaceAddon {
  addonId: string;
  publisherId: string;
  name: string;
  version: string;
  manifestOrigin: string;
  capabilities: readonly PluginMarketplaceCapabilityType[];
  catalogs: readonly PluginMarketplaceCatalogMembership[];
  risk: PluginMarketplaceRisk;
  review: PluginMarketplaceReview;
  revocation: PluginMarketplaceRevocation;
  keyTransition?: PluginPublisherKeyTransition;
  rollback: PluginMarketplaceRollback;
}

export interface WireMarketplaceIndex {
  wireVersion: 1;
  kind: 'plugin-marketplace-index';
  indexId: string;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  publisherId: string;
  publisherKeyId: string;
  keyTransition?: PluginPublisherKeyTransition;
  rollback: PluginMarketplaceRollback;
  addons: readonly PluginMarketplaceAddon[];
  signatureAlgorithm: 'ed25519';
  signature: string;
}

export interface VerifiedMarketplaceAddon extends PluginMarketplaceAddon {}

export interface VerifiedMarketplaceIndex {
  wireVersion: 1;
  kind: 'plugin-marketplace-index';
  indexId: string;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  addons: readonly VerifiedMarketplaceAddon[];
}

export interface WireSignedCatalog {
  wireVersion: 2;
  kind: 'signed-catalog';
  publisherId: string;
  addonId: string;
  keyId: string;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  signatureAlgorithm: 'ed25519';
  signature: string;
  rollback: PluginMarketplaceRollback;
  payload: import('./identity').PluginCatalogResult;
}

export interface VerifiedSignedCatalog {
  wireVersion: 2;
  kind: 'signed-catalog';
  publisherId: string;
  addonId: string;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  payload: import('./identity').PluginCatalogResult;
}

export interface RendererMarketplaceAddon {
  addonId: string;
  name: string;
  version: string;
  capabilities: readonly PluginMarketplaceCapabilityType[];
  catalogs: readonly PluginMarketplaceCatalogMembership[];
  risk: PluginMarketplaceRisk;
  review: Pick<PluginMarketplaceReview, 'state' | 'expiresAt'>;
  revocation: Pick<PluginMarketplaceRevocation, 'state' | 'effectiveAt'>;
  executableStatus: 'quarantined-phase9' | 'declarative-only';
}

export interface RendererMarketplaceIndex {
  wireVersion: 1;
  kind: 'marketplace-index-renderer';
  indexId: string;
  sequence: number;
  expiresAt: number;
  addons: readonly RendererMarketplaceAddon[];
}

export interface PublisherKeyRecord {
  publicKey: string;
  revoked?: boolean;
}

export interface HostMarketplaceVerificationContext {
  readonly kind: 'host-marketplace-verification-context';
}

export interface HostMarketplaceVerificationContextInput {
  now: number;
  resolvePublisherKey(input: { publisherId: string; keyId: string }): PublisherKeyRecord | undefined;
  verifySignature(input: {
    algorithm: 'ed25519';
    publicKey: Uint8Array;
    signature: Uint8Array;
    message: Uint8Array;
    purpose: 'marketplace-index' | 'publisher-key-transition' | 'plugin-update';
  }): boolean;
  isPublisherTrusted(input: { publisherId: string }): boolean;
  getLastAcceptedSequence?(input: { publisherId: string; addonId?: string; kind: string }): number | undefined;
  getLastAcceptedPayload?(input: { publisherId: string; addonId?: string; kind: string }): string | undefined;
  isHostApiRangeSupported(input: { range: string }): boolean;
  approveRollback?(input: { publisherId: string; addonId?: string; kind: string; previousSequence: number; nextSequence: number }): boolean;
}

export interface VerifiedPluginUpdate {
  wireVersion: 1;
  kind: 'plugin-update';
  addonId: string;
  publisherId: string;
  version: string;
  channel: PluginUpdateChannel;
  artifactKind: PluginUpdateArtifactKind;
  artifactSize: number;
  artifactSha256: string;
  issuedAt: number;
  expiresAt: number;
  requiresRestart: boolean;
  status: PluginUpdateStatus;
  installable: false;
  reasonCode: 'PHASE9_SANDBOX_REQUIRED' | 'HOST_STAGING_REQUIRED';
}

export interface RendererPluginUpdate {
  wireVersion: 1;
  kind: 'plugin-update-renderer';
  addonId: string;
  version: string;
  channel: PluginUpdateChannel;
  artifactKind: PluginUpdateArtifactKind;
  status: PluginUpdateStatus;
  installable: false;
  reasonCode: 'PHASE9_SANDBOX_REQUIRED' | 'HOST_STAGING_REQUIRED';
}

export interface HostUpdateAuthorizationContext {
  readonly kind: 'host-update-authorization-context';
}

export declare function parseWireMarketplaceIndex(input: unknown): WireMarketplaceIndex;
export declare function createHostMarketplaceVerificationContext(input: HostMarketplaceVerificationContextInput): HostMarketplaceVerificationContext;
export declare function verifyWireMarketplaceIndex(input: unknown, hostContext: HostMarketplaceVerificationContext): VerifiedMarketplaceIndex;
export declare function isVerifiedMarketplaceIndex(value: unknown): value is VerifiedMarketplaceIndex;
export declare function isVerifiedMarketplaceAddon(value: unknown): value is VerifiedMarketplaceAddon;
export declare function readVerifiedMarketplaceAddon(value: VerifiedMarketplaceAddon): VerifiedMarketplaceAddon;
export declare function projectMarketplaceIndexForRenderer(value: VerifiedMarketplaceIndex): RendererMarketplaceIndex;

export declare function parseWireSignedCatalog(input: unknown): WireSignedCatalog;
export declare function verifyWireSignedCatalog(input: unknown, hostContext: HostMarketplaceVerificationContext, verifiedAddon: VerifiedMarketplaceAddon): VerifiedSignedCatalog;
export declare function isVerifiedSignedCatalog(value: unknown): value is VerifiedSignedCatalog;
export declare function projectSignedCatalogForRenderer(value: VerifiedSignedCatalog): {
  wireVersion: 2;
  kind: 'signed-catalog-renderer';
  addonId: string;
  catalogType: string;
  catalogId: string;
  revision: number;
  items: readonly import('./identity').PluginCatalogItem[];
};

export declare function parseWirePluginUpdate(input: unknown): WirePluginUpdate;
export declare function verifyWirePluginUpdate(input: unknown, hostContext: HostMarketplaceVerificationContext, verifiedAddon: VerifiedMarketplaceAddon): VerifiedPluginUpdate;
export declare function isVerifiedPluginUpdate(value: unknown): value is VerifiedPluginUpdate;
export declare function createHostUpdateAuthorizationContext(input: {
  now: number;
  approveDeclarativeUpdate(input: { addonId: string; version: string; sequence: number }): boolean;
}): HostUpdateAuthorizationContext;
export declare function authorizeVerifiedPluginUpdate(value: VerifiedPluginUpdate, hostContext: HostUpdateAuthorizationContext): {
  kind: 'authorized-plugin-update';
  addonId: string;
  version: string;
  artifactKind: 'declarative-index';
  artifactSize: number;
  artifactSha256: string;
  status: 'host-staging-approved';
  installable: false;
};
export declare function projectPluginUpdateForRenderer(value: VerifiedPluginUpdate): RendererPluginUpdate;
export declare function signedPayloadJson(value: WireMarketplaceIndex | WirePluginUpdate | WireSignedCatalog): string;

export interface WirePluginUpdate {
  wireVersion: 1;
  kind: 'plugin-update';
  publisherId: string;
  addonId: string;
  version: string;
  channel: PluginUpdateChannel;
  artifactKind: PluginUpdateArtifactKind;
  artifactRef: string;
  artifactSha256: string;
  artifactSize: number;
  manifestOrigin: string;
  keyId: string;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  hostApiRange: string;
  requiresRestart: boolean;
  rollback: PluginMarketplaceRollback;
  review: PluginMarketplaceReview;
  revocation: PluginMarketplaceRevocation;
  signatureAlgorithm: 'ed25519';
  signature: string;
}
