import { app, powerMonitor } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, LibraryData } from '../appContracts.ts';
import type { EpisodeFile, MediaItem } from '../metadata/types.ts';
import { interruptAnalysisProcesses, isPlaybackActivityActive, millisecondsSincePlaybackActivity } from '../ffmpegGovernor.ts';
import type { SegmentAnalysisInventory } from '../databaseSegmentsRepository.ts';
import type { LocalAnalysisOutcome, SegmentAnalysisStatus } from './types.ts';
import { compareSegmentAnalysisJobs, segmentAnalysisJobKey, type SegmentAnalysisJob, type SegmentAnalysisJobState } from './analysisJobs.ts';
import { selectionConfigHash } from './configHash.ts';
import { mediaFileRevision } from './service.ts';
import { FINGERPRINT_ALGORITHM_VERSION } from './localAnalysis.ts';

export type AnalysisRevision = {
  mediaId: string;
  season: number;
  episode: number;
  filePath: string;
  fileRevision: string;
  itemType: MediaItem['type'];
};

type AnalysisRepository = {
  cancelSegmentAnalysisJobs: (jobKey?: string) => number;
  cleanupOrphanedAnalysisData: (activeRevisions: string[], limit?: number) => number;
  enqueueSegmentAnalysisJob: (job: SegmentAnalysisJob) => void;
  fingerprintCacheBytes: () => number;
  fingerprintCount: () => number;
  getSegmentAnalysisInventory: (fileRevisions?: string[]) => SegmentAnalysisInventory[];
  getSegmentAnalysisJobCounts: () => Partial<Record<SegmentAnalysisJobState, number>>;
  getSegmentAnalysisJobs: (states?: SegmentAnalysisJobState[], limit?: number) => SegmentAnalysisJob[];
  recoverRunningSegmentAnalysisJobs: () => number;
  requeueWaitingSegmentAnalysisJobs: (mediaId: string, season: number) => number;
  resetAutomaticAnalysisData: () => number;
  saveSegmentAnalysisInventory: (value: SegmentAnalysisInventory) => void;
  updateSegmentAnalysisJob: (jobKey: string, state: SegmentAnalysisJobState, detail?: string) => void;
};

function defaultAudioTrack(file: EpisodeFile): number {
  return file.localMetadata?.tracks?.find((track) => track.type === 'audio' && track.default)?.index
    ?? file.localMetadata?.tracks?.find((track) => track.type === 'audio')?.index
    ?? 0;
}

function revisionFor(item: MediaItem, file: EpisodeFile): AnalysisRevision | null {
  if (!file.filePath || !fs.existsSync(file.filePath)) return null;
  const durationMs = Math.round((file.localMetadata?.durationSeconds || 0) * 1000);
  if (!durationMs) return null;
  return {
    mediaId: item.id,
    season: file.season,
    episode: file.episode,
    filePath: file.filePath,
    fileRevision: mediaFileRevision(file.filePath, durationMs, defaultAudioTrack(file), file.localMetadata),
    itemType: item.type,
  };
}

function isExcluded(item: MediaItem, revision: AnalysisRevision, settings: AppSettings): boolean {
  const configured = settings.skipAnalysis;
  if (!configured) return false;
  if (revision.itemType !== 'movie' && revision.season === 0 && !configured.analyzeSpecials) return true;
  if ((revision.itemType === 'movie' ? configured.exclusions.movieIds : configured.exclusions.seriesIds).includes(item.id)) return true;
  if (configured.exclusions.seasons.includes(`${item.id}:${revision.season}`)) return true;
  const resolved = path.resolve(revision.filePath);
  return configured.exclusions.paths.some((entry) => resolved === path.resolve(entry) || resolved.startsWith(`${path.resolve(entry)}${path.sep}`));
}

export function libraryAnalysisRevisions(library: LibraryData, settings: AppSettings): AnalysisRevision[] {
  const revisions: AnalysisRevision[] = [];
  for (const item of [...(library.tvShows || []), ...(library.animeShows || [])]) {
    for (const file of item.episodeFiles || []) {
      const revision = revisionFor(item, file);
      if (revision && !isExcluded(item, revision, settings)) revisions.push(revision);
    }
  }
  for (const item of library.movies || []) {
    if (!item.filePath) continue;
    const file: EpisodeFile = { season: 0, episode: 0, filePath: item.filePath, localMetadata: item.localMetadata };
    const revision = revisionFor(item, file);
    if (revision && !isExcluded(item, revision, settings)) revisions.push(revision);
  }
  return revisions;
}

export function createAnalysisCoordinator(deps: {
  loadLibrary: () => LibraryData;
  loadSettings: () => AppSettings;
  detector: {
    analyzeRevision: (mediaId: string, season: number, fileRevision: string, shouldContinue?: () => boolean) => Promise<LocalAnalysisOutcome>;
    status: () => SegmentAnalysisStatus;
  };
  repository: AnalysisRepository;
  runtime?: {
    isReady: () => boolean;
    isOnBatteryPower: () => boolean;
    idleSeconds: () => number;
    onAc: (listener: () => void) => void;
    onBattery: (listener: () => void) => void;
  };
  activity?: {
    interrupt: () => void;
    isActive: () => boolean;
    millisecondsSince: () => number;
  };
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let onAcPower = true;
  let paused = false;
  let currentJob: SegmentAnalysisJob | null = null;
  let manualNonce = 0;
  const cancelledJobs = new Set<string>();
  let reconciledConfigHash: string | null = null;
  const runtime = deps.runtime || {
    isReady: () => app.isReady(),
    isOnBatteryPower: () => powerMonitor.isOnBatteryPower(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onAc: (listener: () => void) => { powerMonitor.on('on-ac', listener); },
    onBattery: (listener: () => void) => { powerMonitor.on('on-battery', listener); },
  };
  const activity = deps.activity || {
    interrupt: interruptAnalysisProcesses,
    isActive: isPlaybackActivityActive,
    millisecondsSince: millisecondsSincePlaybackActivity,
  };

  function configHash(): string {
    const settings = deps.loadSettings().skipAnalysis;
    if (!settings) throw new Error('Skip-analysis settings are unavailable.');
    return selectionConfigHash(settings);
  }

  function enqueue(revision: AnalysisRevision, kind: SegmentAnalysisJob['kind'], detail: string): void {
    const now = Date.now();
    const hash = configHash();
    const scope = { mediaId: revision.mediaId, season: revision.season, episode: revision.episode };
    const revisionKey = kind === 'manual' ? `${revision.fileRevision}:${now}:${manualNonce += 1}` : revision.fileRevision;
    deps.repository.enqueueSegmentAnalysisJob({
      ...scope,
      jobKey: segmentAnalysisJobKey(kind, scope, revisionKey, hash),
      kind,
      fileRevision: revision.fileRevision,
      configHash: hash,
      state: 'pending',
      detail,
      createdAt: now,
      updatedAt: now,
    });
  }

  function onLibrarySaved(previous: LibraryData, next: LibraryData): void {
    const settings = deps.loadSettings();
    const oldRevisions = new Set(libraryAnalysisRevisions(previous, settings).map((entry) => entry.fileRevision));
    const nextRevisions = libraryAnalysisRevisions(next, settings);
    cleanup();
    if (settings.skipAnalysis?.analyzeNewMedia === false || settings.localSkipAnalysisEnabled === false) return;
    for (const revision of nextRevisions) {
      if (!oldRevisions.has(revision.fileRevision)) enqueue(revision, 'incremental', 'New or changed library content');
    }
    const availableBySeason = new Map<string, number>();
    for (const revision of nextRevisions) {
      const key = `${revision.mediaId}:${revision.season}`;
      availableBySeason.set(key, (availableBySeason.get(key) || 0) + 1);
    }
    for (const [key, count] of availableBySeason) {
      if (count < 3) continue;
      const separator = key.lastIndexOf(':');
      deps.repository.requeueWaitingSegmentAnalysisJobs(key.slice(0, separator), Number(key.slice(separator + 1)));
    }
  }

  function enqueueRecomputeIfNeeded(force = false): void {
    const settings = deps.loadSettings();
    if (settings.localSkipAnalysisEnabled === false || settings.skipAnalysis?.enabled === false) {
      reconciledConfigHash = null;
      return;
    }
    const currentHash = configHash();
    const reconciliationKey = `${currentHash}:${settings.skipAnalysis?.analyzeNewMedia !== false}`;
    if (!force && reconciledConfigHash === reconciliationKey) return;
    reconciledConfigHash = reconciliationKey;
    const revisions = libraryAnalysisRevisions(deps.loadLibrary(), settings);
    for (let offset = 0; offset < revisions.length; offset += 400) {
      const batch = revisions.slice(offset, offset + 400);
      const inventory = new Map(deps.repository.getSegmentAnalysisInventory(batch.map((entry) => entry.fileRevision))
        .map((entry) => [entry.fileRevision, entry]));
      for (const revision of batch) {
        const stored = inventory.get(revision.fileRevision);
        if (!stored && settings.skipAnalysis?.analyzeNewMedia !== false) enqueue(revision, 'incremental', 'Existing content has not been analyzed');
        else if (stored && stored.fingerprintVersion !== FINGERPRINT_ALGORITHM_VERSION) enqueue(revision, 'hash-recompute', 'Fingerprint extraction changed');
        else if (stored && stored.configHash !== currentHash) enqueue(revision, 'hash-recompute', 'Analysis settings changed');
      }
    }
  }

  async function runJob(job: SegmentAnalysisJob): Promise<void> {
    const startedAt = Date.now();
    currentJob = job;
    deps.repository.updateSegmentAnalysisJob(job.jobKey, 'running', job.detail);
    try {
      if (job.kind === 'cleanup') {
        const revisions = libraryAnalysisRevisions(deps.loadLibrary(), deps.loadSettings());
        const removed = deps.repository.cleanupOrphanedAnalysisData(revisions.map((entry) => entry.fileRevision), 1000);
        deps.repository.updateSegmentAnalysisJob(
          job.jobKey,
          removed >= 1000 ? 'pending' : 'complete',
          removed >= 1000 ? `Removed ${removed} stale entries; cleanup will continue` : `Cleanup complete; removed ${removed} stale entries`,
        );
        return;
      }
      const outcome = await deps.detector.analyzeRevision(
        job.mediaId,
        job.season,
        job.fileRevision,
        () => !paused && !cancelledJobs.has(job.jobKey) && !activity.isActive(),
      );
      if (outcome.kind === 'waiting_for_peers') {
        deps.repository.updateSegmentAnalysisJob(job.jobKey, 'waiting_for_peers', outcome.detail);
        return;
      }
      if (cancelledJobs.has(job.jobKey)) throw new Error('Analysis was cancelled.');
      if (paused) throw new Error('Analysis was paused.');
      if (activity.isActive()) throw new Error('Playback became active; analysis was queued again.');
      deps.repository.saveSegmentAnalysisInventory({
        fileRevision: job.fileRevision,
        mediaId: job.mediaId,
        season: job.season,
        episode: job.episode,
        configHash: job.configHash,
        fingerprintVersion: FINGERPRINT_ALGORITHM_VERSION,
        analyzedAt: Date.now(),
      });
      deps.repository.updateSegmentAnalysisJob(job.jobKey, 'complete', 'Analysis complete');
      console.info('[skip-segments] job complete', {
        jobKey: job.jobKey, kind: job.kind, mediaId: job.mediaId, season: job.season,
        episode: job.episode, durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Background analysis failed.';
      if (cancelledJobs.has(job.jobKey)) deps.repository.updateSegmentAnalysisJob(job.jobKey, 'cancelled', 'Cancelled by user');
      else if (paused) {
        deps.repository.updateSegmentAnalysisJob(job.jobKey, 'pending', 'Paused by user');
        console.info('[skip-segments] job paused', { jobKey: job.jobKey, reason: 'user', durationMs: Date.now() - startedAt });
      } else if (activity.isActive() || message.includes('interrupted')) {
        deps.repository.updateSegmentAnalysisJob(job.jobKey, 'pending', 'Paused for playback');
        console.info('[skip-segments] job paused', { jobKey: job.jobKey, reason: 'playback', durationMs: Date.now() - startedAt });
      }
      else {
        deps.repository.updateSegmentAnalysisJob(job.jobKey, 'error', message);
        console.warn(`[skip-segments] ${message}`);
      }
    } finally {
      cancelledJobs.delete(job.jobKey);
      currentJob = null;
    }
  }

  async function tick(): Promise<void> {
    if (paused || currentJob || !onAcPower) return;
    if (runtime.idleSeconds() < 300 || activity.isActive() || activity.millisecondsSince() < 60_000) return;
    enqueueRecomputeIfNeeded();
    const job = deps.repository.getSegmentAnalysisJobs(['pending'], 1000).sort(compareSegmentAnalysisJobs)[0];
    if (job?.kind !== 'cleanup' && deps.loadSettings().skipAnalysis?.enabled === false) return;
    if (job) await runJob(job);
  }

  function enqueueScope(input?: { mediaId?: string; season?: number; episode?: number }): number {
    const settings = deps.loadSettings();
    const revisions = libraryAnalysisRevisions(deps.loadLibrary(), settings).filter((revision) =>
      (!input?.mediaId || revision.mediaId === input.mediaId)
      && (input?.season === undefined || revision.season === input.season)
      && (input?.episode === undefined || revision.episode === input.episode));
    for (const revision of revisions) enqueue(revision, 'manual', 'Manual analysis request');
    return revisions.length;
  }

  function cancel(jobKey?: string): number {
    if (currentJob && (!jobKey || currentJob.jobKey === jobKey)) cancelledJobs.add(currentJob.jobKey);
    const cancelled = deps.repository.cancelSegmentAnalysisJobs(jobKey);
    if (!jobKey || currentJob?.jobKey === jobKey) activity.interrupt();
    return cancelled;
  }

  function status(): SegmentAnalysisStatus {
    const detector = deps.detector.status();
    const jobs = deps.repository.getSegmentAnalysisJobs(undefined, 250);
    const counts = deps.repository.getSegmentAnalysisJobCounts();
    const lastError = jobs.find((job) => job.state === 'error');
    const lastCompleted = jobs.find((job) => job.state === 'complete');
    return {
      ...detector,
      paused,
      state: paused ? 'paused' : currentJob ? 'running' : jobs.some((job) => job.state === 'pending' || job.state === 'waiting_for_peers') ? 'queued' : detector.state,
      pendingCount: (counts.pending || 0) + (counts.waiting_for_peers || 0),
      currentJob: currentJob ? {
        jobKey: currentJob.jobKey, kind: currentJob.kind, mediaId: currentJob.mediaId,
        season: currentJob.season, episode: currentJob.episode, detail: currentJob.detail,
      } : undefined,
      lastError: lastError?.detail,
      fingerprintCount: deps.repository.fingerprintCount(),
      fingerprintCacheBytes: deps.repository.fingerprintCacheBytes(),
      progress: {
        complete: counts.complete || 0,
        total: Object.values(counts).reduce((sum, count) => sum + (count || 0), 0),
      },
      lastCompletedAt: lastCompleted?.updatedAt,
      recentJobs: jobs.slice(0, 25).map((job) => ({
        jobKey: job.jobKey,
        kind: job.kind,
        mediaId: job.mediaId,
        season: job.season,
        episode: job.episode,
        state: job.state,
        detail: job.detail,
        updatedAt: job.updatedAt,
      })),
    };
  }

  function cleanup(): number {
    const now = Date.now();
    const scope = { mediaId: '__maintenance__', season: 0, episode: 0 };
    deps.repository.enqueueSegmentAnalysisJob({
      ...scope,
      jobKey: segmentAnalysisJobKey('cleanup', scope, 'orphaned-analysis-data', configHash()),
      kind: 'cleanup',
      fileRevision: '__maintenance__',
      configHash: configHash(),
      state: 'pending',
      detail: 'Queued stale-cache cleanup',
      createdAt: now,
      updatedAt: now,
    });
    return 1;
  }

  function rebuild(): { removed: number; queued: number } {
    cancel();
    const removed = deps.repository.resetAutomaticAnalysisData();
    reconciledConfigHash = null;
    return { removed, queued: enqueueScope() };
  }

  function settingsChanged(): void {
    reconciledConfigHash = null;
    enqueueRecomputeIfNeeded();
  }

  function start(): void {
    if (timer || !runtime.isReady()) return;
    onAcPower = !runtime.isOnBatteryPower();
    deps.repository.recoverRunningSegmentAnalysisJobs();
    enqueueRecomputeIfNeeded();
    cleanup();
    runtime.onAc(() => { onAcPower = true; });
    runtime.onBattery(() => { onAcPower = false; });
    timer = setInterval(() => { void tick(); }, 60_000);
    timer.unref?.();
  }

  return {
    cancel,
    cleanup,
    enqueueScope,
    onLibrarySaved,
    pause: () => { paused = true; activity.interrupt(); },
    resume: () => { paused = false; },
    rebuild,
    settingsChanged,
    start,
    stop: () => { if (timer) clearInterval(timer); timer = null; },
    status,
    tick,
  };
}
