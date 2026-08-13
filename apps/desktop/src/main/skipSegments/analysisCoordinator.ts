import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, LibraryData } from '../appContracts.ts';
import type { EpisodeFile, MediaItem } from '../metadata/types.ts';
import { interruptAnalysisProcesses, isPlaybackActivityActive, millisecondsSincePlaybackActivity } from '../ffmpegGovernor.ts';
import type { SegmentAnalysisInventory } from '../databaseSegmentsRepository.ts';
import type { LocalAnalysisOutcome, SegmentAnalysisPhaseProgress, SegmentAnalysisStatus } from './types.ts';
import { compareSegmentAnalysisJobs, segmentAnalysisJobKey, type SegmentAnalysisJob, type SegmentAnalysisJobState } from './analysisJobs.ts';
import { selectionConfigHash } from './configHash.ts';
import { FINGERPRINT_ALGORITHM_VERSION, mediaFileRevision } from './fileIdentity.ts';

export type AnalysisRevision = {
  mediaId: string;
  season: number;
  episode: number;
  filePath: string;
  fileRevision: string;
  itemType: MediaItem['type'];
};

type AnalysisRepository = {
  cancelSegmentAnalysisJobs: (jobKey?: string, kind?: SegmentAnalysisJob['kind'], preserveWaiting?: boolean) => number;
  cleanupOrphanedAnalysisData: (activeRevisions: string[], limit?: number) => number;
  enqueueSegmentAnalysisJob: (job: SegmentAnalysisJob) => void;
  fingerprintCacheBytes: () => number;
  fingerprintCount: () => number;
  getSegmentAnalysisInventory: (fileRevisions?: string[]) => SegmentAnalysisInventory[];
  getSegmentAnalysisJobCounts: (kind?: SegmentAnalysisJob['kind']) => Partial<Record<SegmentAnalysisJobState, number>>;
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
    analyzeSeasonBatch: (
      mediaId: string,
      season: number,
      fileRevisions: string[],
      shouldContinue?: () => boolean,
      onProgress?: (progress: SegmentAnalysisPhaseProgress) => void,
      onOutcome?: (fileRevision: string, outcome: LocalAnalysisOutcome) => void,
    ) => Promise<Map<string, LocalAnalysisOutcome>>;
    status: () => SegmentAnalysisStatus;
  };
  repository: AnalysisRepository;
  // Injected by the composition root so this module never imports Electron;
  // pure coordinator tests must load under plain Node.
  runtime: {
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
  let currentGroup: SegmentAnalysisJob[] = [];
  let currentPhaseProgress: SegmentAnalysisPhaseProgress | null = null;
  let drainPromise: Promise<void> | null = null;
  let manualPreemptionRequested = false;
  let manualNonce = 0;
  const cancelledJobs = new Set<string>();
  let reconciledConfigHash: string | null = null;
  const runtime = deps.runtime;
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

  function analysisEnabled(): boolean {
    const settings = deps.loadSettings();
    return settings.localSkipAnalysisEnabled !== false && settings.skipAnalysis?.enabled !== false;
  }

  // File revisions are stable until the library or selection settings change.
  // Cache them so the two-second status poll never repeats synchronous NAS
  // existence/stat work while analysis is already reading media.
  let cachedAnalysisRevisions: AnalysisRevision[] | null = null;
  let librarySummary: { analyzed: number; waiting: number; total: number; computedAt: number } | null = null;

  function currentAnalysisRevisions(): AnalysisRevision[] {
    if (!cachedAnalysisRevisions) {
      cachedAnalysisRevisions = libraryAnalysisRevisions(deps.loadLibrary(), deps.loadSettings());
    }
    return cachedAnalysisRevisions;
  }

  function libraryCoverage(): { analyzed: number; waiting: number; total: number } {
    const now = Date.now();
    if (librarySummary && now - librarySummary.computedAt < 10_000) return librarySummary;
    const currentHash = configHash();
    const revisions = currentAnalysisRevisions();
    let analyzed = 0;
    for (let offset = 0; offset < revisions.length; offset += 400) {
      const batch = revisions.slice(offset, offset + 400);
      const inventory = deps.repository.getSegmentAnalysisInventory(batch.map((entry) => entry.fileRevision));
      analyzed += inventory.filter((entry) =>
        entry.fingerprintVersion === FINGERPRINT_ALGORITHM_VERSION && entry.configHash === currentHash).length;
    }
    const activeRevisions = new Set(revisions.map((entry) => entry.fileRevision));
    const waiting = new Set(deps.repository.getSegmentAnalysisJobs(['waiting_for_peers'], 1000)
      .filter((job) => job.configHash === currentHash && activeRevisions.has(job.fileRevision))
      .map((job) => job.fileRevision)).size;
    librarySummary = { analyzed, waiting, total: revisions.length, computedAt: now };
    return librarySummary;
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
    librarySummary = null;
    const settings = deps.loadSettings();
    const oldRevisions = new Set(libraryAnalysisRevisions(previous, settings).map((entry) => entry.fileRevision));
    const nextRevisions = libraryAnalysisRevisions(next, settings);
    cachedAnalysisRevisions = nextRevisions;
    cleanup();
    if (settings.skipAnalysis?.analyzeNewMedia === false || settings.localSkipAnalysisEnabled === false) {
      void drain();
      return;
    }
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
    void drain();
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
    const revisions = currentAnalysisRevisions();
    const activeJobRevisions = new Set(deps.repository
      .getSegmentAnalysisJobs(['pending', 'running', 'waiting_for_peers'], 1000)
      .filter((job) => job.configHash === currentHash)
      .map((job) => job.fileRevision));
    for (let offset = 0; offset < revisions.length; offset += 400) {
      const batch = revisions.slice(offset, offset + 400);
      const inventory = new Map(deps.repository.getSegmentAnalysisInventory(batch.map((entry) => entry.fileRevision))
        .map((entry) => [entry.fileRevision, entry]));
      for (const revision of batch) {
        if (activeJobRevisions.has(revision.fileRevision)) continue;
        const stored = inventory.get(revision.fileRevision);
        if (!stored && settings.skipAnalysis?.analyzeNewMedia !== false) enqueue(revision, 'incremental', 'Existing content has not been analyzed');
        else if (stored && stored.fingerprintVersion !== FINGERPRINT_ALGORITHM_VERSION) enqueue(revision, 'hash-recompute', 'Fingerprint extraction changed');
        else if (stored && stored.configHash !== currentHash) enqueue(revision, 'hash-recompute', 'Analysis settings changed');
      }
    }
  }

  // Manual scans start as soon as playback is quiet; background work keeps the
  // original protections (AC power, 5-minute system idle, post-playback grace).
  function jobEligible(job: SegmentAnalysisJob): boolean {
    if (activity.isActive()) return false;
    if (job.kind === 'manual') return true;
    return onAcPower && runtime.idleSeconds() >= 300 && activity.millisecondsSince() >= 60_000;
  }

  async function runJobGroup(group: SegmentAnalysisJob[]): Promise<void> {
    const startedAt = Date.now();
    const primary = group[0];
    const settledJobKeys = new Set<string>();
    currentJob = primary;
    currentGroup = group;
    currentPhaseProgress = null;
    for (const job of group) deps.repository.updateSegmentAnalysisJob(job.jobKey, 'running', job.detail);

    const applyOutcome = (fileRevision: string, outcome: LocalAnalysisOutcome): void => {
      for (const job of group) {
        if (job.fileRevision !== fileRevision || settledJobKeys.has(job.jobKey)) continue;
        if (outcome.kind === 'error') {
          deps.repository.updateSegmentAnalysisJob(job.jobKey, 'error', outcome.detail);
        } else if (outcome.kind === 'waiting_for_peers') {
          deps.repository.updateSegmentAnalysisJob(job.jobKey, 'waiting_for_peers', outcome.detail);
        } else {
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
        }
        settledJobKeys.add(job.jobKey);
      }
      librarySummary = null;
    };

    try {
      if (primary.kind === 'cleanup') {
        const revisions = currentAnalysisRevisions();
        const removed = deps.repository.cleanupOrphanedAnalysisData(revisions.map((entry) => entry.fileRevision), 1000);
        deps.repository.updateSegmentAnalysisJob(
          primary.jobKey,
          removed >= 1000 ? 'pending' : 'complete',
          removed >= 1000 ? `Removed ${removed} stale entries; cleanup will continue` : `Cleanup complete; removed ${removed} stale entries`,
        );
        return;
      }
      const outcomes = await deps.detector.analyzeSeasonBatch(
        primary.mediaId,
        primary.season,
        [...new Set(group.map((job) => job.fileRevision))],
        () => analysisEnabled() && !paused && !manualPreemptionRequested
          && !group.some((job) => cancelledJobs.has(job.jobKey)) && !activity.isActive()
          && (primary.kind === 'manual' || runtime.idleSeconds() >= 300),
        (progress) => {
          currentPhaseProgress = progress;
          deps.repository.updateSegmentAnalysisJob(primary.jobKey, 'running', progress.detail);
          if (currentJob?.jobKey === primary.jobKey) currentJob = { ...primary, detail: progress.detail };
        },
        applyOutcome,
      );
      if (group.some((job) => cancelledJobs.has(job.jobKey))) throw new Error('Analysis was cancelled.');
      if (paused) throw new Error('Analysis was paused.');
      if (manualPreemptionRequested) throw new Error('Analysis was interrupted for a manual scan.');
      if (activity.isActive()) throw new Error('Playback became active; analysis was queued again.');
      if (primary.kind !== 'manual' && runtime.idleSeconds() < 300) {
        throw new Error('The desktop became active; analysis was queued again.');
      }
      for (const job of group) {
        if (settledJobKeys.has(job.jobKey)) continue;
        const outcome = outcomes.get(job.fileRevision);
        if (!outcome) {
          applyOutcome(job.fileRevision, { kind: 'error', detail: 'That media revision is no longer available.' });
          continue;
        }
        applyOutcome(job.fileRevision, outcome);
      }
      console.info('[skip-segments] job group complete', {
        kind: primary.kind, mediaId: primary.mediaId, season: primary.season,
        jobs: group.length, durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Background analysis failed.';
      const pausedByUser = paused;
      const preemptedForManual = manualPreemptionRequested;
      const disabledDuringRun = !analysisEnabled();
      const interrupted = message.toLowerCase().includes('interrupted');
      const pausedForPlayback = activity.isActive() || (interrupted && !preemptedForManual);
      const pausedForForeground = primary.kind !== 'manual' && runtime.idleSeconds() < 300;
      for (const job of group) {
        if (settledJobKeys.has(job.jobKey)) continue;
        if (cancelledJobs.has(job.jobKey)) deps.repository.updateSegmentAnalysisJob(job.jobKey, 'cancelled', 'Cancelled by user');
        else if (preemptedForManual) deps.repository.updateSegmentAnalysisJob(job.jobKey, 'pending', 'Preempted by manual scan');
        else if (disabledDuringRun) deps.repository.updateSegmentAnalysisJob(job.jobKey, 'pending', 'Automatic analysis disabled');
        else if (pausedByUser) deps.repository.updateSegmentAnalysisJob(job.jobKey, 'pending', 'Paused by user');
        else if (pausedForPlayback) deps.repository.updateSegmentAnalysisJob(job.jobKey, 'pending', 'Paused for playback');
        else if (pausedForForeground) deps.repository.updateSegmentAnalysisJob(job.jobKey, 'pending', 'Paused while LoomTV is in use');
        else deps.repository.updateSegmentAnalysisJob(job.jobKey, 'error', message);
      }
      if (pausedByUser || pausedForPlayback || pausedForForeground || preemptedForManual || disabledDuringRun) {
        console.info('[skip-segments] job group paused', {
          mediaId: primary.mediaId, season: primary.season, jobs: group.length,
          reason: preemptedForManual ? 'manual-preemption' : disabledDuringRun ? 'disabled' : pausedByUser ? 'user' : pausedForForeground ? 'foreground' : 'playback',
          durationMs: Date.now() - startedAt,
        });
      } else console.warn(`[skip-segments] ${message}`);
    } finally {
      for (const job of group) cancelledJobs.delete(job.jobKey);
      if (manualPreemptionRequested) manualPreemptionRequested = false;
      currentJob = null;
      currentGroup = [];
      currentPhaseProgress = null;
    }
  }

  // Drain every eligible job now instead of one job per scheduler tick; the
  // 60-second timer is only a heartbeat that retries once gating conditions
  // (idle, AC, playback quiet) come back.
  function drain(): Promise<void> {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      enqueueRecomputeIfNeeded();
      while (!paused) {
        const enabled = analysisEnabled();
        const pending = deps.repository.getSegmentAnalysisJobs(['pending'], 1000).sort(compareSegmentAnalysisJobs);
        const next = pending.find((job) => jobEligible(job) && (enabled || job.kind === 'cleanup'));
        if (!next) return;
        // Same-season pending jobs are one season analysis; run them together.
        const group = next.kind === 'cleanup' ? [next] : pending.filter((job) =>
          job.kind !== 'cleanup' && job.mediaId === next.mediaId
          && job.season === next.season && job.configHash === next.configHash);
        await runJobGroup(group);
        // Cached/no-op groups can otherwise chain exclusively through promise
        // microtasks and starve playback, HTTP, and cancellation events.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })().finally(() => { drainPromise = null; });
    return drainPromise;
  }

  async function tick(): Promise<void> {
    await drain();
  }

  function enqueueScope(input?: { mediaId?: string; season?: number; episode?: number; mode?: 'quick' | 'full' }): number {
    const settings = deps.loadSettings();
    if (settings.localSkipAnalysisEnabled === false || settings.skipAnalysis?.enabled === false) return 0;
    // Reconcile background work first. Manual enqueueing intentionally
    // supersedes matching pending jobs; doing this in the opposite order lets
    // the first drain recreate an incremental duplicate of every manual job.
    enqueueRecomputeIfNeeded();
    const currentHash = configHash();
    const parkedRevisions = input?.mode === 'quick'
      ? new Set(deps.repository.getSegmentAnalysisJobs(['waiting_for_peers'], 1000)
        .filter((job) => job.configHash === currentHash)
        .map((job) => job.fileRevision))
      : null;
    const revisions = currentAnalysisRevisions().filter((revision) =>
      (!input?.mediaId || revision.mediaId === input.mediaId)
      && (input?.season === undefined || revision.season === input.season)
      && (input?.episode === undefined || revision.episode === input.episode));
    let queued = 0;
    for (let offset = 0; offset < revisions.length; offset += 400) {
      const batch = revisions.slice(offset, offset + 400);
      // A quick scan skips content whose markers are already current; a full
      // scan re-analyzes everything the scope covers.
      const inventory = input?.mode === 'quick'
        ? new Map(deps.repository.getSegmentAnalysisInventory(batch.map((entry) => entry.fileRevision))
          .map((entry) => [entry.fileRevision, entry]))
        : null;
      for (const revision of batch) {
        if (inventory) {
          const stored = inventory.get(revision.fileRevision);
          if (stored && stored.fingerprintVersion === FINGERPRINT_ALGORITHM_VERSION && stored.configHash === currentHash) continue;
          // A short season has already been inspected as far as possible. It
          // stays parked until another episode arrives; repeatedly re-running
          // it makes Quick scan appear stuck without producing new evidence.
          if (parkedRevisions?.has(revision.fileRevision)) continue;
        }
        enqueue(revision, 'manual', inventory ? 'Quick scan: content not yet analyzed' : 'Manual analysis request');
        queued += 1;
      }
    }
    // Manual work starts now — never behind the 60-second heartbeat.
    if (queued) {
      if (currentGroup.length && !currentGroup.some((job) => job.kind === 'manual')) {
        manualPreemptionRequested = true;
        activity.interrupt();
      }
      void drain();
    }
    return queued;
  }

  function cancel(jobKey?: string, kind?: SegmentAnalysisJob['kind'], preserveWaiting = false): number {
    const matches = (job: SegmentAnalysisJob) => (!jobKey || job.jobKey === jobKey) && (!kind || job.kind === kind);
    const runningMatch = currentGroup.some(matches);
    for (const job of currentGroup) {
      if (matches(job)) cancelledJobs.add(job.jobKey);
    }
    const cancelled = deps.repository.cancelSegmentAnalysisJobs(jobKey, kind, preserveWaiting);
    if ((!jobKey && !kind) || runningMatch) activity.interrupt();
    return cancelled;
  }

  function status(): SegmentAnalysisStatus {
    const detector = deps.detector.status();
    const jobs = deps.repository.getSegmentAnalysisJobs(undefined, 250);
    const counts = deps.repository.getSegmentAnalysisJobCounts();
    const manualCounts = deps.repository.getSegmentAnalysisJobCounts('manual');
    const lastError = jobs.find((job) => job.state === 'error');
    const lastCompleted = jobs.find((job) => job.state === 'complete');
    let library: { analyzed: number; waiting: number; total: number } | undefined;
    try {
      const coverage = libraryCoverage();
      library = { analyzed: coverage.analyzed, waiting: coverage.waiting, total: coverage.total };
    } catch {
      // Coverage is informational; status must not fail when settings are mid-migration.
    }
    return {
      library,
      ...detector,
      paused,
      state: !analysisEnabled() ? 'disabled' : paused ? 'paused' : currentJob ? 'running' : (counts.pending || 0) > 0 ? 'queued' : detector.state,
      pendingCount: counts.pending || 0,
      runningCount: counts.running || 0,
      waitingCount: counts.waiting_for_peers || 0,
      manualPendingCount: manualCounts.pending || 0,
      manualRunningCount: manualCounts.running || 0,
      currentJob: currentJob ? {
        jobKey: currentJob.jobKey, kind: currentJob.kind, mediaId: currentJob.mediaId,
        season: currentJob.season, episode: currentJob.episode, detail: currentJob.detail,
      } : undefined,
      phaseProgress: currentPhaseProgress || undefined,
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
    cachedAnalysisRevisions = null;
    librarySummary = null;
    reconciledConfigHash = null;
    if (!analysisEnabled() && currentGroup.length) activity.interrupt();
    enqueueRecomputeIfNeeded();
    void drain();
  }

  function start(): void {
    if (timer || !runtime.isReady()) return;
    onAcPower = !runtime.isOnBatteryPower();
    deps.repository.recoverRunningSegmentAnalysisJobs();
    enqueueRecomputeIfNeeded();
    cleanup();
    runtime.onAc(() => { onAcPower = true; void drain(); });
    runtime.onBattery(() => { onAcPower = false; });
    timer = setInterval(() => { void tick(); }, 60_000);
    timer.unref?.();
  }

  return {
    cancel,
    cancelManual: () => cancel(undefined, 'manual', true),
    cleanup,
    enqueueScope,
    onLibrarySaved,
    pause: () => { paused = true; activity.interrupt(); },
    resume: () => { paused = false; void drain(); },
    rebuild,
    settingsChanged,
    start,
    stop: () => { if (timer) clearInterval(timer); timer = null; },
    status,
    tick,
  };
}
