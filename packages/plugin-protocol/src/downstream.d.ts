export const PLUGIN_DOWNSTREAM_PROTOCOL_VERSION: 2;
export const PLUGIN_WIRE_VERSION: 2;
export const PLUGIN_HOST_TRANSPORT: 'host-mediated';
export const PLUGIN_PROXY_TRANSPORT: 'host-mediated-proxy';
export const PLUGIN_NAMESPACE_PREFIX: 'loom-plugin';
export const PLUGIN_HOST_RUNTIME_KINDS: readonly ['desktop', 'headless'];
export const PLUGIN_HOST_SURFACE_IDS: readonly [
  'catalog.read',
  'catalog.search',
  'metadata.read',
  'subtitle.attachment',
  'playback.ticket',
  'catalog.signature',
  'update.signature',
  'executable.sandbox',
];
export const PLUGIN_HOST_SURFACE_STATES: readonly ['available', 'scaffolded', 'blocked'];
export const PLUGIN_PLAYBACK_SOURCE_KINDS: readonly ['https-media', 'hls'];
export const PLUGIN_PLAYBACK_MODES: readonly ['direct-proxy', 'hls-proxy'];
export const PLUGIN_SIGNING_ALGORITHMS: readonly ['ed25519'];
export const PLUGIN_TICKET_MAX_LIFETIME_MS: 900000;
export const PLUGIN_CATALOG_MAX_LIFETIME_MS: 86400000;

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

export class PluginDownstreamContractError extends Error {
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

export interface PluginCatalogItemNamespace extends PluginSearchNamespace {
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

export function parseWireSearchRequest(input: unknown): WirePluginSearchRequest;
export function parseWireSubtitleAttachmentRequest(input: unknown): WireSubtitleAttachmentRequest;
export function parseWirePlaybackTicketRequest(input: unknown): WirePlaybackTicketRequest;
export function verifyWireSearchRequest(input: unknown, verifiedAddon: import('./marketplace').VerifiedMarketplaceAddon): VerifiedPluginSearchRequest;
export function verifyWireSubtitleAttachmentRequest(input: unknown, verifiedAddon: import('./marketplace').VerifiedMarketplaceAddon): VerifiedSubtitleAttachmentRequest;
export function verifyWirePlaybackTicketRequest(input: unknown, verifiedAddon: import('./marketplace').VerifiedMarketplaceAddon): VerifiedPlaybackTicketRequest;
export function createHostOnlyAuthorizationContext(input: HostAuthorizationContextInput): HostAuthorizationContext;
export function authorizeVerifiedSearchRequest(value: VerifiedPluginSearchRequest, hostContext: HostAuthorizationContext): AuthorizedPluginSearchRequest;
export function authorizeVerifiedSubtitleAttachmentRequest(value: VerifiedSubtitleAttachmentRequest, hostContext: HostAuthorizationContext): AuthorizedSubtitleAttachmentRequest;
export function authorizeVerifiedPlaybackTicketRequest(value: VerifiedPlaybackTicketRequest, hostContext: HostAuthorizationContext): AuthorizedPlaybackTicketRequest;
export function isAuthorizedPluginRequest(value: unknown): value is AuthorizedPluginSearchRequest | AuthorizedSubtitleAttachmentRequest | AuthorizedPlaybackTicketRequest;
export function createSubtitleAttachmentPlan(value: AuthorizedSubtitleAttachmentRequest): SubtitleAttachmentPlan;
export function createPlaybackProxyPlan(value: AuthorizedPlaybackTicketRequest): PlaybackProxyPlan;
export function createSubtitleAttachmentReceipt(value: AuthorizedSubtitleAttachmentRequest, input: {
  status: 'accepted' | 'rejected';
  attachmentRef?: string;
  reasonCode?: string;
}): SubtitleAttachmentReceipt;
export function createHostPlaybackTicket(value: AuthorizedPlaybackTicketRequest, runtimeLease: import('./runtime-lifecycle').HostRuntimeLease & { state: 'ready' }, input: {
  ticketRef: string;
  issuedAt: number;
  expiresAt: number;
}): PlaybackTicket;
export function createPluginSearchNamespace(input: { addonId: string; catalogType: string; catalogId: string }): PluginSearchNamespace;
export function namespacePluginCatalogItem(input: {
  addonId: string;
  catalogType: string;
  catalogId: string;
  type: string;
  providerId: string;
}): PluginCatalogItemNamespace;
export function createPluginHostParityDescriptor(input: {
  runtime: PluginHostRuntimeKind;
  hostApiVersion: string;
  surfaces: readonly { id: PluginHostSurfaceId; state: PluginHostSurfaceState; gate?: string }[];
}): PluginHostParityDescriptor;
export function canonicalizeSignedDocument(value: unknown): string;
export function isWireRequest(value: unknown): boolean;
export function isHostOnlyAuthorizationContext(value: unknown): value is HostAuthorizationContext;
