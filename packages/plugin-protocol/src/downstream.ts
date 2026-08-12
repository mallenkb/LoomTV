export declare const PLUGIN_DOWNSTREAM_PROTOCOL_VERSION: 2;
export declare const PLUGIN_WIRE_VERSION: 2;
export declare const PLUGIN_HOST_TRANSPORT: 'host-mediated';
export declare const PLUGIN_PROXY_TRANSPORT: 'host-mediated-proxy';
export declare const PLUGIN_NAMESPACE_PREFIX: 'loom-plugin';
export declare const PLUGIN_HOST_RUNTIME_KINDS: readonly ['desktop', 'headless'];
export declare const PLUGIN_HOST_SURFACE_IDS: readonly [
  'catalog.read',
  'catalog.search',
  'metadata.read',
  'subtitle.attachment',
  'playback.ticket',
  'catalog.signature',
  'update.signature',
  'executable.sandbox',
];
export declare const PLUGIN_HOST_SURFACE_STATES: readonly ['available', 'scaffolded', 'blocked'];
export declare const PLUGIN_PLAYBACK_SOURCE_KINDS: readonly ['https-media', 'hls'];
export declare const PLUGIN_PLAYBACK_MODES: readonly ['direct-proxy', 'hls-proxy'];
export declare const PLUGIN_SIGNING_ALGORITHMS: readonly ['ed25519'];
export declare const PLUGIN_TICKET_MAX_LIFETIME_MS: 900000;
export declare const PLUGIN_CATALOG_MAX_LIFETIME_MS: 86400000;

export type PluginHostRuntimeKind = (typeof PLUGIN_HOST_RUNTIME_KINDS)[number];
export type PluginHostSurfaceId = (typeof PLUGIN_HOST_SURFACE_IDS)[number];
export type PluginHostSurfaceState = (typeof PLUGIN_HOST_SURFACE_STATES)[number];
export type PluginPlaybackSourceKind = (typeof PLUGIN_PLAYBACK_SOURCE_KINDS)[number];
export type PluginPlaybackMode = (typeof PLUGIN_PLAYBACK_MODES)[number];

export interface PluginDownstreamContractIssue {
  path: string;
  code: string;
  message: string;
}

export declare class PluginDownstreamContractError extends Error {
  readonly name: 'PluginDownstreamContractError';
  readonly code: 'PLUGIN_DOWNSTREAM_CONTRACT_INVALID';
  readonly issues: readonly PluginDownstreamContractIssue[];
}

export interface WirePluginSearchRequest {
  wireVersion: 2;
  kind: 'plugin-search-request';
  transport: 'host-mediated';
  addonId: string;
  catalogType: string;
  catalogId: string;
  query: string;
  page: number;
  limit: number;
}

export interface WireSubtitleAttachmentRequest {
  wireVersion: 2;
  kind: 'subtitle-attachment-request';
  transport: 'host-mediated';
  addonId: string;
  requestRef: string;
  mediaRef: string;
  subtitleRef: string;
  language?: string;
  format?: string;
}

export interface WirePlaybackTicketRequest {
  wireVersion: 2;
  kind: 'playback-ticket-request';
  transport: 'host-mediated';
  addonId: string;
  requestRef: string;
  mediaRef: string;
  sourceRef: string;
  sourceKind: PluginPlaybackSourceKind;
  requestedModes: readonly PluginPlaybackMode[];
}

export interface HostAuthorizationBinding {
  deviceRef: string;
  profileId: string;
  selectionRevision: number;
  authorizationEpoch: number;
  revocationEpoch: number;
}

export interface HostAuthorizationContext {
  readonly kind: 'host-authorization-context';
}

export interface HostAuthorizationContextInput {
  deviceRef: string;
  profileId: string;
  selectionRevision: number;
  authorizationEpoch: number;
  revocationEpoch: number;
  now: number;
  allowedAddons: readonly { addonId: string; capabilities: readonly string[] }[];
  isAuthorizationCurrent(binding: HostAuthorizationBinding): boolean;
  isAddonCurrentlyAuthorized(input: {
    addonId: string;
    capability: string;
    binding: HostAuthorizationBinding;
    purpose: 'authorize-request' | 'subtitle-attachment' | 'playback-ticket';
  }): boolean;
}

export interface VerifiedPluginSearchRequest {
  wireVersion: 2;
  kind: 'verified-plugin-search-request';
  transport: 'host-mediated';
  addonId: string;
  catalogType: string;
  catalogId: string;
  query: string;
  page: number;
  limit: number;
}

export interface VerifiedSubtitleAttachmentRequest {
  wireVersion: 2;
  kind: 'verified-subtitle-attachment-request';
  transport: 'host-mediated';
  addonId: string;
  requestRef: string;
  mediaRef: string;
  subtitleRef: string;
  language?: string;
  format?: string;
}

export interface VerifiedPlaybackTicketRequest {
  wireVersion: 2;
  kind: 'verified-playback-ticket-request';
  transport: 'host-mediated';
  addonId: string;
  requestRef: string;
  mediaRef: string;
  sourceRef: string;
  sourceKind: PluginPlaybackSourceKind;
  requestedModes: readonly PluginPlaybackMode[];
}

export interface AuthorizedPluginSearchRequest {
  wireVersion: 2;
  kind: 'authorized-plugin-search-request';
  transport: 'host-mediated';
  addonId: string;
  catalogType: string;
  catalogId: string;
  query: string;
  page: number;
  limit: number;
  binding: HostAuthorizationBinding;
}

export interface AuthorizedSubtitleAttachmentRequest {
  wireVersion: 2;
  kind: 'authorized-subtitle-attachment-request';
  transport: 'host-mediated';
  addonId: string;
  requestRef: string;
  mediaRef: string;
  subtitleRef: string;
  language?: string;
  format?: string;
  binding: HostAuthorizationBinding;
}

export interface AuthorizedPlaybackTicketRequest {
  wireVersion: 2;
  kind: 'authorized-playback-ticket-request';
  transport: 'host-mediated';
  addonId: string;
  requestRef: string;
  mediaRef: string;
  sourceRef: string;
  sourceKind: PluginPlaybackSourceKind;
  requestedModes: readonly PluginPlaybackMode[];
  binding: HostAuthorizationBinding;
}

export interface SubtitleAttachmentPlan {
  kind: 'subtitle-attachment-plan';
  transport: 'host-mediated';
  addonId: string;
  requestRef: string;
  mediaRef: string;
  subtitleRef: string;
  binding: HostAuthorizationBinding;
  hostResolvesSource: true;
  maxAttachmentBytes: number;
  status: 'host-resolution-required';
}

export interface PlaybackProxyPlan {
  kind: 'playback-proxy-plan';
  transport: 'host-mediated-proxy';
  addonId: string;
  requestRef: string;
  mediaRef: string;
  sourceRef: string;
  sourceKind: PluginPlaybackSourceKind;
  requestedModes: readonly PluginPlaybackMode[];
  binding: HostAuthorizationBinding;
  hostResolvesSource: true;
  rawUrlAllowed: false;
  status: 'ready-runtime-required';
}

export interface SubtitleAttachmentReceipt {
  wireVersion: 2;
  kind: 'subtitle-attachment-receipt';
  transport: 'host-mediated';
  addonId: string;
  requestRef: string;
  mediaRef: string;
  status: 'accepted' | 'rejected';
  attachmentRef?: string;
  reasonCode?: string;
  binding: HostAuthorizationBinding;
}

export interface PlaybackTicket {
  wireVersion: 2;
  kind: 'playback-ticket';
  transport: 'host-mediated-proxy';
  ticketRef: string;
  requestRef: string;
  addonId: string;
  mediaRef: string;
  sourceKind: PluginPlaybackSourceKind;
  issuedAt: number;
  expiresAt: number;
  binding: HostAuthorizationBinding;
  runtimeBinding: {
    runtimeId: string;
    lifecycleEpoch: number;
    authorizationEpoch: number;
    revocationEpoch: number;
  };
  proxyPolicy: {
    methods: readonly ['GET', 'HEAD'];
    rangeRequests: true;
    redirects: 'deny';
    cache: 'no-store';
    hostResolvesDestination: true;
    recheckAuthorizationAtUse: true;
  };
}

export interface PluginSearchNamespace {
  wireVersion: 2;
  kind: 'plugin-search-namespace';
  transport: 'host-mediated';
  addonId: string;
  catalogType: string;
  catalogId: string;
  namespaceKey: string;
}

export interface PluginCatalogItemNamespace extends Omit<PluginSearchNamespace, 'kind'> {
  kind: 'plugin-catalog-item-namespace';
  type: string;
  providerId: string;
  itemKey: string;
}

export interface PluginHostParityDescriptor {
  wireVersion: 2;
  kind: 'plugin-host-parity';
  transport: 'host-mediated';
  runtime: PluginHostRuntimeKind;
  hostApiVersion: string;
  surfaces: readonly { id: PluginHostSurfaceId; state: PluginHostSurfaceState; gate?: string }[];
  scope: 'pre-phase-scaffold';
  prohibited: readonly ['raw-url-playback', 'raw-url-subtitles', 'executable-plugin-code'];
}

export declare function parseWireSearchRequest(input: unknown): WirePluginSearchRequest;
export declare function parseWireSubtitleAttachmentRequest(input: unknown): WireSubtitleAttachmentRequest;
export declare function parseWirePlaybackTicketRequest(input: unknown): WirePlaybackTicketRequest;
export declare function verifyWireSearchRequest(input: unknown, verifiedAddon: import('./marketplace').VerifiedMarketplaceAddon): VerifiedPluginSearchRequest;
export declare function verifyWireSubtitleAttachmentRequest(input: unknown, verifiedAddon: import('./marketplace').VerifiedMarketplaceAddon): VerifiedSubtitleAttachmentRequest;
export declare function verifyWirePlaybackTicketRequest(input: unknown, verifiedAddon: import('./marketplace').VerifiedMarketplaceAddon): VerifiedPlaybackTicketRequest;
export declare function createHostOnlyAuthorizationContext(input: HostAuthorizationContextInput): HostAuthorizationContext;
export declare function authorizeVerifiedSearchRequest(value: VerifiedPluginSearchRequest, hostContext: HostAuthorizationContext): AuthorizedPluginSearchRequest;
export declare function authorizeVerifiedSubtitleAttachmentRequest(value: VerifiedSubtitleAttachmentRequest, hostContext: HostAuthorizationContext): AuthorizedSubtitleAttachmentRequest;
export declare function authorizeVerifiedPlaybackTicketRequest(value: VerifiedPlaybackTicketRequest, hostContext: HostAuthorizationContext): AuthorizedPlaybackTicketRequest;
export declare function isAuthorizedPluginRequest(value: unknown): value is AuthorizedPluginSearchRequest | AuthorizedSubtitleAttachmentRequest | AuthorizedPlaybackTicketRequest;
export declare function createSubtitleAttachmentPlan(value: AuthorizedSubtitleAttachmentRequest): SubtitleAttachmentPlan;
export declare function createPlaybackProxyPlan(value: AuthorizedPlaybackTicketRequest): PlaybackProxyPlan;
export declare function createSubtitleAttachmentReceipt(value: AuthorizedSubtitleAttachmentRequest, input: {
  status: 'accepted' | 'rejected';
  attachmentRef?: string;
  reasonCode?: string;
}): SubtitleAttachmentReceipt;
export declare function createHostPlaybackTicket(value: AuthorizedPlaybackTicketRequest, runtimeLease: import('./runtime-lifecycle').HostRuntimeLease & { state: 'ready' }, input: {
  ticketRef: string;
  issuedAt: number;
  expiresAt: number;
}): PlaybackTicket;
export declare function createPluginSearchNamespace(input: { addonId: string; catalogType: string; catalogId: string }): PluginSearchNamespace;
export declare function namespacePluginCatalogItem(input: {
  addonId: string;
  catalogType: string;
  catalogId: string;
  type: string;
  providerId: string;
}): PluginCatalogItemNamespace;
export declare function createPluginHostParityDescriptor(input: {
  runtime: PluginHostRuntimeKind;
  hostApiVersion: string;
  surfaces: readonly { id: PluginHostSurfaceId; state: PluginHostSurfaceState; gate?: string }[];
}): PluginHostParityDescriptor;
export declare function canonicalizeSignedDocument(value: unknown): string;
export declare function isWireRequest(value: unknown): boolean;
export declare function isHostOnlyAuthorizationContext(value: unknown): value is HostAuthorizationContext;
