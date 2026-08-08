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
const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DEFAULT_PROVIDER_QUEUE_LIMIT = 24;

export type StremioPluginServiceErrorCode =
  | 'STREMIO_PLUGIN_STORAGE_UNAVAILABLE'
  | 'STREMIO_PLUGIN_PROFILE_NOT_FOUND'
  | 'STREMIO_PLUGIN_PROFILE_NOT_ALLOWED'
  | 'STREMIO_PLUGIN_ACCESS_DENIED'
  | 'STREMIO_PLUGIN_OFFICIAL_ID_MISMATCH'
  | 'STREMIO_PLUGIN_PROVIDER_BUSY'
  | 'STREMIO_PLUGIN_RESULT_STALE';

export class StremioPluginServiceError extends Error {
  constructor(
    public readonly code: StremioPluginServiceErrorCode,
    message: string,
    public readonly retryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StremioPluginServiceError';
  }
}

export type StremioHostProfile = {
  id: string;
  type: 'owner' | 'standard' | 'kid' | 'guest';
  isGuest: boolean;
};

export interface StremioPluginServiceDependencies {
  loadState: () => unknown | null;
  saveState: (snapshot: StremioAddonStateSnapshot) => unknown;
  getProfile: (profileId: string) => StremioHostProfile | null;
  listProfileAccess: (profileId: string) => readonly string[];
  hasProfileAccess: (profileId: string, addonId: string) => boolean;
  setProfileAccess: (profileId: string, addonId: string, enabled: boolean) => boolean;
  authorizeManagement: () => StremioHostProfile;
  captureProfileAuthorization?: (profileId: string) => unknown;
  validateProfileAuthorization?: (profileId: string, token: unknown) => void;
  fetchImpl: StremioFetchImplementation;
  maxConcurrentProviderRequests?: number;
  maxQueuedProviderRequests?: number;
}

export type StremioPluginServiceStatus =
  | { available: true; installedCount: number; enabledCount: number }
  | { available: false; error: StremioPluginServiceError };

type ProviderGateState = {
  active: number;
  waiters: Array<() => void>;
};

class ProviderRequestGate {
  private readonly states = new Map<string, ProviderGateState>();

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const state = this.states.get(key) || { active: 0, waiters: [] };
    if (!this.states.has(key)) this.states.set(key, state);

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
      await new Promise<void>((resolve) => { state.waiters.push(resolve); });
      // The completing request transfers its occupied slot to this waiter, so
      // active remains unchanged while queued work begins.
    }

    try {
      return await task();
    } finally {
      const next = state.waiters.shift();
      if (next) {
        next();
      } else {
        state.active -= 1;
        if (state.active === 0) this.states.delete(key);
      }
    }
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(Number(value))))
    : fallback;
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

export class StremioPluginService {
  private registry: StremioAddonRegistry | null = null;
  private initializationError: StremioPluginServiceError | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly registryOptions: StremioAddonRegistryOptions;
  private readonly providerGate: ProviderRequestGate;

  constructor(private readonly deps: StremioPluginServiceDependencies) {
    this.registryOptions = { fetchImpl: deps.fetchImpl };
    this.providerGate = new ProviderRequestGate(
      boundedInteger(deps.maxConcurrentProviderRequests, DEFAULT_PROVIDER_CONCURRENCY, 1, 8),
      boundedInteger(deps.maxQueuedProviderRequests, DEFAULT_PROVIDER_QUEUE_LIMIT, 0, 128),
    );
  }

  status(): StremioPluginServiceStatus {
    try {
      const records = this.getRegistry().list();
      return {
        available: true,
        installedCount: records.length,
        enabledCount: records.filter(({ state, trusted }) => state === 'enabled' && trusted).length,
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
        .filter(({ state, trusted }) => state === 'enabled' && trusted)
        .map(({ addonId }) => addonId);
    }
    return this.deps.listProfileAccess(profile.id);
  }

  listForProfile(profileId: string): readonly StremioInstallRecord[] {
    this.deps.captureProfileAuthorization?.(profileId);
    const profile = this.deps.getProfile(profileId);
    if (!profile || profile.isGuest || profile.type === 'guest' || profile.type === 'kid') return [];
    const grants = profile.type === 'owner' ? null : new Set(this.deps.listProfileAccess(profile.id));
    return this.getRegistry().list().filter((record) => (
      record.state === 'enabled'
      && record.trusted
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
    });
  }

  approve(addonId: string, reviewToken: string): Promise<StremioInstallRecord> {
    return this.mutateRegistry((registry) => registry.approve(addonId, {
      confirmed: true,
      reviewToken,
    }));
  }

  disable(addonId: string): Promise<StremioInstallRecord> {
    return this.mutateRegistry((registry) => registry.disable(addonId));
  }

  remove(addonId: string): Promise<boolean> {
    return this.mutateRegistry((registry) => registry.remove(addonId));
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
    return this.runProviderRequest(profileId, addonId, (registry) => registry.fetchCatalog(addonId, request));
  }

  fetchMeta(profileId: string, addonId: string, request: StremioMetaRequest): Promise<StremioMetaResult> {
    return this.runProviderRequest(profileId, addonId, (registry) => registry.fetchMeta(addonId, request));
  }

  fetchStreams(profileId: string, addonId: string, request: StremioVideoRequest): Promise<StremioStreamResult> {
    // The protocol adapter permanently rejects peer-to-peer/torrent candidates;
    // this host method can only return HTTPS media sources as playable.
    return this.runProviderRequest(profileId, addonId, (registry) => registry.fetchStreams(addonId, request));
  }

  fetchSubtitles(profileId: string, addonId: string, request: StremioVideoRequest): Promise<StremioSubtitleResult> {
    return this.runProviderRequest(profileId, addonId, (registry) => registry.fetchSubtitles(addonId, request));
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

  private mutateRegistry<T>(operation: (registry: StremioAddonRegistry) => T | Promise<T>): Promise<T> {
    return this.enqueueMutation(async () => {
      this.deps.authorizeManagement();
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
        this.deps.saveState(registry.toJSON());
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
    operation: (registry: StremioAddonRegistry) => Promise<T>,
  ): Promise<T> {
    const key = `${profileId}\u0000${addonId}`;
    return this.providerGate.run(key, async () => {
      const profileAuthorization = this.deps.captureProfileAuthorization?.(profileId);
      const before = this.requireProfileAccess(profileId, addonId);
      const result = await operation(this.getRegistry());
      this.deps.validateProfileAuthorization?.(profileId, profileAuthorization);
      const after = this.requireProfileAccess(profileId, addonId);
      if (before.reviewToken !== after.reviewToken || before.approvedAt !== after.approvedAt) {
        throw new StremioPluginServiceError(
          'STREMIO_PLUGIN_RESULT_STALE',
          'The add-on approval changed while this request was running.',
          true,
        );
      }
      return result;
    });
  }
}

export function createStremioPluginService(deps: StremioPluginServiceDependencies): StremioPluginService {
  return new StremioPluginService(deps);
}

export function isStremioHostError(error: unknown): error is StremioAdapterError | StremioPluginServiceError {
  return error instanceof StremioAdapterError || error instanceof StremioPluginServiceError;
}
