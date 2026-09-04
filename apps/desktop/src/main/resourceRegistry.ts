import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

export type LocalResourceKind = 'media' | 'subtitle' | 'image' | 'external-artwork';

type RegisteredResource = {
  kind: LocalResourceKind;
  value: string;
  scopePath?: string;
  ownerId?: string;
  catalogGeneration: number;
  lastUsedAt: number;
};

const resources = new Map<string, RegisteredResource>();
const MAX_REGISTERED_RESOURCES = 100_000;
const PREVIOUS_CATALOG_GENERATIONS_TO_KEEP = 1;
const RESOURCE_EXPIRY_MS = 30 * 60 * 1_000;
const RESOURCE_PRUNE_BATCH_SIZE = 64;
let currentCatalogGeneration = 0;
let resourcePruneIterator: IterableIterator<[string, RegisteredResource]> | null = null;

function pruneExpiredResources(now = Date.now(), includeGeneration = false): void {
  const oldestAllowedGeneration = Math.max(
    0,
    currentCatalogGeneration - PREVIOUS_CATALOG_GENERATIONS_TO_KEEP,
  );
  if (includeGeneration) {
    for (const [id, resource] of resources) {
      const expiredByGeneration = resource.catalogGeneration < oldestAllowedGeneration;
      const expiredByTime = resource.catalogGeneration < currentCatalogGeneration
        && now - resource.lastUsedAt >= RESOURCE_EXPIRY_MS;
      if (expiredByGeneration || expiredByTime) resources.delete(id);
    }
    resourcePruneIterator = null;
    return;
  }

  resourcePruneIterator ??= resources.entries();
  for (let scanned = 0; scanned < RESOURCE_PRUNE_BATCH_SIZE; scanned += 1) {
    const next = resourcePruneIterator.next();
    if (next.done) {
      resourcePruneIterator = null;
      return;
    }
    const [id, resource] = next.value;
    if (
      resources.get(id) === resource
      && resource.catalogGeneration < currentCatalogGeneration
      && now - resource.lastUsedAt >= RESOURCE_EXPIRY_MS
    ) {
      resources.delete(id);
    }
  }
}

/**
 * Advances the catalog epoch without changing the deterministic resource IDs.
 * The current and immediately previous epochs remain resolvable so a paired
 * client can finish a request while it observes a catalog refresh. Expiry is
 * opportunistic: callers pay no timer or background-task cost.
 */
export function setResourceRegistryCatalogGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= currentCatalogGeneration) return;
  currentCatalogGeneration = generation;
  pruneExpiredResources(Date.now(), true);
}

function normalizedScopePath(scopePath: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(scopePath)) {
    throw new Error('Local resource scopes must use filesystem paths.');
  }
  return path.resolve(scopePath);
}

function canonicalExistingPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function registerResource(
  secret: string,
  kind: LocalResourceKind,
  value: string,
  scopePath?: string,
  ownerId?: string,
): string {
  const now = Date.now();
  pruneExpiredResources(now);
  const normalized = kind === 'external-artwork' ? value.trim() : path.resolve(value);
  const normalizedResourceScope = scopePath ? normalizedScopePath(scopePath) : undefined;
  const normalizedOwnerId = ownerId?.trim();
  if (normalizedOwnerId && (kind !== 'external-artwork' || normalizedOwnerId.length > 256)) {
    throw new Error('Only bounded external artwork resources may have an owner.');
  }
  const identity = normalizedResourceScope
    ? `${kind}\0${normalized}\0scope\0${normalizedResourceScope}`
    : `${kind}\0${normalized}${normalizedOwnerId ? `\0owner\0${normalizedOwnerId}` : ''}`;
  const id = createHmac('sha256', secret).update(identity).digest('base64url');
  if (resources.has(id)) {
    // Re-registering an existing capability is a use and should refresh its
    // position in the bounded registry rather than leaving it FIFO-stale.
    resources.delete(id);
  } else if (resources.size >= MAX_REGISTERED_RESOURCES) {
    const oldest = resources.keys().next().value;
    if (oldest) resources.delete(oldest);
  }
  resources.set(id, {
    kind,
    value: normalized,
    scopePath: normalizedResourceScope,
    ownerId: normalizedOwnerId,
    catalogGeneration: currentCatalogGeneration,
    lastUsedAt: now,
  });
  return id;
}

function isContained(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveLocalResource(
  id: string,
  allowedKinds: ReadonlySet<LocalResourceKind>,
  libraryRoots: readonly string[],
  expectedScopePath?: string,
): string {
  pruneExpiredResources();
  const resource = resources.get(id);
  if (!resource || !allowedKinds.has(resource.kind) || resource.kind === 'external-artwork') {
    throw new Error('Unknown local resource. Refresh the paired library and try again.');
  }
  if (
    expectedScopePath
    && (
      !resource.scopePath
      || canonicalExistingPath(resource.scopePath) !== canonicalExistingPath(normalizedScopePath(expectedScopePath))
    )
  ) {
    throw new Error('The requested resource does not belong to this media item.');
  }
  const candidate = fs.realpathSync.native(resource.value);
  const contained = libraryRoots.some((root) => {
    try {
      return isContained(candidate, fs.realpathSync.native(root));
    } catch {
      return false;
    }
  });
  if (!contained || !fs.statSync(candidate).isFile()) {
    throw new Error('The requested resource is outside the configured library.');
  }
  resources.delete(id);
  resource.catalogGeneration = currentCatalogGeneration;
  resource.lastUsedAt = Date.now();
  resources.set(id, resource);
  return candidate;
}


export function resolveExternalArtworkResourceContext(id: string): { sourceUrl: string; ownerId?: string } {
  pruneExpiredResources();
  const resource = resources.get(id);
  if (!resource || resource.kind !== 'external-artwork') throw new Error('Unknown artwork resource.');
  resources.delete(id);
  resource.catalogGeneration = currentCatalogGeneration;
  resource.lastUsedAt = Date.now();
  resources.set(id, resource);
  return { sourceUrl: resource.value, ...(resource.ownerId ? { ownerId: resource.ownerId } : {}) };
}
