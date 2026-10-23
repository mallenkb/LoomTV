import type { StremioStreamDescriptor } from '@/shared/desktopProtocol';

// No URLs or grants are stored. Ignore changing peer counts when matching a release.
export function sourceFingerprint(addonId: string, stream: StremioStreamDescriptor): string {
  const description = stream.description?.replace(/👤\s*[\d,.]+/gu, '👤');
  const text = JSON.stringify([addonId, stream.name, description]);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
}

export const successfulSourceKey = (profileId: string, type?: string, videoId?: string) =>
  JSON.stringify(['loom:last-successful-addon-source', profileId, type, videoId]);
