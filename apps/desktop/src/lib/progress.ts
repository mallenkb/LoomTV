import { desktopApi, StoredProgress } from '@/lib/desktopApi';

const PROGRESS_KEY = 'videoProgress';
const WATCHED_THRESHOLD = 0.9;
const REPLAY_FROM_START_REMAINING_SECONDS = 8;

type LegacyProgress = number | { position?: number; duration?: number; updatedAt?: number; watched?: boolean };

let progressCache: Record<string, StoredProgress> = readLocalProgress();
let hydrated = false;

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
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progressCache));
    window.dispatchEvent(new Event('loomtv-progress'));
  } catch {
    // Progress still works for this session.
  }
}

function mergeProgress(...sources: Array<Record<string, StoredProgress>>): Record<string, StoredProgress> {
  const merged: Record<string, StoredProgress> = {};
  for (const source of sources) {
    for (const [filePath, progress] of Object.entries(source)) {
      if (!merged[filePath] || (progress.updatedAt || 0) >= (merged[filePath].updatedAt || 0)) {
        merged[filePath] = progress;
      }
    }
  }
  return merged;
}

export async function hydrateProgressFromDatabase(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const localProgress = readLocalProgress();
    if (Object.keys(localProgress).length > 0) {
      await desktopApi.importProgress(localProgress);
    }
    const remote = await desktopApi.getProgress();
    const databaseProgress = remote && !('position' in remote)
      ? remote as Record<string, StoredProgress>
      : {};
    progressCache = mergeProgress(localProgress, databaseProgress);
    writeLocalProgress();
  } catch {
    progressCache = readLocalProgress();
  }
}

export function loadProgress(): Record<string, StoredProgress> {
  return progressCache;
}

export function getProgressState(filePath: string | null, durationHint = 0) {
  if (!filePath) return { position: 0, duration: 0, fraction: 0, watched: false, inProgress: false, updatedAt: 0 };
  const stored = progressCache[filePath];
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
  try {
    const stored = await desktopApi.saveProgress(filePath, local.position, local.duration);
    progressCache = { ...progressCache, [filePath]: stored };
    writeLocalProgress();
  } catch {
    // The local mirror is enough until the main process is reachable again.
  }
}
