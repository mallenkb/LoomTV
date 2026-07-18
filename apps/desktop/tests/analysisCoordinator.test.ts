import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppSettings, LibraryData } from '../src/main/appContracts.ts';
import { createAnalysisCoordinator } from '../src/main/skipSegments/analysisCoordinator.ts';
import type { SegmentAnalysisJob, SegmentAnalysisJobState } from '../src/main/skipSegments/analysisJobs.ts';
import type { SegmentAnalysisInventory } from '../src/main/databaseSegmentsRepository.ts';
import type { LocalAnalysisOutcome, SegmentAnalysisPhaseProgress } from '../src/main/skipSegments/types.ts';

const settings = (): AppSettings => ({
  localSkipAnalysisEnabled: true,
  skipAnalysis: {
    enabled: true,
    analyzeNewMedia: true,
    enabledTypes: { intro: true, recap: true, outro: true, credits: true, preview: true },
    promptTypes: { intro: true, recap: true, outro: true, credits: true, preview: true },
    durationLimits: {
      intro: { minSeconds: 15, maxSeconds: 180 }, recap: { minSeconds: 15, maxSeconds: 120 },
      outro: { minSeconds: 15, maxSeconds: 300 }, credits: { minSeconds: 15, maxSeconds: 300 }, preview: { minSeconds: 15, maxSeconds: 120 },
      movieCredits: { minSeconds: 15, maxSeconds: 900 },
    },
    suppressFirstEpisodeIntro: false,
    analyzeSpecials: false,
    exclusions: { seriesIds: [], movieIds: [], seasons: [], paths: [] },
    seasonOverrides: {},
  },
} as AppSettings);

function libraryWithEpisodes(directory: string, count: number): LibraryData {
  const episodeFiles = Array.from({ length: count }, (_, index) => {
    const filePath = path.join(directory, `episode-${index + 1}.mkv`);
    fs.writeFileSync(filePath, `episode-${index + 1}`);
    return { season: 1, episode: index + 1, filePath, localMetadata: { durationSeconds: 1_400, tracks: [] } };
  });
  return {
    movies: [], animeShows: [], libraryFolders: [],
    tvShows: [{ id: 'show', type: 'tv', title: 'Show', episodeFiles }],
  } as unknown as LibraryData;
}

type AnalyzeBatch = (
  mediaId: string,
  season: number,
  fileRevisions: string[],
  shouldContinue?: () => boolean,
  onProgress?: (progress: SegmentAnalysisPhaseProgress) => void,
  onOutcome?: (fileRevision: string, outcome: LocalAnalysisOutcome) => void,
) => Promise<Map<string, LocalAnalysisOutcome>>;

function harness(library: LibraryData, options?: {
  idleSeconds?: number;
  settingsValue?: AppSettings;
  analyzeBatch?: AnalyzeBatch;
  onInterrupt?: () => void;
}) {
  const jobs = new Map<string, SegmentAnalysisJob>();
  const inventory = new Map<string, SegmentAnalysisInventory>();
  const batchCalls: Array<{ mediaId: string; season: number; fileRevisions: string[] }> = [];
  let recovered = 0;
  let reset = 0;
  const repository = {
    cancelSegmentAnalysisJobs: (jobKey?: string, kind?: SegmentAnalysisJob['kind'], preserveWaiting = false) => {
      let changed = 0;
      for (const job of jobs.values()) {
        const cancellable = preserveWaiting ? ['pending', 'running'] : ['pending', 'running', 'waiting_for_peers'];
        if ((!jobKey || job.jobKey === jobKey) && (!kind || job.kind === kind) && cancellable.includes(job.state)) {
          job.state = 'cancelled'; changed += 1;
        }
      }
      return changed;
    },
    cleanupOrphanedAnalysisData: () => 0,
    enqueueSegmentAnalysisJob: (job: SegmentAnalysisJob) => {
      if (job.kind === 'manual') {
        for (const existing of jobs.values()) {
          if (existing.fileRevision === job.fileRevision && existing.jobKey !== job.jobKey
            && ['pending', 'waiting_for_peers'].includes(existing.state)) {
            existing.state = 'cancelled';
            existing.detail = 'Superseded by manual scan';
          }
        }
      }
      jobs.set(job.jobKey, { ...job });
    },
    fingerprintCacheBytes: () => 0,
    fingerprintCount: () => 0,
    getSegmentAnalysisInventory: (revisions?: string[]) => [...inventory.values()].filter((entry) => !revisions || revisions.includes(entry.fileRevision)),
    getSegmentAnalysisJobCounts: (kind?: SegmentAnalysisJob['kind']) => [...jobs.values()]
      .filter((job) => !kind || job.kind === kind)
      .reduce<Partial<Record<SegmentAnalysisJobState, number>>>((counts, job) => ({ ...counts, [job.state]: (counts[job.state] || 0) + 1 }), {}),
    getSegmentAnalysisJobs: (states?: SegmentAnalysisJobState[], limit = 500) => [...jobs.values()].filter((job) => !states || states.includes(job.state)).slice(0, limit),
    recoverRunningSegmentAnalysisJobs: () => { recovered += 1; return 0; },
    requeueWaitingSegmentAnalysisJobs: (mediaId: string, season: number) => {
      let changed = 0;
      for (const job of jobs.values()) if (job.mediaId === mediaId && job.season === season && job.state === 'waiting_for_peers') { job.state = 'pending'; changed += 1; }
      return changed;
    },
    resetAutomaticAnalysisData: () => { reset += 1; jobs.clear(); inventory.clear(); return 4; },
    saveSegmentAnalysisInventory: (value: SegmentAnalysisInventory) => { inventory.set(value.fileRevision, value); },
    updateSegmentAnalysisJob: (jobKey: string, state: SegmentAnalysisJobState, detail = '') => {
      const job = jobs.get(jobKey); if (job) jobs.set(jobKey, { ...job, state, detail, updatedAt: Date.now() });
    },
  };
  const coordinator = createAnalysisCoordinator({
    loadLibrary: () => library,
    loadSettings: () => options?.settingsValue || settings(),
    detector: {
      analyzeSeasonBatch: async (mediaId, season, fileRevisions, shouldContinue, onProgress, onOutcome) => {
        batchCalls.push({ mediaId, season, fileRevisions });
        if (options?.analyzeBatch) return options.analyzeBatch(mediaId, season, fileRevisions, shouldContinue, onProgress, onOutcome);
        const outcomes = new Map<string, LocalAnalysisOutcome>(fileRevisions.map((revision) => [revision, { kind: 'complete', response: { segments: [], revision: 'empty' } }]));
        for (const [revision, outcome] of outcomes) onOutcome?.(revision, outcome);
        return outcomes;
      },
      status: () => ({ enabled: true, available: true, helperPath: '/fpcalc', state: 'idle' }),
    },
    repository,
    runtime: { isReady: () => true, isOnBatteryPower: () => false, idleSeconds: () => options?.idleSeconds ?? 600, onAc: () => undefined, onBattery: () => undefined },
    activity: { interrupt: () => options?.onInterrupt?.(), isActive: () => false, millisecondsSince: () => 120_000 },
  });
  return { coordinator, jobs, inventory, batchCalls, repository, recovered: () => recovered, reset: () => reset };
}

test('library scan diff queues only new revisions and requeues every waiting job after the third peer', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const library = libraryWithEpisodes(directory, 3);
    const testHarness = harness(library, { idleSeconds: 0 });
    testHarness.jobs.set('waiting', { jobKey: 'waiting', kind: 'incremental', mediaId: 'show', season: 1, episode: 1, fileRevision: 'old', configHash: 'config', state: 'waiting_for_peers', detail: '', createdAt: 1, updatedAt: 1 });
    testHarness.coordinator.onLibrarySaved({ movies: [], tvShows: [], animeShows: [], libraryFolders: [] } as unknown as LibraryData, library);
    assert.equal([...testHarness.jobs.values()].filter((job) => job.kind === 'incremental').length, 4);
    assert.equal(testHarness.jobs.get('waiting')?.state, 'pending');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('startup recovery, settings reconciliation, bulk cancellation, and rebuild are dependency-injected', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 2), { idleSeconds: 0 });
    testHarness.coordinator.start();
    assert.equal(testHarness.recovered(), 1);
    testHarness.coordinator.stop();
    testHarness.coordinator.settingsChanged();
    assert.equal([...testHarness.jobs.values()].some((job) => job.kind === 'incremental'), true);
    assert.equal(testHarness.coordinator.cancel(), 3);
    assert.deepEqual(testHarness.coordinator.rebuild(), { removed: 4, queued: 2 });
    await testHarness.coordinator.tick();
    assert.equal(testHarness.reset(), 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('manual scope queues only the selected season and episode', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 4));
    assert.equal(testHarness.coordinator.enqueueScope({ mediaId: 'show', season: 1, episode: 3 }), 1);
    const queued = [...testHarness.jobs.values()].find((job) => job.kind === 'manual');
    assert.equal(queued?.episode, 3);
    await testHarness.coordinator.tick();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a season scan drains as one batched detector call that completes every job', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 4));
    assert.equal(testHarness.coordinator.enqueueScope({ mediaId: 'show', season: 1 }), 4);
    await testHarness.coordinator.tick();
    assert.equal(testHarness.batchCalls.length, 1);
    assert.equal(testHarness.batchCalls[0].fileRevisions.length, 4);
    assert.equal([...testHarness.jobs.values()].filter((job) => job.kind === 'manual' && job.state === 'complete').length, 4);
    assert.equal(testHarness.inventory.size, 4);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('manual jobs bypass the idle gate while background jobs stay queued', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 3), { idleSeconds: 0 });
    testHarness.coordinator.settingsChanged();
    await testHarness.coordinator.tick();
    assert.equal(testHarness.batchCalls.length, 0);
    assert.equal([...testHarness.jobs.values()].every((job) => job.state === 'pending'), true);
    assert.equal(testHarness.coordinator.status().manualPendingCount, 0);
    assert.equal(testHarness.coordinator.enqueueScope({ mediaId: 'show', season: 1, episode: 2 }), 1);
    await testHarness.coordinator.tick();
    // The manual job runs immediately, and same-season background jobs ride
    // along in its batch since the season analysis is the same work.
    assert.equal(testHarness.batchCalls.length, 1);
    assert.equal([...testHarness.jobs.values()].some((job) => job.kind === 'manual' && job.state === 'complete'), true);
    assert.equal([...testHarness.jobs.values()].some((job) => job.state === 'pending' || job.state === 'running'), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('one drain processes multiple eligible season groups without a heartbeat gap', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const firstDirectory = path.join(directory, 'first');
    const secondDirectory = path.join(directory, 'second');
    fs.mkdirSync(firstDirectory);
    fs.mkdirSync(secondDirectory);
    const first = libraryWithEpisodes(firstDirectory, 3).tvShows[0];
    const second = { ...libraryWithEpisodes(secondDirectory, 3).tvShows[0], id: 'show-2', title: 'Show 2' };
    const library = { movies: [], animeShows: [], libraryFolders: [], tvShows: [first, second] } as unknown as LibraryData;
    const testHarness = harness(library);
    assert.equal(testHarness.coordinator.enqueueScope({ mode: 'full' }), 6);
    await testHarness.coordinator.tick();
    assert.deepEqual(testHarness.batchCalls.map((call) => call.mediaId).sort(), ['show', 'show-2']);
    assert.equal([...testHarness.jobs.values()].filter((job) => job.state === 'complete').length, 6);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('waiting-for-peers work is parked and does not keep the scanner active', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 2), {
      analyzeBatch: async (_mediaId, _season, revisions, _shouldContinue, _onProgress, onOutcome) => {
        const outcomes = new Map<string, LocalAnalysisOutcome>();
        for (const revision of revisions) {
          const outcome: LocalAnalysisOutcome = {
            kind: 'waiting_for_peers', response: { segments: [], revision: 'empty' }, detail: 'Waiting for peers',
          };
          outcomes.set(revision, outcome);
          onOutcome?.(revision, outcome);
        }
        return outcomes;
      },
    });
    testHarness.coordinator.enqueueScope({ mode: 'full' });
    await testHarness.coordinator.tick();
    const status = testHarness.coordinator.status();
    assert.equal(status.pendingCount, 0);
    assert.equal(status.runningCount, 0);
    assert.equal(status.waitingCount, 2);
    assert.deepEqual(status.library, { analyzed: 0, waiting: 2, total: 2 });
    assert.equal(status.state, 'idle');
    assert.equal(testHarness.coordinator.enqueueScope({ mode: 'quick' }), 0);
    await testHarness.coordinator.tick();
    assert.equal(testHarness.batchCalls.length, 1);
    assert.equal([...testHarness.jobs.values()].filter((job) => job.state === 'waiting_for_peers').length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('manual work preempts an active background group and resumes through the same drain', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  let releaseFirst: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let call = 0;
  let interrupts = 0;
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 3), {
      analyzeBatch: async (_mediaId, _season, revisions, shouldContinue, _onProgress, onOutcome) => {
        call += 1;
        if (call === 1) {
          signalStarted?.();
          await firstReleased;
          if (!shouldContinue?.()) throw new Error('Analysis was interrupted and queued again.');
        }
        const outcomes = new Map<string, LocalAnalysisOutcome>();
        for (const revision of revisions) {
          const outcome: LocalAnalysisOutcome = { kind: 'complete', response: { segments: [], revision: 'empty' } };
          outcomes.set(revision, outcome);
          onOutcome?.(revision, outcome);
        }
        return outcomes;
      },
      onInterrupt: () => { interrupts += 1; releaseFirst?.(); },
    });
    testHarness.coordinator.settingsChanged();
    await firstStarted;
    assert.equal(testHarness.coordinator.enqueueScope({ mediaId: 'show', season: 1, episode: 2 }), 1);
    await testHarness.coordinator.tick();
    assert.equal(interrupts, 1);
    assert.equal(call, 2);
    assert.equal([...testHarness.jobs.values()].some((job) => job.state === 'pending' || job.state === 'running'), false);
    assert.equal([...testHarness.jobs.values()].some((job) => job.kind === 'manual' && job.state === 'complete'), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('completed episode outcomes are checkpointed when a running group is paused', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  let release: (() => void) | undefined;
  let signalCheckpoint: (() => void) | undefined;
  const checkpointed = new Promise<void>((resolve) => { signalCheckpoint = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 3), {
      analyzeBatch: async (_mediaId, _season, revisions, shouldContinue, onProgress, onOutcome) => {
        onProgress?.({ phase: 'matching', completed: 1, total: revisions.length, detail: 'Matched first episode' });
        onOutcome?.(revisions[0], { kind: 'complete', response: { segments: [], revision: 'empty' } });
        signalCheckpoint?.();
        await released;
        if (!shouldContinue?.()) throw new Error('Analysis was interrupted and queued again.');
        return new Map();
      },
      onInterrupt: () => release?.(),
    });
    assert.equal(testHarness.coordinator.enqueueScope({ mode: 'full' }), 3);
    await checkpointed;
    const runningStatus = testHarness.coordinator.status();
    assert.equal(runningStatus.runningCount, 2);
    assert.equal(runningStatus.manualRunningCount, 2);
    assert.equal(runningStatus.phaseProgress?.phase, 'matching');

    testHarness.coordinator.pause();
    await testHarness.coordinator.tick();
    const manualJobs = [...testHarness.jobs.values()].filter((job) => job.kind === 'manual');
    assert.equal(manualJobs.filter((job) => job.state === 'complete').length, 1);
    assert.equal(manualJobs.filter((job) => job.state === 'pending').length, 2);
    assert.equal(testHarness.inventory.size, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('stopping a manual scan preserves jobs parked for future peer episodes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 2), { idleSeconds: 0 });
    const base = {
      kind: 'manual' as const, mediaId: 'show', season: 1, configHash: 'config',
      detail: 'Manual analysis request', createdAt: 1, updatedAt: 1,
    };
    testHarness.jobs.set('pending-manual', {
      ...base, jobKey: 'pending-manual', episode: 1, fileRevision: 'one', state: 'pending',
    });
    testHarness.jobs.set('waiting-manual', {
      ...base, jobKey: 'waiting-manual', episode: 2, fileRevision: 'two', state: 'waiting_for_peers',
    });
    assert.equal(testHarness.coordinator.cancelManual(), 1);
    assert.equal(testHarness.jobs.get('pending-manual')?.state, 'cancelled');
    assert.equal(testHarness.jobs.get('waiting-manual')?.state, 'waiting_for_peers');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('disabling analysis interrupts an active group and reports disabled instead of queued', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  const configured = settings();
  let signalStarted: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 3), {
      settingsValue: configured,
      analyzeBatch: async (_mediaId, _season, _revisions, shouldContinue) => {
        signalStarted?.();
        await released;
        if (!shouldContinue?.()) throw new Error('Analysis was interrupted and queued again.');
        return new Map();
      },
      onInterrupt: () => release?.(),
    });
    testHarness.coordinator.enqueueScope({ mode: 'full' });
    await started;
    configured.localSkipAnalysisEnabled = false;
    if (configured.skipAnalysis) configured.skipAnalysis.enabled = false;
    testHarness.coordinator.settingsChanged();
    await testHarness.coordinator.tick();
    assert.equal(testHarness.coordinator.status().state, 'disabled');
    assert.equal([...testHarness.jobs.values()].filter((job) => job.kind === 'manual' && job.state === 'pending').length, 3);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('manual scans are rejected while automatic analysis is disabled', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const disabled = settings();
    disabled.localSkipAnalysisEnabled = false;
    if (disabled.skipAnalysis) disabled.skipAnalysis.enabled = false;
    const testHarness = harness(libraryWithEpisodes(directory, 2), { settingsValue: disabled });
    assert.equal(testHarness.coordinator.enqueueScope({ mode: 'full' }), 0);
    assert.equal(testHarness.jobs.size, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
