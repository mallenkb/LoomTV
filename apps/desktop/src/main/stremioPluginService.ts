import {
  StremioAdapterError,
  StremioAddonRegistry,
  createStremioAddonRegistry,
  type StremioAddonRegistryOptions,
  type StremioAddonStateSnapshot,
  type StremioCatalogRequest,
  type StremioCatalogResult,
  type StremioFetchImplementation,
  type StremioInstallRecord,
  type StremioManifestReview,
  type StremioMetaRequest,
  type StremioMetaResult,
  type StremioStreamResult,
  type StremioSubtitleResult,
  type StremioVideoRequest,
} from '@loom-media-server/plugin-protocol';
import type {
  StremioPluginAuditEntry,
  StremioPluginConfigurationField,
  StremioPluginConfigurationState,
} from '../shared/desktopProtocol.ts';
const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DEFAULT_PROVIDER_QUEUE_LIMIT = 24;
const DEFAULT_PROFILE_ADDON_CONCURRENCY = 2;
const DEFAULT_PROFILE_ADDON_QUEUE_LIMIT = 8;
const MAX_CATALOG_PAGES = 64;
const MAX_CATALOG_ITEMS = 1_000;

type HostDiscoverFilters = {
  query?: string;
  genre?: string;
  year?: string;
};

type HostDiscoverCatalogRequest = StremioCatalogRequest & { filters?: HostDiscoverFilters };

function catalogExtra(catalog: StremioInstallRecord['manifest']['catalogs'][number] | undefined, names: readonly string[]) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return catalog?.extra.find((extra) => wanted.has(extra.name.toLowerCase()));
}

function catalogYear(item: StremioCatalogResult['items'][number]): number {
  const value = `${item.releaseInfo || ''} ${item.released || ''}`.match(/\b(19\d{2}|20\d{2})\b/);
  return value ? Number(value[1]) : 0;
}

function filterCompleteCatalogItems(items: ReadonlyArray<StremioCatalogResult['items'][number]>, filters: HostDiscoverFilters, catalog: StremioInstallRecord['manifest']['catalogs'][number] | undefined) {
  const search = filters.query?.trim().toLowerCase() || '';
  const genre = filters.genre?.trim().toLowerCase() || '';
  const year = filters.year?.trim() || '';
  const searchIsProviderBacked = Boolean(catalogExtra(catalog, ['search']));
  const genreIsProviderBacked = Boolean(catalogExtra(catalog, ['genre', 'genres']));
  const yearIsProviderBacked = Boolean(catalogExtra(catalog, ['year', 'releaseYear', 'release_year']));
  return items.filter((item) => {
    if (search && !searchIsProviderBacked && ![item.title, item.description, item.releaseInfo, item.released, ...item.genres]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search))) return false;
    if (genre && !genreIsProviderBacked && !item.genres.some((value) => value.toLowerCase() === genre)) return false;
    if (year && !yearIsProviderBacked && catalogYear(item) !== Number(year)) return false;
    return true;
  });
}

export type StremioPluginServiceErrorCode =
  | 'STREMIO_PLUGIN_STORAGE_UNAVAILABLE'
  | 'STREMIO_PLUGIN_PROFILE_NOT_FOUND'
  | 'STREMIO_PLUGIN_PROFILE_NOT_ALLOWED'
  | 'STREMIO_PLUGIN_ACCESS_DENIED'
  | 'STREMIO_PLUGIN_OFFICIAL_ID_MISMATCH'
  | 'STREMIO_PLUGIN_INVALID_ITEM_ID'
  | 'STREMIO_PLUGIN_PROVIDER_BUSY'
  | 'STREMIO_PLUGIN_RESULT_STALE'
  | 'STREMIO_PLUGIN_REQUEST_CANCELLED';

export class StremioPluginServiceError extends Error {
  public readonly code: StremioPluginServiceErrorCode;
  public readonly retryable: boolean;

  constructor(
    code: StremioPluginServiceErrorCode,
    message: string,
    retryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StremioPluginServiceError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type StremioHostProfile = {
  id: string;
  type: 'owner' | 'standard' | 'kid' | 'guest';
  isGuest: boolean;
};

export interface StremioPluginServiceDependencies {
  loadState: () => unknown | null;
  saveState: (snapshot: StremioAddonStateSnapshot, audit?: {
    addonId: string;
    eventType: string;
    actor: string;
    outcome?: 'success' | 'failure';
    detail?: Readonly<Record<string, unknown>>;
    manifestLastChecked?: number;
    lastSuccessfulRequest?: number;
  }) => unknown;
  getProfile: (profileId: string) => StremioHostProfile | null;
  listProfileAccess: (profileId: string) => readonly string[];
  hasProfileAccess: (profileId: string, addonId: string) => boolean;
  setProfileAccess: (profileId: string, addonId: string, enabled: boolean) => boolean;
  authorizeManagement: () => StremioHostProfile;
  captureProfileAuthorization?: (profileId: string) => unknown;
  validateProfileAuthorization?: (profileId: string, token: unknown) => void;
  isAddonConfigured?: (record: StremioInstallRecord) => boolean;
  getAddonConfiguration?: (addonId: string) => Readonly<Record<string, string | number | boolean>>;
  getAddonConfigurationState?: (addonId: string, fields: readonly StremioPluginConfigurationField[]) => StremioPluginConfigurationState;
  saveAddonConfiguration?: (addonId: string, values: Readonly<Record<string, unknown>>) => StremioPluginConfigurationState;
  recordAudit?: (addonId: string, eventType: string, detail?: Record<string, unknown>) => void;
  listAudit?: (addonId: string, limit?: number) => readonly StremioPluginAuditEntry[];
  fetchImpl: StremioFetchImplementation;
  maxConcurrentProviderRequests?: number;
  maxQueuedProviderRequests?: number;
  maxConcurrentProfileAddonRequests?: number;
  maxQueuedProfileAddonRequests?: number;
}

export type StremioPluginServiceStatus =
  | { available: true; installedCount: number; enabledCount: number }
  | { available: false; error: StremioPluginServiceError };

type ProviderGateState = {
  active: number;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>;
};

class ProviderRequestGate {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly states = new Map<string, ProviderGateState>();

  constructor(
    maxConcurrent: number,
    maxQueued: number,
  ) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
  }

  async run<T>(key: string, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const state = this.states.get(key) || { active: 0, waiters: [] };
    if (!this.states.has(key)) this.states.set(key, state);
    const requestSignal = signal || new AbortController().signal;
    if (requestSignal.aborted) {
      throw new StremioPluginServiceError('STREMIO_PLUGIN_REQUEST_CANCELLED', 'The provider request was cancelled.', true);
    }

    if (state.active < this.maxConcurrent) {
      state.active += 1;
    } else {
      if (state.waiters.length >= this.maxQueued) {
        throw new StremioPluginServiceError(
          'STREMIO_PLUGIN_PROVIDER_BUSY',
          'This add-on is already handling the maximum number of requests.',
          true,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          signal: requestSignal,
          onAbort: () => {
            const index = state.waiters.indexOf(waiter);
            if (index >= 0) state.waiters.splice(index, 1);
            reject(new StremioPluginServiceError('STREMIO_PLUGIN_REQUEST_CANCELLED', 'The provider request was cancelled.', true));
          },
        };
        state.waiters.push(waiter);
        requestSignal.addEventListener('abort', waiter.onAbort, { once: true });
      });
      // The completing request transfers its occupied slot to this waiter, so
      // active remains unchanged while queued work begins.
    }

    try {
      if (requestSignal.aborted) throw new StremioPluginServiceError('STREMIO_PLUGIN_REQUEST_CANCELLED', 'The provider request was cancelled.', true);
      return await task(requestSignal);
    } finally {
      const next = state.waiters.shift();
      if (next) {
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
        if (next.signal?.aborted) {
          next.reject(new StremioPluginServiceError('STREMIO_PLUGIN_REQUEST_CANCELLED', 'The provider request was cancelled.', true));
          state.active -= 1;
          const replacement = state.waiters.shift();
          if (replacement) {
            if (replacement.onAbort) replacement.signal?.removeEventListener('abort', replacement.onAbort);
            state.active += 1;
            replacement.resolve();
          }
        } else {
          next.resolve();
        }
      } else {
        state.active -= 1;
        if (state.active === 0) this.states.delete(key);
      }
    }
  }
}

function boundedAdmissionSetting(value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(maximum, Number(value))) : fallback;
}

function storageUnavailable(cause: unknown): StremioPluginServiceError {
  return new StremioPluginServiceError(
    'STREMIO_PLUGIN_STORAGE_UNAVAILABLE',
    'The installed add-on state could not be loaded or saved safely.',
    false,
    { cause },
  );
}

function missingProfile(): StremioPluginServiceError {
  return new StremioPluginServiceError(
    'STREMIO_PLUGIN_PROFILE_NOT_FOUND',
    'The selected profile no longer exists.',
  );
}

function profileNotAllowed(): StremioPluginServiceError {
  return new StremioPluginServiceError(
    'STREMIO_PLUGIN_PROFILE_NOT_ALLOWED',
    'Stremio add-ons are not available to Guest or Kids profiles.',
  );
}

function requiresConfiguration(record: StremioInstallRecord): boolean {
  return record.manifest.behaviorHints.configurationRequired
    || record.manifest.config?.some((field) => field.required) === true;
}

export class StremioPluginService {
  private readonly deps: StremioPluginServiceDependencies;
  private registry: StremioAddonRegistry | null = null;
  private initializationError: StremioPluginServiceError | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly latestProviderRequests = new Map<string, AbortController>();
  private readonly registryOptions: StremioAddonRegistryOptions;
  private readonly globalProviderGate: ProviderRequestGate;
  private readonly profileAddonProviderGate: ProviderRequestGate;

  constructor(deps: StremioPluginServiceDependencies) {
    this.deps = deps;
    this.registryOptions = {
      fetchImpl: deps.fetchImpl,
      isAddonConfigured: deps.isAddonConfigured,
      getConfiguration: deps.getAddonConfiguration,
    };
    this.globalProviderGate = new ProviderRequestGate(
      boundedAdmissionSetting(deps.maxConcurrentProviderRequests, DEFAULT_PROVIDER_CONCURRENCY, 32),
      boundedAdmissionSetting(deps.maxQueuedProviderRequests, DEFAULT_PROVIDER_QUEUE_LIMIT, 256),
    );
    this.profileAddonProviderGate = new ProviderRequestGate(
      boundedAdmissionSetting(deps.maxConcurrentProfileAddonRequests, DEFAULT_PROFILE_ADDON_CONCURRENCY, 8),
      boundedAdmissionSetting(deps.maxQueuedProfileAddonRequests, DEFAULT_PROFILE_ADDON_QUEUE_LIMIT, 64),
    );
  }

  status(): StremioPluginServiceStatus {
    try {
      const records = this.getRegistry().list();
      return {
        available: true,
        installedCount: records.length,
        enabledCount: records.filter((record) => record.state === 'enabled' && record.trusted && this.isRequestable(record)).length,
      };
    } catch (error) {
      return { available: false, error: error instanceof StremioPluginServiceError ? error : storageUnavailable(error) };
    }
  }

  listManaged(): readonly StremioInstallRecord[] {
    this.deps.authorizeManagement();
    return this.getRegistry().list();
  }

  listManagedProfileAccess(profileId: string): readonly string[] {
    this.deps.authorizeManagement();
    const profile = this.deps.getProfile(profileId);
    if (!profile) throw missingProfile();
    if (profile.isGuest || profile.type === 'guest' || profile.type === 'kid') return [];
    if (profile.type === 'owner') {
      return this.getRegistry().list()
        .filter((record) => record.state === 'enabled' && record.trusted && this.isRequestable(record))
        .map(({ addonId }) => addonId);
    }
    const configurableAddonIds = new Set(
      this.getRegistry().list()
        .filter((record) => requiresConfiguration(record) && !this.isConfigured(record))
        .map(({ addonId }) => addonId),
    );
    return this.deps.listProfileAccess(profile.id).filter((addonId) => !configurableAddonIds.has(addonId));
  }

  listForProfile(profileId: string): readonly StremioInstallRecord[] {
    this.deps.captureProfileAuthorization?.(profileId);
    const profile = this.deps.getProfile(profileId);
    if (!profile || profile.isGuest || profile.type === 'guest' || profile.type === 'kid') return [];
    const grants = profile.type === 'owner' ? null : new Set(this.deps.listProfileAccess(profile.id));
    return this.getRegistry().list().filter((record) => (
      record.state === 'enabled'
      && record.trusted
      && this.isRequestable(record)
      && (grants === null || grants.has(record.addonId))
    ));
  }

  reviewManifestUrl(manifestUrl: string, expectedAddonId?: string): Promise<StremioManifestReview> {
    return this.mutateRegistry(async (registry) => {
      const review = await registry.reviewManifestUrl(manifestUrl);
      if (expectedAddonId && review.addonId !== expectedAddonId) {
        throw new StremioPluginServiceError(
          'STREMIO_PLUGIN_OFFICIAL_ID_MISMATCH',
          'The official add-on endpoint returned an unexpected manifest identity.',
        );
      }
      return review;
    }, (review, actor) => ({
      addonId: review.addonId,
      eventType: 'manifest_reviewed',
      actor,
      detail: { origin: review.manifestOrigin },
      manifestLastChecked: Date.now(),
    }));
  }

  approve(addonId: string, reviewToken: string): Promise<StremioInstallRecord> {
    return this.mutateRegistry(
      (registry) => registry.approve(addonId, { confirmed: true, reviewToken }),
      (_approved, actor) => ({ addonId, eventType: 'addon_approved', actor }),
    );
  }

  disable(addonId: string): Promise<StremioInstallRecord> {
    return this.mutateRegistry(
      (registry) => registry.disable(addonId),
      (_disabled, actor) => ({ addonId, eventType: 'addon_disabled', actor }),
    );
  }

  remove(addonId: string): Promise<boolean> {
    return this.mutateRegistry(
      (registry) => registry.remove(addonId),
      (removed, actor) => removed ? { addonId, eventType: 'addon_removed', actor } : undefined,
    );
  }

  getConfigurationState(addonId: string): StremioPluginConfigurationState {
    this.deps.authorizeManagement();
    const record = this.getRegistry().get(addonId);
    if (!record) throw new StremioPluginServiceError('STREMIO_PLUGIN_ACCESS_DENIED', 'The Stremio add-on is not installed.');
    const fields = (record.manifest.config || []).map((field) => ({
      key: field.key,
      type: field.type,
      required: field.required,
      ...(field.title ? { title: field.title } : {}),
      ...(field.options ? { options: [...field.options] } : {}),
    }));
    return this.deps.getAddonConfigurationState?.(addonId, fields) || {
      fields,
      configured: this.isConfigured(record),
      configuredFields: [],
      revision: 0,
    };
  }

  saveConfiguration(addonId: string, values: Readonly<Record<string, unknown>>): Promise<StremioPluginConfigurationState> {
    return this.enqueueMutation(() => {
      this.deps.authorizeManagement();
      if (!this.getRegistry().get(addonId)) throw new StremioPluginServiceError('STREMIO_PLUGIN_ACCESS_DENIED', 'The Stremio add-on is not installed.');
      if (!this.deps.saveAddonConfiguration) throw new StremioPluginServiceError('STREMIO_PLUGIN_STORAGE_UNAVAILABLE', 'The host configuration store is unavailable.');
      const state = this.deps.saveAddonConfiguration(addonId, values);
      this.deps.recordAudit?.(addonId, 'configuration_saved', { fields: state.configuredFields });
      return state;
    });
  }

  listAudit(addonId: string, limit = 100): readonly StremioPluginAuditEntry[] {
    this.deps.authorizeManagement();
    return this.deps.listAudit?.(addonId, limit) || [];
  }

  setProfileAccess(profileId: string, addonId: string, enabled: boolean): Promise<boolean> {
    return this.enqueueMutation(() => {
      this.deps.authorizeManagement();
      const profile = this.deps.getProfile(profileId);
      if (!profile) throw missingProfile();
      if (profile.type === 'owner') {
        if (!enabled) {
          throw new StremioPluginServiceError(
            'STREMIO_PLUGIN_PROFILE_NOT_ALLOWED',
            'The Owner profile always has access to enabled host add-ons.',
          );
        }
        this.getRegistry().requireEnabledRecord(addonId);
        return true;
      }
      if (profile.isGuest || profile.type === 'guest' || profile.type === 'kid') {
        if (!enabled) return this.deps.setProfileAccess(profile.id, addonId, false);
        throw profileNotAllowed();
      }
      if (enabled) this.getRegistry().requireEnabledRecord(addonId);
      else if (!this.getRegistry().get(addonId)) return false;
      return this.deps.setProfileAccess(profile.id, addonId, enabled);
    });
  }

  fetchCatalog(profileId: string, addonId: string, request: StremioCatalogRequest): Promise<StremioCatalogResult> {
    return this.runProviderRequest(profileId, addonId, (registry, signal) => registry.fetchCatalog(addonId, request, signal));
  }

  /**
   * Catalog pagination belongs to the host boundary. Renderer callers receive
   * one bounded result after the host follows a provider-declared `skip`
   * cursor, so search/genre/year requests cannot accidentally operate on the
   * first renderer-sized slice only.
   */
  fetchCatalogComplete(profileId: string, addonId: string, request: HostDiscoverCatalogRequest): Promise<StremioCatalogResult> {
    return this.runProviderRequest(profileId, addonId, async (registry, signal) => {
      const record = registry.get(addonId);
      const catalog = record?.manifest.catalogs.find((candidate) => (
        candidate.type === request.type && candidate.id === request.catalogId
      ));
      const supportsSkip = catalog?.extra.some((extra) => extra.name.toLowerCase() === 'skip') === true;
      const filters = request.filters || {};
      const providerExtra: Record<string, string | number | boolean> = { ...(request.extra || {}) };
      const searchExtra = catalogExtra(catalog, ['search']);
      const genreExtra = catalogExtra(catalog, ['genre', 'genres']);
      const yearExtra = catalogExtra(catalog, ['year', 'releaseYear', 'release_year']);
      if (filters.query?.trim() && searchExtra) providerExtra[searchExtra.name] = filters.query.trim();
      if (filters.genre?.trim() && genreExtra) providerExtra[genreExtra.name] = filters.genre.trim();
      if (filters.year?.trim() && yearExtra) providerExtra[yearExtra.name] = filters.year.trim();
      const requestedSkip = Number(providerExtra.skip);
      let skip = Number.isSafeInteger(requestedSkip) && requestedSkip >= 0 ? requestedSkip : 0;
      const items: StremioCatalogResult['items'][number][] = [];
      const seen = new Set<string>();
      let firstResult: StremioCatalogResult | null = null;

      for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
        const extra = {
          ...providerExtra,
          ...(supportsSkip ? { skip } : {}),
        };
        const { filters: _filters, ...providerRequest } = request;
        const result = await registry.fetchCatalog(addonId, {
          ...providerRequest,
          ...(Object.keys(extra).length > 0 ? { extra } : {}),
        }, signal);
        firstResult ||= result;
        let added = 0;
        for (const item of result.items) {
          const identity = `${item.type}\u0000${item.id}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          items.push(item);
          added += 1;
          if (items.length >= MAX_CATALOG_ITEMS) break;
        }
        if (!supportsSkip || result.items.length === 0 || added === 0 || items.length >= MAX_CATALOG_ITEMS) break;
        skip += result.items.length;
      }

      if (!firstResult) throw new Error('The provider returned no catalog page.');
      return { ...firstResult, items: filterCompleteCatalogItems(items, filters, catalog) };
    });
  }

  fetchMeta(profileId: string, addonId: string, request: StremioMetaRequest): Promise<StremioMetaResult> {
    return this.runProviderRequest(profileId, addonId, (registry, signal) => registry.fetchMeta(addonId, request, signal));
  }

  fetchStreams(profileId: string, addonId: string, request: StremioVideoRequest): Promise<StremioStreamResult> {
    // The protocol adapter permanently rejects peer-to-peer/torrent candidates;
    // this host method can only return HTTPS media sources as playable.
    return this.runProviderRequest(profileId, addonId, (registry, signal) => registry.fetchStreams(addonId, request, signal));
  }

  fetchSubtitles(profileId: string, addonId: string, request: StremioVideoRequest): Promise<StremioSubtitleResult> {
    return this.runProviderRequest(profileId, addonId, (registry, signal) => registry.fetchSubtitles(addonId, request, signal));
  }

  private getRegistry(): StremioAddonRegistry {
    if (this.initializationError) throw this.initializationError;
    if (this.registry) return this.registry;
    try {
      const persisted = this.deps.loadState();
      this.registry = persisted
        ? StremioAddonRegistry.fromPersistedState(persisted, this.registryOptions)
        : createStremioAddonRegistry(this.registryOptions);
      return this.registry;
    } catch (error) {
      this.initializationError = storageUnavailable(error);
      throw this.initializationError;
    }
  }

  private restoreRegistry(snapshot: StremioAddonStateSnapshot): void {
    try {
      this.registry = StremioAddonRegistry.fromPersistedState(snapshot, this.registryOptions);
    } catch (error) {
      this.initializationError = storageUnavailable(error);
      throw this.initializationError;
    }
  }

  private enqueueMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    const queued = this.mutationQueue.then(operation, operation);
    this.mutationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private mutateRegistry<T>(
    operation: (registry: StremioAddonRegistry) => T | Promise<T>,
    auditForResult?: (result: T, actor: string) => Parameters<StremioPluginServiceDependencies['saveState']>[1],
  ): Promise<T> {
    return this.enqueueMutation(async () => {
      const actorProfile = this.deps.authorizeManagement();
      const registry = this.getRegistry();
      const previous = registry.toJSON();
      let result: T;
      try {
        result = await operation(registry);
      } catch (error) {
        this.restoreRegistry(previous);
        throw error;
      }
      try {
        this.deps.saveState(registry.toJSON(), auditForResult?.(result, `profile:${actorProfile.id}`));
      } catch (error) {
        this.restoreRegistry(previous);
        throw storageUnavailable(error);
      }
      return result;
    });
  }

  private requireProfileAccess(profileId: string, addonId: string): StremioInstallRecord {
    const profile = this.deps.getProfile(profileId);
    if (!profile) throw missingProfile();
    if (profile.isGuest || profile.type === 'guest' || profile.type === 'kid') throw profileNotAllowed();
    if (profile.type !== 'owner' && !this.deps.hasProfileAccess(profile.id, addonId)) {
      throw new StremioPluginServiceError(
        'STREMIO_PLUGIN_ACCESS_DENIED',
        'This add-on is not enabled for the active profile.',
      );
    }
    return this.getRegistry().requireEnabledRecord(addonId);
  }

  private runProviderRequest<T>(
    profileId: string,
    addonId: string,
    operation: (registry: StremioAddonRegistry, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const requestKey = `${profileId}\u0000${addonId}`;
    const controller = new AbortController();
    const previous = this.latestProviderRequests.get(requestKey);
    previous?.abort();
    this.latestProviderRequests.set(requestKey, controller);
    const abortExternal = () => controller.abort();
    signal?.addEventListener('abort', abortExternal, { once: true });
    if (signal?.aborted) controller.abort();
    const request = this.globalProviderGate.run('global', (globalSignal) => this.profileAddonProviderGate.run(requestKey, async (requestSignal) => {
      const profileAuthorization = this.deps.captureProfileAuthorization?.(profileId);
      const before = this.requireProfileAccess(profileId, addonId);
      let providerStarted = false;
      try {
        providerStarted = true;
        const result = await operation(this.getRegistry(), requestSignal);
        this.deps.validateProfileAuthorization?.(profileId, profileAuthorization);
        const after = this.requireProfileAccess(profileId, addonId);
        if (before.reviewToken !== after.reviewToken || before.approvedAt !== after.approvedAt) {
          throw new StremioPluginServiceError(
            'STREMIO_PLUGIN_RESULT_STALE',
            'The add-on approval changed while this request was running.',
            true,
          );
        }
        await this.persistProviderHealth(addonId, true);
        return result;
      } catch (error) {
        const expectedCancellation = (error instanceof StremioPluginServiceError && (error.code === 'STREMIO_PLUGIN_REQUEST_CANCELLED' || error.code === 'STREMIO_PLUGIN_RESULT_STALE'))
          || (error instanceof StremioAdapterError && error.code === 'REQUEST_CANCELLED');
        if (providerStarted && !expectedCancellation) await this.persistProviderHealth(addonId, false, error);
        throw error;
      }
    }, globalSignal), controller.signal);
    return request.finally(() => {
      signal?.removeEventListener('abort', abortExternal);
      if (this.latestProviderRequests.get(requestKey) === controller) this.latestProviderRequests.delete(requestKey);
    });
  }

  private isConfigured(record: StremioInstallRecord): boolean {
    return !requiresConfiguration(record) || this.deps.isAddonConfigured?.(record) === true;
  }

  private isRequestable(record: StremioInstallRecord): boolean {
    return this.isConfigured(record);
  }

  private persistProviderHealth(addonId: string, success: boolean, error?: unknown): Promise<void> {
    return this.enqueueMutation(() => {
      const registry = this.getRegistry();
      const record = success
        ? registry.recordSuccess(addonId)
        : registry.recordFailure(addonId, { retryable: error instanceof StremioAdapterError ? error.retryable : true });
      if (!record) return;
      try {
        this.deps.saveState(registry.toJSON(), success ? {
          addonId,
          eventType: 'provider_request_succeeded',
          actor: 'host:provider',
          lastSuccessfulRequest: Date.now(),
        } : {
          addonId,
          eventType: record.state === 'broken' ? 'addon_broken' : 'provider_request_failed',
          actor: 'host:provider',
          outcome: 'failure',
          detail: { failureCount: record.failureCount, nextRetryAt: record.nextRetryAt },
        });
      } catch { /* preserve the provider error */ }
    });
  }
}

export function createStremioPluginService(deps: StremioPluginServiceDependencies): StremioPluginService {
  return new StremioPluginService(deps);
}

export function isStremioHostError(error: unknown): error is StremioAdapterError | StremioPluginServiceError {
  return error instanceof StremioAdapterError || error instanceof StremioPluginServiceError;
}
