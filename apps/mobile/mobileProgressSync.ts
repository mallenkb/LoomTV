import type { StoredProgress } from './mobileDomain';
import type { MobilePendingProgress } from './mobileOfflineCache';

export async function reconcileMobileProgress({ remote, pending, save, remove, isCurrent }: {
  remote: Record<string, StoredProgress>;
  pending: MobilePendingProgress[];
  save: (entry: MobilePendingProgress) => Promise<StoredProgress | null>;
  remove: (entry: MobilePendingProgress) => Promise<void>;
  isCurrent: () => boolean;
}): Promise<Record<string, StoredProgress>> {
  const merged = { ...remote };
  for (const entry of pending) merged[entry.mediaPath] = entry.progress;
  for (const entry of pending) {
    if (!isCurrent()) break;
    try {
      const stored = await save(entry);
      if (!isCurrent()) break;
      if (stored) {
        // Keep the local timestamp until hydration finishes so a delayed
        // response cannot overwrite a newer update in the app's progress map.
        merged[entry.mediaPath] = { ...stored, updatedAt: entry.progress.updatedAt };
        await remove(entry);
      }
    } catch { /* Keep the durable update queued for the next connection. */ }
  }
  return merged;
}
