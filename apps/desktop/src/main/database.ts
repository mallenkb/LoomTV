import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { migrateDatabase, profilesMigrationPending } from './databaseMigrations';
import {
  clearDeviceProfileSelection as clearDeviceProfileSelectionRecord,
  createProfile as createProfileRecord,
  createGuestProfile as createGuestProfileRecord,
  deleteProfile as deleteProfileRecord,
  getDeviceProfileSelection as getDeviceProfileSelectionRecord,
  getDeviceProfileSelectionState as getDeviceProfileSelectionStateRecord,
  getOwnerProfile as getOwnerProfileRecord,
  getProfile as getProfileRecord,
  getProfileLists as getProfileListsRecord,
  getProfilePinCredentials as getProfilePinCredentialsRecord,
  getProfilePreferences as getProfilePreferencesRecord,
  getProfileRestrictions as getProfileRestrictionsRecord,
  listProfiles as listProfileRecords,
  profilePersonalDataCount as profilePersonalDataCountRecord,
  reorderProfiles as reorderProfileRecords,
  resetOwnerProfile as resetOwnerProfileRecord,
  saveProfilePreferences as saveProfilePreferencesRecord,
  saveProfileRestrictions as saveProfileRestrictionsRecord,
  selectDeviceProfile as selectDeviceProfileRecord,
  setDeviceAutomaticSignIn as setDeviceAutomaticSignInRecord,
  setProfileListEntry as setProfileListEntryRecord,
  setProfilePinCredentials as setProfilePinCredentialsRecord,
  type DeviceProfileSelection,
  type ProfileCreateInput,
  type ProfileListEntry,
  type ProfileListKind,
  type ProfilePreferences,
  type ProfileRecord,
  type ProfileRestrictions,
  type ProfileUpdateInput,
  updateProfile as updateProfileRecord,
} from './databaseProfilesRepository.ts';

export type { PlaybackTrackPreferences, StoredProgress } from './databasePlaybackRepository.ts';
export type {
  DeviceProfileSelection,
  ProfileCreateInput,
  ProfileListEntry,
  ProfileListKind,
  ProfilePreferences,
  ProfileRecord,
  ProfileRestrictions,
  ProfileType,
  ProfileUpdateInput,
} from './databaseProfilesRepository.ts';
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
  backupBeforeProfilesMigration(db);
  migrateDatabase(db);
  return db;
}

// A plain file copy of an open WAL database misses recent writes, so the
// pre-migration backup uses VACUUM INTO and is verified before migrating.
function backupBeforeProfilesMigration(database: BetterSqlite3.Database): void {
  try {
    if (!profilesMigrationPending(database)) return;
    const hasProgress = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'playback_progress'")
      .get()
      ? (database.prepare('SELECT COUNT(*) AS n FROM playback_progress').get() as { n: number }).n > 0
      : false;
    if (!hasProgress) return;
    const backupPath = path.join(app.getPath('userData'), 'loomtv-pre-profiles-backup.sqlite');
    if (!fs.existsSync(backupPath)) {
      database.prepare('VACUUM INTO ?').run(backupPath);
    }
    const backup = new BetterSqlite3(backupPath, { readonly: true });
    try {
      const check = backup.pragma('quick_check') as Array<{ quick_check: string }>;
      if (check[0]?.quick_check !== 'ok') throw new Error('Backup integrity check failed.');
    } finally {
      backup.close();
    }
  } catch (error) {
    throw new Error(
      `LoomTV could not create a pre-migration database backup: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
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
  // The library payload is profile-neutral: viewer recency is derived from the
  // selected profile's progress by each client, never baked into the catalog.
  return loadLibraryRecord(getDb(), new Map(), getCustomArtworkMap());
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

export function getProgress(profileId: string, filePath: string): StoredProgress | null {
  return getProgressRecord(getDb(), profileId, filePath);
}

export function getAllProgress(profileId: string): Record<string, StoredProgress> {
  return getAllProgressRecord(getDb(), profileId);
}

export function getPlaybackTrackPreferences(profileId: string, scope?: string): PlaybackTrackPreferences | Record<string, PlaybackTrackPreferences> {
  return getPlaybackTrackPreferencesRecord(getDb(), profileId, scope);
}

export function savePlaybackTrackPreferences(profileId: string, scope: string, preferences: PlaybackTrackPreferences): PlaybackTrackPreferences {
  return savePlaybackTrackPreferencesRecord(getDb(), profileId, scope, preferences);
}

export function listProfiles(guestDeviceId?: string): ProfileRecord[] {
  return listProfileRecords(getDb(), guestDeviceId);
}

export function getProfile(profileId: string): ProfileRecord | null {
  return getProfileRecord(getDb(), profileId);
}

export function getOwnerProfile(): ProfileRecord | null {
  return getOwnerProfileRecord(getDb());
}

export function createProfile(input: ProfileCreateInput): ProfileRecord {
  return createProfileRecord(getDb(), input);
}

export function updateProfile(profileId: string, patch: ProfileUpdateInput): ProfileRecord {
  return updateProfileRecord(getDb(), profileId, patch);
}

export function deleteProfile(profileId: string): void {
  deleteProfileRecord(getDb(), profileId);
}

export function getDeviceProfileSelection(deviceId: string): string | null {
  return getDeviceProfileSelectionRecord(getDb(), deviceId);
}

export function selectDeviceProfile(deviceId: string, profileId: string): ProfileRecord {
  return selectDeviceProfileRecord(getDb(), deviceId, profileId);
}

export function getDeviceProfileSelectionState(deviceId: string): DeviceProfileSelection | null {
  return getDeviceProfileSelectionStateRecord(getDb(), deviceId);
}

export function clearDeviceProfileSelection(deviceId: string): void {
  clearDeviceProfileSelectionRecord(getDb(), deviceId);
}

export function setDeviceAutomaticSignIn(deviceId: string, enabled: boolean): DeviceProfileSelection {
  return setDeviceAutomaticSignInRecord(getDb(), deviceId, enabled);
}

export function createGuestProfile(deviceId: string): ProfileRecord {
  return createGuestProfileRecord(getDb(), deviceId);
}

export function reorderProfiles(profileIds: readonly string[]): ProfileRecord[] {
  return reorderProfileRecords(getDb(), profileIds);
}

export function getProfilePinCredentials(profileId: string): { hash: string; salt: string } | null {
  return getProfilePinCredentialsRecord(getDb(), profileId);
}

export function setProfilePinCredentials(profileId: string, credentials: { hash: string; salt: string } | null): ProfileRecord {
  return setProfilePinCredentialsRecord(getDb(), profileId, credentials);
}

export function getProfilePreferences(profileId: string): ProfilePreferences {
  return getProfilePreferencesRecord(getDb(), profileId);
}

export function saveProfilePreferences(profileId: string, patch: ProfilePreferences): ProfilePreferences {
  return saveProfilePreferencesRecord(getDb(), profileId, patch);
}

export function getProfileRestrictions(profileId: string): ProfileRestrictions {
  return getProfileRestrictionsRecord(getDb(), profileId);
}

export function saveProfileRestrictions(profileId: string, input: Omit<ProfileRestrictions, 'revision'>): ProfileRestrictions {
  return saveProfileRestrictionsRecord(getDb(), profileId, input);
}

export function getProfileLists(profileId: string, kind?: ProfileListKind): ProfileListEntry[] {
  return getProfileListsRecord(getDb(), profileId, kind);
}

export function setProfileListEntry(profileId: string, mediaId: string, kind: ProfileListKind, present: boolean): ProfileListEntry[] {
  return setProfileListEntryRecord(getDb(), profileId, mediaId, kind, present);
}

export function profilePersonalDataCount(profileId: string): number {
  return profilePersonalDataCountRecord(getDb(), profileId);
}

export function resetOwnerProfile(): ProfileRecord {
  return resetOwnerProfileRecord(getDb());
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

export function getSegmentAnalysisJobCounts(kind?: SegmentAnalysisJob['kind']): Partial<Record<SegmentAnalysisJobState, number>> {
  return getSegmentRepository().getSegmentAnalysisJobCounts(kind);
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

export function cancelSegmentAnalysisJobs(
  jobKey?: string,
  kind?: SegmentAnalysisJob['kind'],
  preserveWaiting?: boolean,
): number {
  return getSegmentRepository().cancelSegmentAnalysisJobs(jobKey, kind, preserveWaiting);
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
export function saveProgress(profileId: string, filePath: string, position: number, duration: number): StoredProgress {
  return saveProgressRecord(getDb(), profileId, filePath, position, duration);
}

export function importProgress(profileId: string, progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>): void {
  importProgressRecords(getDb(), profileId, progress);
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
    title: 'Back Up LoomTV Database',
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
  database.transaction(() => database.exec(`
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
    DELETE FROM playback_track_preferences;
    DELETE FROM profile_media_lists;
    DELETE FROM profile_library_access;
    DELETE FROM profile_restrictions;
    DELETE FROM profile_preferences;
    DELETE FROM device_profile_selections;
    DELETE FROM profiles;
    DELETE FROM episode_files;
    DELETE FROM episodes;
    DELETE FROM seasons;
    DELETE FROM media_items;
    DELETE FROM library_folders;
    DELETE FROM scan_cache;
    DELETE FROM app_settings;
  `))();
  const now = Date.now();
  database.prepare(`
    INSERT INTO profiles (id, name, avatar_key, color_key, profile_type, created_at, updated_at, sort_order)
    VALUES (?, 'Owner', 'weave-01', 'ember', 'owner', ?, ?, 0)
  `).run(randomUUID(), now, now);
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.exec('VACUUM;');
}
