import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

export type LocalResourceKind = 'media' | 'subtitle' | 'image' | 'external-artwork';

type RegisteredResource = {
  kind: LocalResourceKind;
  value: string;
  scopePath?: string;
};

const resources = new Map<string, RegisteredResource>();
const MAX_REGISTERED_RESOURCES = 100_000;

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
): string {
  const normalized = kind === 'external-artwork' ? value.trim() : path.resolve(value);
  const normalizedResourceScope = scopePath ? normalizedScopePath(scopePath) : undefined;
  const identity = normalizedResourceScope
    ? `${kind}\0${normalized}\0scope\0${normalizedResourceScope}`
    : `${kind}\0${normalized}`;
  const id = createHmac('sha256', secret).update(identity).digest('base64url');
  if (resources.size >= MAX_REGISTERED_RESOURCES && !resources.has(id)) {
    const oldest = resources.keys().next().value;
    if (oldest) resources.delete(oldest);
  }
  resources.set(id, { kind, value: normalized, scopePath: normalizedResourceScope });
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
  return candidate;
}

export function resolveExternalArtworkResource(id: string): string {
  const resource = resources.get(id);
  if (!resource || resource.kind !== 'external-artwork') throw new Error('Unknown artwork resource.');
  return resource.value;
}
