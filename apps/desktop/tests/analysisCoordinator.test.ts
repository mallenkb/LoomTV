import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppSettings, LibraryData } from '../src/main/appContracts.ts';
import { createAnalysisCoordinator } from '../src/main/skipSegments/analysisCoordinator.ts';
import type { SegmentAnalysisJob, SegmentAnalysisJobState } from '../src/main/skipSegments/analysisJobs.ts';
import type { SegmentAnalysisInventory } from '../src/main/databaseSegmentsRepository.ts';

const settings = (): AppSettings => ({
  localSkipAnalysisEnabled: true,
  skipAnalysis: {
    enabled: true,
    analyzeNewMedia: true,
    enabledTypes: { intro: true, recap: true, credits: true, preview: true },
    promptTypes: { intro: true, recap: true, credits: true, preview: false },
    durationLimits: {
      intro: { minSeconds: 15, maxSeconds: 180 }, recap: { minSeconds: 15, maxSeconds: 120 },
      credits: { minSeconds: 15, maxSeconds: 300 }, preview: { minSeconds: 15, maxSeconds: 120 },
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

function harness(library: LibraryData) {
  const jobs = new Map<string, SegmentAnalysisJob>();
  const inventory = new Map<string, SegmentAnalysisInventory>();
  let recovered = 0;
  let reset = 0;
  const repository = {
    cancelSegmentAnalysisJobs: (jobKey?: string) => {
      let changed = 0;
      for (const job of jobs.values()) {
        if ((!jobKey || job.jobKey === jobKey) && ['pending', 'running', 'waiting_for_peers'].includes(job.state)) {
          job.state = 'cancelled'; changed += 1;
        }
      }
      return changed;
    },
    cleanupOrphanedAnalysisData: () => 0,
    enqueueSegmentAnalysisJob: (job: SegmentAnalysisJob) => { jobs.set(job.jobKey, { ...job }); },
    fingerprintCacheBytes: () => 0,
    fingerprintCount: () => 0,
    getSegmentAnalysisInventory: (revisions?: string[]) => [...inventory.values()].filter((entry) => !revisions || revisions.includes(entry.fileRevision)),
    getSegmentAnalysisJobCounts: () => [...jobs.values()].reduce<Partial<Record<SegmentAnalysisJobState, number>>>((counts, job) => ({ ...counts, [job.state]: (counts[job.state] || 0) + 1 }), {}),
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
    loadSettings: settings,
    detector: { analyzeRevision: async () => ({ kind: 'complete', response: { segments: [], revision: 'empty' } }), status: () => ({ enabled: true, available: true, helperPath: '/fpcalc', state: 'idle' }) },
    repository,
    runtime: { isReady: () => true, isOnBatteryPower: () => false, idleSeconds: () => 600, onAc: () => undefined, onBattery: () => undefined },
    activity: { interrupt: () => undefined, isActive: () => false, millisecondsSince: () => 120_000 },
  });
  return { coordinator, jobs, repository, recovered: () => recovered, reset: () => reset };
}

test('library scan diff queues only new revisions and requeues every waiting job after the third peer', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const library = libraryWithEpisodes(directory, 3);
    const testHarness = harness(library);
    testHarness.jobs.set('waiting', { jobKey: 'waiting', kind: 'incremental', mediaId: 'show', season: 1, episode: 1, fileRevision: 'old', configHash: 'config', state: 'waiting_for_peers', detail: '', createdAt: 1, updatedAt: 1 });
    testHarness.coordinator.onLibrarySaved({ movies: [], tvShows: [], animeShows: [], libraryFolders: [] } as unknown as LibraryData, library);
    assert.equal([...testHarness.jobs.values()].filter((job) => job.kind === 'incremental').length, 4);
    assert.equal(testHarness.jobs.get('waiting')?.state, 'pending');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('startup recovery, settings reconciliation, bulk cancellation, and rebuild are dependency-injected', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 2));
    testHarness.coordinator.start();
    assert.equal(testHarness.recovered(), 1);
    testHarness.coordinator.stop();
    testHarness.coordinator.settingsChanged();
    assert.equal([...testHarness.jobs.values()].some((job) => job.kind === 'incremental'), true);
    assert.equal(testHarness.coordinator.cancel(), 3);
    assert.deepEqual(testHarness.coordinator.rebuild(), { removed: 4, queued: 2 });
    assert.equal(testHarness.reset(), 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('manual scope queues only the selected season and episode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analysis-'));
  try {
    const testHarness = harness(libraryWithEpisodes(directory, 4));
    assert.equal(testHarness.coordinator.enqueueScope({ mediaId: 'show', season: 1, episode: 3 }), 1);
    const queued = [...testHarness.jobs.values()].find((job) => job.kind === 'manual');
    assert.equal(queued?.episode, 3);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
