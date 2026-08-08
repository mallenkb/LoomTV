export const STREMIO_ADAPTER_PROTOCOL_VERSION: 1;
export const STREMIO_INSTALL_STATE_VERSION: 1;
export const STREMIO_RESOURCES: readonly ['catalog', 'meta', 'stream', 'subtitles'];
export const STREMIO_INSTALL_STATES: readonly ['pending-review', 'enabled', 'disabled', 'broken'];
export const STREMIO_DEFAULT_LIMITS: Readonly<StremioAdapterLimits>;
export const STREMIO_PEER_TO_PEER_UNSUPPORTED_REASON: string;

export type StremioResourceName = (typeof STREMIO_RESOURCES)[number];
export type StremioInstallState = (typeof STREMIO_INSTALL_STATES)[number];
export type StremioSourceKind = 'https-media' | 'hls' | 'torrent' | 'peer-to-peer' | 'unsupported';
export type StremioSourceAvailability = 'playable' | 'rejected';
export type StremioExtraValue = string | number | boolean;

export interface StremioAdapterLimits {
  timeoutMs: number;
  maxManifestBytes: number;
  maxResponseBytes: number;
  maxItems: number;
  maxStringLength: number;
  maxUrlLength: number;
  maxExtraEntries: number;
}

export interface StremioResourceDeclaration {
  name: StremioResourceName;
  types: readonly string[];
  idPrefixes: readonly string[];
}

export interface StremioCatalogExtraDefinition {
  name: string;
  isRequired: boolean;
  options?: readonly string[];
  optionsLimit?: number;
}

export interface StremioCatalogDeclaration {
  type: string;
  id: string;
  name: string;
  extra: readonly StremioCatalogExtraDefinition[];
}

export interface StremioBehaviorHints {
  adult: boolean;
  p2p: boolean;
  configurable: boolean;
  configurationRequired: boolean;
  newEpisodeNotifications: boolean;
}

export interface StremioCompatibilityWarning {
  code: string;
  path: string;
  message: string;
}

export interface StremioConfigDefinition {
  key: string;
  type: 'text' | 'number' | 'password' | 'checkbox' | 'select' | 'boolean' | 'string';
  required: boolean;
  title?: string;
  options?: readonly string[];
}

export interface LoomStremioManifest {
  adapterProtocolVersion: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  resources: readonly StremioResourceDeclaration[];
  types: readonly string[];
  idPrefixes: readonly string[];
  catalogs: readonly StremioCatalogDeclaration[];
  logoUrl?: string;
  backgroundUrl?: string;
  contactEmail?: string;
  behaviorHints: StremioBehaviorHints;
  peerToPeerDeclared: boolean;
  unsupportedResources: readonly string[];
  compatibilityWarnings: readonly StremioCompatibilityWarning[];
  config?: readonly StremioConfigDefinition[];
  supportedLoomCapabilities: readonly Array<'metadata.catalog' | 'playback.provider' | 'subtitle.provider'>;
}

export interface StremioInstallRecord {
  installStateVersion: 1;
  addonId: string;
  manifestOrigin: string;
  manifestUrlRedacted: string;
  manifest: LoomStremioManifest;
  reviewToken: string;
  state: StremioInstallState;
  trusted: boolean;
  installedAt: number;
  reviewedAt: number;
  approvedAt?: number;
  disabledAt?: number;
  failureCount: number;
  lastFailureAt?: number;
  nextRetryAt?: number;
}

export interface StremioManifestReview extends StremioInstallRecord {
  approvalRequired: true;
  reviewWarnings: readonly string[];
}

export interface StremioPersistedManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  resources: readonly (string | StremioResourceDeclaration)[];
  types: readonly string[];
  idPrefixes: readonly string[];
  catalogs: readonly StremioCatalogDeclaration[];
  logo?: string;
  background?: string;
  contactEmail?: string;
  behaviorHints?: Partial<StremioBehaviorHints>;
  config?: readonly StremioConfigDefinition[];
}

export interface StremioPersistedInstallRecord {
  installStateVersion: 1;
  addonId: string;
  manifestUrl: string;
  manifest: StremioPersistedManifest;
  reviewToken: string;
  state: StremioInstallState;
  trusted: boolean;
  installedAt: number;
  reviewedAt: number;
  approvedAt?: number;
  disabledAt?: number;
  failureCount?: number;
  lastFailureAt?: number;
  nextRetryAt?: number;
}

export interface StremioAddonStateSnapshot {
  stateVersion: 1;
  addons: readonly StremioPersistedInstallRecord[];
}

export interface StremioRequestSource {
  addonId: string;
  manifestOrigin: string;
  manifestUrlRedacted: string;
  type: string;
  itemId: string;
  sourceIndex?: number;
}

export interface StremioAddonApproval {
  confirmed: true;
  reviewToken: string;
}

export interface LoomStremioSubtitleCandidate {
  id: string;
  language: string;
  url: string;
  urlRedacted: string;
  source: StremioRequestSource;
}

export interface LoomStremioSourceCandidate {
  id: string;
  source: StremioRequestSource;
  sourceKind: StremioSourceKind;
  availability: StremioSourceAvailability;
  playableByLoom: boolean;
  requiresLoomAuthorization: true;
  requiresExplicitConsent: boolean;
  name?: string;
  url?: string;
  urlRedacted?: string;
  reason?: string;
  reasonCode?: string;
  reference?: string;
  subtitles?: readonly LoomStremioSubtitleCandidate[];
  rejectedSubtitles?: readonly { index: number; reasonCode: string; reason: string }[];
}

export interface LoomStremioVideoCandidate {
  id: string;
  title: string;
  released?: string;
  thumbnailUrl?: string;
  overview?: string;
  season?: number;
  episode?: number;
  available?: boolean;
  embeddedSources?: readonly LoomStremioSourceCandidate[];
}

export interface LoomStremioCastMember {
  name: string;
  character?: string;
  imageUrl?: string;
}

export interface LoomStremioMetaCandidate {
  id: string;
  type: string;
  title: string;
  source: StremioRequestSource;
  genres: readonly string[];
  posterUrl?: string;
  backgroundUrl?: string;
  logoUrl?: string;
  posterShape?: 'poster' | 'square' | 'landscape';
  description?: string;
  releaseInfo?: string;
  released?: string;
  rating?: number;
  runtime?: string;
  language?: string;
  country?: string;
  websiteUrl?: string;
  cast?: readonly LoomStremioCastMember[];
  videos?: readonly LoomStremioVideoCandidate[];
}

export interface StremioCatalogRequest {
  type: string;
  catalogId: string;
  filters?: {
    query?: string;
    genre?: string;
    year?: string;
  };
  extra?: Readonly<Record<string, StremioExtraValue>>;
}

export interface StremioMetaRequest {
  type: string;
  id: string;
  extra?: Readonly<Record<string, StremioExtraValue>>;
}

export interface StremioVideoRequest {
  type: string;
  videoId: string;
  extra?: Readonly<Record<string, StremioExtraValue>>;
}

export type StremioItemRequest = StremioMetaRequest | StremioVideoRequest;

export interface StremioCatalogResult {
  resource: 'catalog';
  source: StremioRequestSource;
  items: readonly LoomStremioMetaCandidate[];
}

export interface StremioMetaResult {
  resource: 'meta';
  source: StremioRequestSource;
  item: LoomStremioMetaCandidate | null;
}

export interface StremioStreamResult {
  resource: 'stream';
  source: StremioRequestSource;
  sources: readonly LoomStremioSourceCandidate[];
  playableCount: number;
  unsupportedPeerToPeerCount: number;
  rejectedCount: number;
}

export interface StremioSubtitleRejection {
  index: number;
  reasonCode: string;
  reason: string;
}

export interface StremioSubtitleResult {
  resource: 'subtitles';
  source: StremioRequestSource;
  subtitles: readonly LoomStremioSubtitleCandidate[];
  rejectedCount: number;
  rejected: readonly StremioSubtitleRejection[];
}

export interface StremioFetchResponse {
  status: number;
  url?: string;
  headers?: { get(name: string): string | null };
  body?: unknown;
  text(): Promise<string>;
}

export type StremioFetchImplementation = (url: string, init?: unknown) => Promise<StremioFetchResponse>;

export interface StremioAddonRegistryOptions extends Partial<StremioAdapterLimits> {
  fetchImpl?: StremioFetchImplementation;
  requestGuard?: (url: string) => void | Promise<void>;
  isAddonConfigured?: (record: StremioInstallRecord) => boolean;
  getConfiguration?: (addonId: string) => Readonly<Record<string, StremioExtraValue>>;
  now?: () => number;
}

export interface StremioAdapterIssue {
  path: string;
  code: string;
  message: string;
}

export class StremioAdapterError extends Error {
  readonly name: 'StremioAdapterError';
  readonly code: string;
  readonly retryable: boolean;
  readonly issues: readonly StremioAdapterIssue[];
}

export function normalizeStremioManifest(
  input: unknown,
  manifestUrl: string,
  options?: Partial<StremioAdapterLimits>,
): LoomStremioManifest;

export function redactStremioUrl(value: unknown): string;
export function redactStremioResourceUrl(value: unknown): string;

export class StremioAddonRegistry {
  constructor(options?: StremioAddonRegistryOptions);
  static fromPersistedState(snapshot: unknown, options?: StremioAddonRegistryOptions): StremioAddonRegistry;
  reviewManifestUrl(manifestUrl: string): Promise<StremioManifestReview>;
  approve(addonId: string, approval: StremioAddonApproval): StremioInstallRecord;
  disable(addonId: string): StremioInstallRecord;
  recordFailure(addonId: string, options?: { retryable?: boolean }): StremioInstallRecord | undefined;
  recordSuccess(addonId: string): StremioInstallRecord | undefined;
  remove(addonId: string): boolean;
  get(addonId: string): StremioInstallRecord | undefined;
  list(): readonly StremioInstallRecord[];
  toJSON(): StremioAddonStateSnapshot;
  loadPersistedState(snapshot: unknown): readonly StremioInstallRecord[];
  requireEnabledRecord(addonId: string): StremioInstallRecord;
  fetchCatalog(addonId: string, request: StremioCatalogRequest, signal?: unknown): Promise<StremioCatalogResult>;
  fetchMeta(addonId: string, request: StremioMetaRequest, signal?: unknown): Promise<StremioMetaResult>;
  fetchStreams(addonId: string, request: StremioVideoRequest, signal?: unknown): Promise<StremioStreamResult>;
  fetchSubtitles(addonId: string, request: StremioVideoRequest, signal?: unknown): Promise<StremioSubtitleResult>;
}

export function createStremioAddonRegistry(options?: StremioAddonRegistryOptions): StremioAddonRegistry;

export function serializeStremioAddonState(
  registry: StremioAddonRegistry,
): StremioAddonStateSnapshot;
