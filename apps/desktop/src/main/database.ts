import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { safeFetch } from './safeFetch';
import type { LibraryData } from './appContracts.ts';
import type { ProfileExportV1 } from '../shared/desktopProtocol.ts';
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
  clearAllGuestProfiles as clearAllGuestProfilesRecord,
  createProfile as createProfileRecord,
  createGuestProfile as createGuestProfileRecord,
  deleteProfile as deleteProfileRecord,
  getDeviceProfileSelection as getDeviceProfileSelectionRecord,
  getDeviceProfileSelectionState as getDeviceProfileSelectionStateRecord,
  getDeviceSelectionRevision as getDeviceSelectionRevisionRecord,
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

export function getDeviceSelectionRevision(deviceId: string): number {
  return getDeviceSelectionRevisionRecord(getDb(), deviceId);
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

export function clearAllGuestProfiles(): void {
  clearAllGuestProfilesRecord(getDb());
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

export type ProfileImportResult = {
  profile: ProfileRecord;
  importedProgress: number;
  skippedProgress: number;
  importedLists: number;
  skippedLists: number;
};

const PROFILE_AVATAR_KEYS = new Set([
  ...Array.from({ length: 12 }, (_, index) => `glyph-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, index) => `weave-0${index + 1}`),
]);
const PROFILE_COLOR_KEYS = new Set(['ember', 'gold', 'crimson', 'ocean', 'violet', 'teal', 'rose', 'slate']);
const PROFILE_TYPES = new Set(['owner', 'standard', 'kid']);
const RATING_COUNTRIES = new Set(['US', 'GB', 'CA', 'AU']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validExportTimestamp(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= Date.now() + 86_400_000;
}

function validProfileAvatar(value: unknown): boolean {
  const avatar = String(value ?? '');
  return PROFILE_AVATAR_KEYS.has(avatar)
    || (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(avatar) && avatar.length <= 512 * 1024);
}

function validateProfileImport(value: unknown): asserts value is ProfileExportV1 {
  if (!isRecord(value) || value.format !== 'loomtv.profile.v1' || !validExportTimestamp(value.exportedAt)) {
    throw new Error('This is not a supported LoomTV profile file.');
  }
  const profile = value.profile;
  if (
    !isRecord(profile)
    || typeof profile.name !== 'string'
    || !profile.name.trim()
    || profile.name.trim().length > 30
    || !validProfileAvatar(profile.avatarKey)
    || !PROFILE_COLOR_KEYS.has(String(profile.colorKey))
    || !PROFILE_TYPES.has(String(profile.type))
  ) throw new Error('The profile metadata is invalid.');

  if (!isRecord(value.progress) || !isRecord(value.trackPreferences) || !isRecord(value.preferences)) {
    throw new Error('The profile data is malformed.');
  }
  const progressEntries = Object.entries(value.progress);
  const trackEntries = Object.entries(value.trackPreferences);
  const lists = value.lists;
  if (!Array.isArray(lists) || progressEntries.length > 100_000 || trackEntries.length > 100_000 || lists.length > 100_000) {
    throw new Error('The profile contains too many entries.');
  }
  for (const [filePath, progress] of progressEntries) {
    if (
      !filePath
      || filePath.length > 4_096
      || !isRecord(progress)
      || !Number.isFinite(progress.position)
      || Number(progress.position) < 0
      || !Number.isFinite(progress.duration)
      || Number(progress.duration) < 0
      || !validExportTimestamp(progress.updatedAt)
      || typeof progress.watched !== 'boolean'
    ) throw new Error('The profile progress data is invalid.');
  }
  for (const [scope, preferences] of trackEntries) {
    if (!scope || scope.length > 500 || !isRecord(preferences)) throw new Error('The track preferences are invalid.');
  }

  const preferences = value.preferences;
  const allowedPreferenceValues: Array<[string, ReadonlySet<string>]> = [
    ['appThemeMode', new Set(['dark', 'light'])],
    ['appThemeColor', new Set(['orange', 'yellow', 'red', 'blue', 'twitch'])],
    ['appDarkTheme', new Set(['black'])],
    ['appLoaderStyle', new Set(['play-mark', 'logo-mark', 'horizontal-logo'])],
  ];
  for (const [key, allowed] of allowedPreferenceValues) {
    if (preferences[key] !== undefined && !allowed.has(String(preferences[key]))) throw new Error('The profile preferences are invalid.');
  }
  for (const key of ['playbackSkipBackSeconds', 'playbackSkipForwardSeconds']) {
    if (preferences[key] !== undefined && (!Number.isFinite(preferences[key]) || Number(preferences[key]) < 1 || Number(preferences[key]) > 120)) {
      throw new Error('The profile preferences are invalid.');
    }
  }
  if (preferences.sidebarNavOrder !== undefined && (
    !Array.isArray(preferences.sidebarNavOrder)
    || preferences.sidebarNavOrder.length > 32
    || preferences.sidebarNavOrder.some((entry) => typeof entry !== 'string')
  )) throw new Error('The profile navigation order is invalid.');
  if (preferences.autoplayNextEnabled !== undefined && typeof preferences.autoplayNextEnabled !== 'boolean') {
    throw new Error('The profile preferences are invalid.');
  }

  const restrictions = value.restrictions;
  if (
    !isRecord(restrictions)
    || !RATING_COUNTRIES.has(String(restrictions.country))
    || (restrictions.maximumAge !== null && (!Number.isInteger(restrictions.maximumAge) || Number(restrictions.maximumAge) < 0 || Number(restrictions.maximumAge) > 18))
    || typeof restrictions.allowUnrated !== 'boolean'
    || !Array.isArray(restrictions.allowedFolders)
    || restrictions.allowedFolders.length > 1_000
    || restrictions.allowedFolders.some((folder) => typeof folder !== 'string' || folder.length > 4_096)
  ) throw new Error('The profile restrictions are invalid.');

  for (const entry of lists) {
    if (
      !isRecord(entry)
      || typeof entry.mediaId !== 'string'
      || !entry.mediaId
      || entry.mediaId.length > 240
      || (entry.kind !== 'watchlist' && entry.kind !== 'favorite')
      || !validExportTimestamp(entry.createdAt)
    ) throw new Error('The profile lists are invalid.');
  }
}

export function exportProfileData(profileId: string): ProfileExportV1 {
  const profile = getProfile(profileId);
  if (!profile || profile.isGuest) throw new Error('That profile cannot be exported.');
  return {
    format: 'loomtv.profile.v1',
    exportedAt: Date.now(),
    profile: {
      name: profile.name,
      avatarKey: profile.avatarKey,
      colorKey: profile.colorKey,
      type: profile.type,
    },
    progress: getAllProgress(profileId),
    trackPreferences: getPlaybackTrackPreferences(profileId) as Record<string, PlaybackTrackPreferences>,
    preferences: getProfilePreferences(profileId),
    restrictions: getProfileRestrictions(profileId),
    lists: getProfileLists(profileId),
  };
}

export function importProfileData(bundle: ProfileExportV1): ProfileImportResult {
  validateProfileImport(bundle);
  const progressEntries = Object.entries(bundle.progress || {});
  const trackEntries = Object.entries(bundle.trackPreferences || {});
  const listEntries = Array.isArray(bundle.lists) ? bundle.lists : [];

  const database = getDb();
  return database.transaction(() => {
    const type = bundle.profile.type === 'kid' ? 'kid' : 'standard';
    const profile = createProfileRecord(database, {
      name: bundle.profile.name.slice(0, 40),
      avatarKey: bundle.profile.avatarKey,
      colorKey: bundle.profile.colorKey,
      type,
    });
    const validPaths = new Set((database.prepare(`
      SELECT file_path FROM media_items WHERE file_path <> ''
      UNION SELECT file_path FROM episode_files WHERE file_path <> ''
    `).all() as Array<{ file_path: string }>).map((row) => row.file_path));
    const validMediaIds = new Set((database.prepare('SELECT id FROM media_items').all() as Array<{ id: string }>).map((row) => row.id));
    let importedProgress = 0;
    let skippedProgress = 0;
    let importedLists = 0;
    let skippedLists = 0;

    for (const [filePath, progress] of progressEntries) {
      if (!validPaths.has(filePath)) {
        skippedProgress++;
        continue;
      }
      saveProgressRecord(database, profile.id, filePath, Number(progress.position) || 0, Number(progress.duration) || 0);
      importedProgress++;
    }
    for (const [scope, preferences] of trackEntries) {
      if (scope.length <= 500) savePlaybackTrackPreferencesRecord(database, profile.id, scope, preferences);
    }
    saveProfilePreferencesRecord(database, profile.id, bundle.preferences || {});
    saveProfileRestrictionsRecord(database, profile.id, {
      country: bundle.restrictions?.country || 'US',
      maximumAge: type === 'kid' ? bundle.restrictions?.maximumAge ?? 13 : bundle.restrictions?.maximumAge ?? null,
      allowUnrated: Boolean(bundle.restrictions?.allowUnrated),
      allowedFolders: Array.isArray(bundle.restrictions?.allowedFolders) ? bundle.restrictions.allowedFolders : [],
    });
    for (const entry of listEntries) {
      if (!validMediaIds.has(entry.mediaId) || (entry.kind !== 'watchlist' && entry.kind !== 'favorite')) {
        skippedLists++;
        continue;
      }
      setProfileListEntryRecord(database, profile.id, entry.mediaId, entry.kind, true);
      importedLists++;
    }
    return { profile, importedProgress, skippedProgress, importedLists, skippedLists };
  })();
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

export function clearDatabase(): ProfileRecord {
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
    DELETE FROM device_profile_selection_revisions;
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
  const ownerId = randomUUID();
  database.prepare(`
    INSERT INTO profiles (id, name, avatar_key, color_key, profile_type, created_at, updated_at, sort_order)
    VALUES (?, 'Owner', 'glyph-01', 'ember', 'owner', ?, ?, 0)
  `).run(ownerId, now, now);
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.exec('VACUUM;');
  const owner = getProfile(ownerId);
  if (!owner) throw new Error('The clean Owner profile could not be created.');
  return owner;
}
