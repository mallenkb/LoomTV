import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

export type LocalResourceKind = 'media' | 'subtitle' | 'image' | 'external-artwork';

type RegisteredResource = {
  kind: LocalResourceKind;
  value: string;
};

const resources = new Map<string, RegisteredResource>();
const MAX_REGISTERED_RESOURCES = 100_000;

export function registerResource(secret: string, kind: LocalResourceKind, value: string): string {
  const normalized = kind === 'external-artwork' ? value.trim() : path.resolve(value);
  const id = createHmac('sha256', secret).update(`${kind}\0${normalized}`).digest('base64url');
  if (resources.size >= MAX_REGISTERED_RESOURCES && !resources.has(id)) {
    const oldest = resources.keys().next().value;
    if (oldest) resources.delete(oldest);
  }
  resources.set(id, { kind, value: normalized });
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
): string {
  const resource = resources.get(id);
  if (!resource || !allowedKinds.has(resource.kind) || resource.kind === 'external-artwork') {
    throw new Error('Unknown local resource. Refresh the paired library and try again.');
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
