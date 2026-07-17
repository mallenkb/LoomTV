import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { safeFetch } from './safeFetch';
import type { LibraryData } from './appContracts.ts';
import {
  createDatabaseArtworkRepository,
  type CachedArtwork,
} from './databaseArtworkRepository.ts';
import {
  loadLibrary as loadLibraryRecord,
  saveLibrary as saveLibraryRecord,
} from './databaseLibraryRepository.ts';
import {
  getAllProgress as getAllProgressRecord,
  getPlaybackTrackPreferences as getPlaybackTrackPreferencesRecord,
  getProgress as getProgressRecord,
  importProgress as importProgressRecords,
  loadSettings as loadSettingsRecord,
  savePlaybackTrackPreferences as savePlaybackTrackPreferencesRecord,
  saveProgress as saveProgressRecord,
  saveSettings as saveSettingsRecord,
  type PlaybackTrackPreferences,
  type SettingsData,
  type StoredProgress,
} from './databasePlaybackRepository.ts';
import {
  createDatabaseSegmentsRepository,
  type SegmentAnalysisInventory,
  type StoredMediaFingerprint,
} from './databaseSegmentsRepository.ts';
import type { SegmentAnalysisJob, SegmentAnalysisJobState } from './skipSegments/analysisJobs.ts';
import type {
  MediaSegment,
  MediaSegmentCandidate,
  MediaSegmentSource,
  ProviderCacheEntry,
} from './skipSegments/types';
import { migrateDatabase } from './databaseMigrations';

export type { PlaybackTrackPreferences, StoredProgress } from './databasePlaybackRepository.ts';
export type { CachedArtwork } from './databaseArtworkRepository.ts';
export type { StoredMediaFingerprint } from './databaseSegmentsRepository.ts';

let db: BetterSqlite3.Database | null = null;
let artworkRepository: ReturnType<typeof createDatabaseArtworkRepository> | null = null;
let segmentRepository: ReturnType<typeof createDatabaseSegmentsRepository> | null = null;

function databasePath(): string {
  return path.join(app.getPath('userData'), 'loomtv.sqlite');
}

function artworkCacheDirectory(): string {
  return path.join(app.getPath('userData'), 'artwork-cache');
}

function getDb(): BetterSqlite3.Database {
  if (db) return db;

  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  db = new BetterSqlite3(databasePath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrateDatabase(db);
  return db;
}

function getSegmentRepository(): ReturnType<typeof createDatabaseSegmentsRepository> {
  segmentRepository ||= createDatabaseSegmentsRepository(getDb());
  return segmentRepository;
}

function getArtworkRepository(): ReturnType<typeof createDatabaseArtworkRepository> {
  artworkRepository ||= createDatabaseArtworkRepository(getDb(), {
    cacheDirectory: artworkCacheDirectory(),
    fetchArtworkBytes,
  });
  return artworkRepository;
}


export function loadLibraryFromDatabase(): LibraryData | null {
  return loadLibraryRecord(getDb(), getProgressMap(), getCustomArtworkMap());
}

export function saveLibraryToDatabase(data: LibraryData): void {
  saveLibraryRecord(getDb(), data);
}
export function loadSettingsFromDatabase(): SettingsData | null {
  return loadSettingsRecord(getDb());
}

export function saveSettingsToDatabase(settings: SettingsData): void {
  saveSettingsRecord(getDb(), settings);
}

export function getProgress(filePath: string): StoredProgress | null {
  return getProgressRecord(getDb(), filePath);
}

export function getAllProgress(): Record<string, StoredProgress> {
  return getAllProgressRecord(getDb());
}

export function getPlaybackTrackPreferences(scope?: string): PlaybackTrackPreferences | Record<string, PlaybackTrackPreferences> {
  return getPlaybackTrackPreferencesRecord(getDb(), scope);
}

export function savePlaybackTrackPreferences(scope: string, preferences: PlaybackTrackPreferences): PlaybackTrackPreferences {
  return savePlaybackTrackPreferencesRecord(getDb(), scope, preferences);
}
export function getSegmentSourceCache(
  provider: ProviderCacheEntry['provider'],
  lookupKey: string,
  durationBucket: number,
): ProviderCacheEntry | null {
  return getSegmentRepository().getSegmentSourceCache(provider, lookupKey, durationBucket);
}

export function saveSegmentSourceCache(entry: ProviderCacheEntry): void {
  getSegmentRepository().saveSegmentSourceCache(entry);
}

export function getSegmentCandidates(fileRevision: string): MediaSegmentCandidate[] {
  return getSegmentRepository().getSegmentCandidates(fileRevision);
}

export function getManualSegmentCandidates(mediaId: string, season: number, episode: number): MediaSegmentCandidate[] {
  return getSegmentRepository().getManualSegmentCandidates(mediaId, season, episode);
}

export function getManagedSegmentCandidates(mediaId?: string, season?: number, episode?: number): MediaSegmentCandidate[] {
  return getSegmentRepository().getManagedSegmentCandidates(mediaId, season, episode);
}

export function updateSegmentCandidate(
  candidateId: string,
  patch: { status?: MediaSegmentCandidate['status']; type?: MediaSegmentCandidate['type'] },
): boolean {
  return getSegmentRepository().updateSegmentCandidate(candidateId, patch);
}

export function eraseAutomaticSegmentCandidates(mediaId: string, season?: number, episode?: number): number {
  return getSegmentRepository().eraseAutomaticSegmentCandidates(mediaId, season, episode);
}

export function replaceSegmentCandidatesForSource(
  fileRevision: string,
  source: Exclude<MediaSegmentSource, 'manual'>,
  candidates: MediaSegmentCandidate[],
): MediaSegment[] {
  return getSegmentRepository().replaceSegmentCandidatesForSource(fileRevision, source, candidates);
}

export function saveManualSegmentCandidate(candidate: MediaSegmentCandidate, replaceCandidateId?: string): MediaSegment[] {
  return getSegmentRepository().saveManualSegmentCandidate(candidate, replaceCandidateId);
}

export function deleteManualSegmentCandidate(
  fileRevision: string,
  type: MediaSegmentCandidate['type'],
  candidateId?: string,
): MediaSegment[] {
  return getSegmentRepository().deleteManualSegmentCandidate(fileRevision, type, candidateId);
}

export function undoManualSegmentCandidate(
  fileRevision: string,
  type: MediaSegmentCandidate['type'],
  candidateId?: string,
): MediaSegment[] {
  return getSegmentRepository().undoManualSegmentCandidate(fileRevision, type, candidateId);
}

export function reassociateManualSegmentCandidate(
  candidateId: string,
  fileRevision: string,
  filePath: string,
): MediaSegment[] {
  return getSegmentRepository().reassociateManualSegmentCandidate(candidateId, fileRevision, filePath);
}

export function markManualSegmentCandidateForReview(candidateId: string): void {
  getSegmentRepository().markManualSegmentCandidateForReview(candidateId);
}

export function getResolvedMediaSegments(fileRevision: string): MediaSegment[] {
  return getSegmentRepository().getResolvedMediaSegments(fileRevision);
}

export function getMediaFingerprint(
  fileRevision: string,
  audioTrack: number,
  windowType: StoredMediaFingerprint['windowType'],
  algorithmVersion: string,
): StoredMediaFingerprint | null {
  return getSegmentRepository().getMediaFingerprint(fileRevision, audioTrack, windowType, algorithmVersion);
}

export function saveMediaFingerprint(value: StoredMediaFingerprint): void {
  getSegmentRepository().saveMediaFingerprint(value);
}

export function getAuxiliaryFingerprint(
  fileRevision: string,
  audioTrack: number,
  windowType: string,
  algorithmVersion: string,
): StoredMediaFingerprint | null {
  return getSegmentRepository().getAuxiliaryFingerprint(fileRevision, audioTrack, windowType, algorithmVersion);
}

export function saveAuxiliaryFingerprint(value: StoredMediaFingerprint): void {
  getSegmentRepository().saveAuxiliaryFingerprint(value);
}

export function enqueueSegmentAnalysisJob(job: SegmentAnalysisJob): void {
  getSegmentRepository().enqueueSegmentAnalysisJob(job);
}

export function getSegmentAnalysisJobs(states?: SegmentAnalysisJobState[], limit?: number): SegmentAnalysisJob[] {
  return getSegmentRepository().getSegmentAnalysisJobs(states, limit);
}

export function getSegmentAnalysisJobCounts(): Partial<Record<SegmentAnalysisJobState, number>> {
  return getSegmentRepository().getSegmentAnalysisJobCounts();
}

export function updateSegmentAnalysisJob(jobKey: string, state: SegmentAnalysisJobState, detail?: string): void {
  getSegmentRepository().updateSegmentAnalysisJob(jobKey, state, detail);
}

export function recoverRunningSegmentAnalysisJobs(): number {
  return getSegmentRepository().recoverRunningSegmentAnalysisJobs();
}

export function saveSegmentAnalysisInventory(value: SegmentAnalysisInventory): void {
  getSegmentRepository().saveSegmentAnalysisInventory(value);
}

export function getSegmentAnalysisInventory(fileRevisions?: string[]): SegmentAnalysisInventory[] {
  return getSegmentRepository().getSegmentAnalysisInventory(fileRevisions);
}

export function cleanupOrphanedAnalysisData(activeRevisions: string[], limit?: number): number {
  return getSegmentRepository().cleanupOrphanedAnalysisData(activeRevisions, limit);
}

export function fingerprintCount(): number {
  return getSegmentRepository().fingerprintCount();
}

export function fingerprintCacheBytes(): number {
  return getSegmentRepository().fingerprintCacheBytes();
}

export function cancelSegmentAnalysisJobs(jobKey?: string): number {
  return getSegmentRepository().cancelSegmentAnalysisJobs(jobKey);
}

export function requeueWaitingSegmentAnalysisJobs(mediaId: string, season: number): number {
  return getSegmentRepository().requeueWaitingSegmentAnalysisJobs(mediaId, season);
}

export function resetAutomaticAnalysisData(): number {
  return getSegmentRepository().resetAutomaticAnalysisData();
}

export function saveSegmentAnalysisState(
  jobKey: string,
  mediaId: string,
  season: number,
  state: string,
  detail = '',
): void {
  getSegmentRepository().saveSegmentAnalysisState(jobKey, mediaId, season, state, detail);
}

export function getSegmentAnalysisStates(mediaId?: string): Array<{
  jobKey: string; mediaId: string; season: number; state: string; detail: string; updatedAt: number;
}> {
  return getSegmentRepository().getSegmentAnalysisStates(mediaId);
}

export function cleanupOrphanedAutomaticSegments(limit = 250): number {
  return getSegmentRepository().cleanupOrphanedAutomaticSegments(limit);
}
export function saveProgress(filePath: string, position: number, duration: number): StoredProgress {
  return saveProgressRecord(getDb(), filePath, position, duration);
}

export function importProgress(progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>): void {
  importProgressRecords(getDb(), progress);
}
export function saveCustomArtwork(mediaId: string, target: string, dataUrl: string): void {
  getArtworkRepository().saveCustomArtwork(mediaId, target, dataUrl);
}

export function getCustomArtwork(mediaId: string): Record<string, string> {
  return getArtworkRepository().getCustomArtwork(mediaId);
}

export function getCustomArtworkData(mediaId: string, target: string): { dataUrl: string; updatedAt: number } | null {
  return getArtworkRepository().getCustomArtworkData(mediaId, target);
}

export function importCustomArtwork(entries: Record<string, Record<string, string>>): void {
  getArtworkRepository().importCustomArtwork(entries);
}
function getProgressMap(): Map<string, StoredProgress> {
  return new Map(Object.entries(getAllProgress()));
}

function getCustomArtworkMap(): Map<string, Map<string, string>> {
  return getArtworkRepository().getCustomArtworkMap();
}
export function getCachedArtwork(sourceUrl: string): CachedArtwork | null {
  return getArtworkRepository().getCachedArtwork(sourceUrl);
}
async function fetchArtworkBytes(sourceUrl: string): Promise<{ bytes: Buffer; mimeType: string; byteLength: number } | null> {
  try {
    const response = await safeFetch(sourceUrl, {}, {
      allowedHosts: [
        '.fanart.tv',
        '.media-amazon.com',
        '.myanimelist.net',
        '.themoviedb.org',
        '.tmdb.org',
        '.tvmaze.com',
      ],
      timeoutMs: 20_000,
      maxBytes: 5 * 1024 * 1024,
      retries: 2,
    });
    if (!response.ok) return null;
    const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    if (!mimeType.startsWith('image/')) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024) return null;
    return {
      bytes,
      mimeType,
      byteLength: bytes.byteLength,
    };
  } catch {
    return null;
  }
}

// The desktop is the LAN artwork source. When an older library entry has not
// been pre-cached yet, fetch and persist the image here instead of making a
// paired device follow a redirect to the metadata provider.
export async function cacheArtworkSource(sourceUrl: string): Promise<CachedArtwork | null> {
  return getArtworkRepository().cacheArtworkSource(sourceUrl);
}

export async function cacheLibraryArtwork(data: LibraryData): Promise<void> {
  await getArtworkRepository().cacheLibraryArtwork(data);
}
export async function backupDatabase(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const source = databasePath();
  const result = await dialog.showSaveDialog({
    title: 'Back Up Loom Media Server Database',
    defaultPath: `loomtv-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
    filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(source, result.filePath);
  return { ok: true, path: result.filePath };
}

export function clearDatabase(): void {
  const database = getDb();
  database.exec(`
    DELETE FROM segment_manual_history;
    DELETE FROM media_segments;
    DELETE FROM media_segment_candidates;
    DELETE FROM segment_source_cache;
    DELETE FROM media_fingerprints;
    DELETE FROM media_auxiliary_fingerprints;
    DELETE FROM segment_analysis_inventory;
    DELETE FROM segment_analysis_jobs;
    DELETE FROM segment_analysis_state;
    DELETE FROM artwork_cache;
    DELETE FROM custom_artwork;
    DELETE FROM playback_progress;
    DELETE FROM episode_files;
    DELETE FROM episodes;
    DELETE FROM seasons;
    DELETE FROM media_items;
    DELETE FROM library_folders;
    DELETE FROM scan_cache;
    DELETE FROM app_settings;
  `);
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.exec('VACUUM;');
}
