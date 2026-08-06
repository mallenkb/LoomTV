import { useEffect, useSyncExternalStore } from 'react';
import { desktopApi, type StoredProgress } from '@/lib/desktopApi';
import { createProgressRefreshSubscription } from '@/lib/progressSubscription';

const PROGRESS_KEY = 'videoProgress';
const PROGRESS_MIGRATION_KEY = 'loomtvProgressMigrationVersion';
const PROGRESS_MIGRATION_VERSION = '1';
const WATCHED_THRESHOLD = 0.9;
const REPLAY_FROM_START_REMAINING_SECONDS = 8;

type LegacyProgress = number | { position?: number; duration?: number; updatedAt?: number; watched?: boolean };

let progressCache: Record<string, StoredProgress> = readLocalProgress();
let hydrated = false;
let progressRefreshRevision = 0;
let activeProfileId: string | null = null;
let profileGeneration = 0;
const pendingWrites = new Set<Promise<void>>();
let dispatchingInternalProgressEvent = false;
let progressRefreshSubscription: ReturnType<typeof createProgressRefreshSubscription> | null = null;

function normalizeProgress(value: LegacyProgress | StoredProgress | null | undefined): StoredProgress | null {
  if (value == null) return null;
  const position = typeof value === 'number' ? value : Number(value.position || 0);
  const duration = typeof value === 'object' ? Number(value.duration || 0) : 0;
  const updatedAt = typeof value === 'object' && value.updatedAt ? Number(value.updatedAt) : 0;
  const watched = duration > 0 && position / duration >= WATCHED_THRESHOLD;
  return {
    position: watched ? duration : position,
    duration,
    updatedAt,
    watched,
  };
}

function readLocalProgress(): Record<string, StoredProgress> {
  try {
    const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') as Record<string, LegacyProgress>;
    return Object.fromEntries(Object.entries(raw)
      .map(([filePath, value]) => [filePath, normalizeProgress(value)] as const)
      .filter((entry): entry is readonly [string, StoredProgress] => Boolean(entry[1])));
  } catch {
    return {};
  }
}

function writeLocalProgress(): void {
  const subscription = getProgressRefreshSubscription();
  if (subscription) subscription.publish();
  else progressRefreshRevision += 1;

  dispatchingInternalProgressEvent = true;
  try {
    window.dispatchEvent(new Event('loomtv-progress'));
  } finally {
    dispatchingInternalProgressEvent = false;
  }
}

function getProgressRefreshSubscription() {
  if (typeof window === 'undefined') return null;
  if (!progressRefreshSubscription) {
    progressRefreshSubscription = createProgressRefreshSubscription({
      eventTarget: window,
      onRefresh: () => {
        progressRefreshRevision += 1;
      },
      setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
      clearInterval: (timerId) => window.clearInterval(timerId),
      shouldRefreshEvent: () => !dispatchingInternalProgressEvent,
    });
  }
  return progressRefreshSubscription;
}

function subscribeToProgress(listener: () => void): () => void {
  return getProgressRefreshSubscription()?.subscribe(listener) || (() => undefined);
}

function progressDataSnapshot(): Record<string, StoredProgress> {
  return progressCache;
}

function progressRevisionSnapshot(): number {
  return progressRefreshRevision;
}

function mergeProgress(...sources: Array<Record<string, StoredProgress>>): Record<string, StoredProgress> {
  const merged: Record<string, StoredProgress> = {};
  for (const source of sources) {
    for (const [filePath, progress] of Object.entries(source)) {
      if (!merged[filePath] || (progress.updatedAt || 0) > (merged[filePath].updatedAt || 0)) {
        merged[filePath] = progress;
      }
    }
  }
  return merged;
}

export async function hydrateProgressFromDatabase(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  const generation = profileGeneration;
  try {
    const localProgress = localStorage.getItem(PROGRESS_MIGRATION_KEY) === PROGRESS_MIGRATION_VERSION
      ? {}
      : readLocalProgress();
    const remote = await desktopApi.getProgress();
    if (generation !== profileGeneration) return;
    const databaseProgress = remote && !('position' in remote)
      ? remote as Record<string, StoredProgress>
      : {};
    // Database is merged first and therefore wins equal timestamps.
    progressCache = mergeProgress(databaseProgress, localProgress);
    // Only legacy localStorage progress is imported; re-importing the
    // database's own rows would be wasted writes, and after a profile switch
    // it must never happen at all.
    if (Object.keys(localProgress).length > 0) {
      await desktopApi.importProgress(progressCache, activeProfileId ?? undefined);
      if (generation !== profileGeneration) return;
    }
    localStorage.setItem(PROGRESS_MIGRATION_KEY, PROGRESS_MIGRATION_VERSION);
    localStorage.removeItem(PROGRESS_KEY);
    writeLocalProgress();
  } catch {
    progressCache = readLocalProgress();
    writeLocalProgress();
  }
}

export async function setProgressProfile(profileId: string | null): Promise<void> {
  if (activeProfileId === profileId && hydrated) return;
  activeProfileId = profileId;
  profileGeneration += 1;
  progressCache = {};
  hydrated = false;
  writeLocalProgress();
  if (profileId) await hydrateProgressFromDatabase();
}

export async function flushProgressWrites(): Promise<void> {
  await Promise.allSettled([...pendingWrites]);
}

export function useProgressSnapshot(): Record<string, StoredProgress> {
  const progress = useSyncExternalStore(subscribeToProgress, progressDataSnapshot, progressDataSnapshot);
  useEffect(() => {
    void hydrateProgressFromDatabase();
  }, []);
  return progress;
}

export function useProgressRefreshRevision(): number {
  const revision = useSyncExternalStore(subscribeToProgress, progressRevisionSnapshot, progressRevisionSnapshot);
  useEffect(() => {
    void hydrateProgressFromDatabase();
  }, []);
  return revision;
}

export function getProgressState(filePath: string | null, durationHint = 0) {
  if (!filePath) return { position: 0, duration: 0, fraction: 0, watched: false, inProgress: false, updatedAt: 0 };
  let resourceKey = filePath;
  try {
    const parsed = new URL(filePath);
    resourceKey = parsed.searchParams.get('resourceId') || parsed.searchParams.get('mediaId') || filePath;
  } catch {
    // Local paths and compact resource IDs are already valid progress keys.
  }
  const stored = progressCache[filePath] || progressCache[resourceKey];
  const position = stored?.position ?? 0;
  const storedDuration = stored?.duration ?? 0;
  const duration = durationHint > 0 ? durationHint : storedDuration;
  const fraction = position > 0 && duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const watched = duration > 0 && fraction >= WATCHED_THRESHOLD;
  const inProgress = position > 10 && !watched;
  return { position, duration, fraction, watched, inProgress, updatedAt: stored?.updatedAt || 0 };
}

export function getPlayableStartPosition(filePath: string, durationHint = 0): number {
  const progress = getProgressState(filePath, durationHint);
  if (!progress.position || progress.position <= 10) return 0;
  if (!progress.duration || progress.duration <= 0) return progress.position;

  const remaining = progress.duration - progress.position;
  if (progress.watched || remaining <= REPLAY_FROM_START_REMAINING_SECONDS) return 0;
  return progress.position;
}

export function progressFraction(filePath: string, duration?: number): number {
  return getProgressState(filePath, duration).fraction;
}

export function isWatched(filePath: string, duration?: number): boolean {
  return getProgressState(filePath, duration).watched;
}

export async function saveProgress(filePath: string, position: number, duration: number): Promise<void> {
  const local = normalizeProgress({ position, duration, updatedAt: Date.now() });
  if (!local || local.position <= 10 || local.duration <= 0) return;
  progressCache = { ...progressCache, [filePath]: local };
  writeLocalProgress();
  const generation = profileGeneration;
  const profileId = activeProfileId ?? undefined;
  const write = desktopApi.saveProgress(filePath, local.position, local.duration, profileId)
    .then((stored) => {
      if (generation !== profileGeneration || profileId !== activeProfileId) return;
      progressCache = { ...progressCache, [filePath]: stored };
      writeLocalProgress();
    })
    .catch(() => {
      // The local mirror is enough until the main process is reachable again.
    });
  pendingWrites.add(write);
  await write.finally(() => pendingWrites.delete(write));
}
