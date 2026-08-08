export const PLUGIN_DOWNSTREAM_PROTOCOL_VERSION: 1;
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
export const PLUGIN_UPDATE_CHANNELS: readonly ['stable', 'beta', 'canary'];
export const PLUGIN_TICKET_MAX_LIFETIME_MS: 900000;
export const PLUGIN_CATALOG_MAX_LIFETIME_MS: 86400000;
export const PLUGIN_UPDATE_MAX_LIFETIME_MS: 604800000;

export type PluginHostRuntimeKind = (typeof PLUGIN_HOST_RUNTIME_KINDS)[number];
export type PluginHostSurfaceId = (typeof PLUGIN_HOST_SURFACE_IDS)[number];
export type PluginHostSurfaceState = (typeof PLUGIN_HOST_SURFACE_STATES)[number];
export type PluginPlaybackSourceKind = (typeof PLUGIN_PLAYBACK_SOURCE_KINDS)[number];
export type PluginPlaybackMode = (typeof PLUGIN_PLAYBACK_MODES)[number];
export type PluginSigningAlgorithm = (typeof PLUGIN_SIGNING_ALGORITHMS)[number];
export type PluginUpdateChannel = (typeof PLUGIN_UPDATE_CHANNELS)[number];

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

export interface PluginProfileBinding {
  deviceRef: string;
  profileId: string;
  selectionRevision: number;
}

export interface PluginSearchNamespaceFields {
  contractVersion: 1;
  transport: 'host-mediated';
  pluginId: string;
  catalogType: string;
  catalogId: string;
  namespace: string;
  namespaceKey: string;
}

export interface PluginSearchNamespace extends PluginSearchNamespaceFields {
  kind: 'plugin-search-namespace';
}

export interface PluginCatalogItemNamespace extends PluginSearchNamespaceFields {
  kind: 'plugin-catalog-item-namespace';
  itemId: string;
  itemKey: string;
}

export interface PluginSearchRequest extends PluginSearchNamespaceFields {
  kind: 'plugin-search-request';
  query: string;
  page: number;
  limit: number;
  profile?: PluginProfileBinding;
}

export interface SubtitleAttachmentRequest {
  contractVersion: 1;
  kind: 'subtitle-attachment-request';
  transport: 'host-mediated';
  pluginId: string;
  mediaRef: string;
  subtitleRef: string;
  language?: string;
  format?: string;
  profile: PluginProfileBinding;
  issuedAt: number;
  expiresAt: number;
  authorization: {
    profileBound: true;
    selectionRevisionRequired: true;
    pairingRevalidated: true;
    hostResolvesSource: true;
  };
}

export interface SubtitleAttachmentReceipt {
  contractVersion: 1;
  kind: 'subtitle-attachment-receipt';
  transport: 'host-mediated';
  requestRef: string;
  pluginId: string;
  mediaRef: string;
  profile: PluginProfileBinding;
  status: 'accepted' | 'rejected';
  attachmentRef?: string;
  reasonCode?: string;
  issuedAt: number;
  expiresAt: number;
}

export interface PlaybackTicketRequest {
  contractVersion: 1;
  kind: 'playback-ticket-request';
  transport: 'host-mediated';
  pluginId: string;
  mediaRef: string;
  sourceRef: string;
  sourceKind: PluginPlaybackSourceKind;
  requestedModes: readonly PluginPlaybackMode[];
  profile: PluginProfileBinding;
  issuedAt: number;
  authorization: {
    profileBound: true;
    selectionRevisionRequired: true;
    pairingRevalidated: true;
    approvalRevalidated: true;
    sourceResolvedByHost: true;
  };
}

export interface PlaybackTicket {
  contractVersion: 1;
  kind: 'playback-ticket';
  transport: 'host-mediated-proxy';
  ticketRef: string;
  requestRef: string;
  pluginId: string;
  mediaRef: string;
  sourceRef: string;
  sourceKind: PluginPlaybackSourceKind;
  profile: PluginProfileBinding;
  issuedAt: number;
  expiresAt: number;
  proxyPolicy: {
    methods: readonly ['GET', 'HEAD'];
    rangeRequests: true;
    redirects: 'deny';
    cache: 'no-store';
    revalidateProfile: true;
    revalidatePairing: true;
    revalidateApproval: true;
  };
}

export interface PluginHostSurface {
  id: PluginHostSurfaceId;
  state: PluginHostSurfaceState;
  gate?: string;
}

export interface PluginHostParityDescriptor {
  contractVersion: 1;
  kind: 'plugin-host-parity';
  transport: 'host-mediated';
  runtime: PluginHostRuntimeKind;
  hostApiVersion: string;
  surfaces: readonly PluginHostSurface[];
  prohibited: readonly ['raw-url-playback', 'raw-url-subtitles', 'executable-plugin-code'];
}

export interface SignedCatalogItem {
  id: string;
  itemKey: string;
  type: string;
  title: string;
  description?: string;
  releaseInfo?: string;
  released?: string;
  rating?: number;
  runtime?: string;
  year?: number;
  genres?: readonly string[];
  artworkRef?: string;
}

export interface SignedCatalogPayload {
  namespace: string;
  catalogType: string;
  catalogId: string;
  revision: number;
  items: readonly SignedCatalogItem[];
}

export interface SignedCatalogEnvelope {
  contractVersion: 1;
  kind: 'signed-catalog';
  transport: 'host-mediated';
  publisherId: string;
  pluginId: string;
  keyId: string;
  signatureAlgorithm: 'ed25519';
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  payloadDigest: string;
  signature: string;
  payload: SignedCatalogPayload;
  verification: {
    publisherKeyMustBePinned: true;
    digestMustMatchCanonicalPayload: true;
    sequenceMustNotRegress: true;
    expiryMustBeCheckedBeforeUse: true;
  };
}

export interface SignedUpdateEnvelope {
  contractVersion: 1;
  kind: 'signed-update';
  transport: 'host-mediated';
  publisherId: string;
  pluginId: string;
  keyId: string;
  signatureAlgorithm: 'ed25519';
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  version: string;
  hostApiRange: string;
  channel: PluginUpdateChannel;
  artifactRef: string;
  artifactSha256: string;
  artifactSize: number;
  payloadDigest: string;
  signature: string;
  requiresRestart: boolean;
  verification: {
    publisherKeyMustBePinned: true;
    digestMustMatchHostFetchedArtifact: true;
    sequenceMustNotRegress: true;
    expiryMustBeCheckedBeforeStaging: true;
    installMustRemainHostControlled: true;
  };
}

export function canonicalizeSignedDocument(value: unknown): string;
export function createPluginSearchNamespace(input: {
  pluginId: string;
  catalogType: string;
  catalogId: string;
}): PluginSearchNamespace;
export function namespacePluginCatalogItem(input: {
  pluginId: string;
  catalogType: string;
  catalogId: string;
  itemId: string;
}): PluginCatalogItemNamespace;
export function createPluginSearchRequest(input: {
  pluginId: string;
  catalogType: string;
  catalogId: string;
  query?: string;
  page?: number;
  limit?: number;
  profile?: PluginProfileBinding;
}): PluginSearchRequest;
export function createSubtitleAttachmentRequest(input: {
  pluginId: string;
  mediaRef: string;
  subtitleRef: string;
  language?: string;
  format?: string;
  profile: PluginProfileBinding;
  issuedAt: number;
  expiresAt: number;
}): SubtitleAttachmentRequest;
export function createSubtitleAttachmentReceipt(input: {
  requestRef: string;
  pluginId: string;
  mediaRef: string;
  profile: PluginProfileBinding;
  status: 'accepted' | 'rejected';
  attachmentRef?: string;
  reasonCode?: string;
  issuedAt: number;
  expiresAt: number;
}): SubtitleAttachmentReceipt;
export function createPlaybackTicketRequest(input: {
  pluginId: string;
  mediaRef: string;
  sourceRef: string;
  sourceKind: PluginPlaybackSourceKind;
  requestedModes?: PluginPlaybackMode | readonly PluginPlaybackMode[];
  profile: PluginProfileBinding;
  issuedAt: number;
}): PlaybackTicketRequest;
export function createPlaybackTicket(input: {
  ticketRef: string;
  requestRef: string;
  pluginId: string;
  mediaRef: string;
  sourceRef: string;
  sourceKind: PluginPlaybackSourceKind;
  profile: PluginProfileBinding;
  issuedAt: number;
  expiresAt: number;
}): PlaybackTicket;
export function createPluginHostParityDescriptor(input: {
  runtime: PluginHostRuntimeKind;
  hostApiVersion: string;
  surfaces: readonly PluginHostSurface[];
}): PluginHostParityDescriptor;
export function createSignedCatalogEnvelope(input: {
  publisherId: string;
  pluginId: string;
  keyId: string;
  signatureAlgorithm: PluginSigningAlgorithm;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  payloadDigest: string;
  signature: string;
  payload: {
    namespace: string;
    catalogType: string;
    catalogId: string;
    revision: number;
    items: readonly Omit<SignedCatalogItem, 'itemKey'>[];
  };
}): SignedCatalogEnvelope;
export function createSignedUpdateEnvelope(input: {
  publisherId: string;
  pluginId: string;
  keyId: string;
  signatureAlgorithm: PluginSigningAlgorithm;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  version: string;
  hostApiRange: string;
  channel: PluginUpdateChannel;
  artifactRef: string;
  artifactSha256: string;
  artifactSize: number;
  payloadDigest: string;
  signature: string;
  requiresRestart: boolean;
}): SignedUpdateEnvelope;
