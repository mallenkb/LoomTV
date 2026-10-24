import { app, dialog, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import type { DatabaseSync } from 'node:sqlite';
import { profileAllowsCanonicalMedia, createCanonicalMediaAccess } from 'loom-media-server-headless/native-persistence';
import { safeFetch } from './safeFetch.ts';
import { runBoundedArtworkFetch } from './artworkFetchAdmission.ts';
import { artworkExtensionForMimeType } from './artworkCache.ts';
import { decryptLocalSecret, encryptLocalSecret, isLocalSecretCiphertext, localSecretStorage } from './localSecretStorage.ts';
import {
  artworkNegativeCacheAllows,
  rememberArtworkFailure,
  rememberArtworkSuccess,
  resizeArtworkBytes,
  sanitizeArtworkBytes,
} from './artworkSecurity.ts';
import type { LibraryData, LibraryFolderStatus } from './appContracts.ts';
import type { MediaItem } from './metadata/types.ts';
import type { ProfileExportV1, StremioPluginConfigurationField } from '../shared/desktopProtocol.ts';
import {
  createDatabaseArtworkRepository,
  hashArtworkFile,
  type CachedArtwork,
  type FetchedArtworkBytes,
} from './databaseArtworkRepository.ts';
import { createThumbnailCache, type CachedThumbnail } from './thumbnailCache.ts';
import { backupDestinationOverlapsLiveDatabase } from './backupDestination.ts';
import { compactDatabaseIfWasteful, trimFreePages } from './databaseCompaction.ts';
import {
  loadLibrary as loadLibraryRecord,
  remapLibraryMediaReferences as remapLibraryMediaReferencesRecord,
  saveLibraryItem as saveLibraryItemRecord,
  saveLibraryScanDelta as saveLibraryScanDeltaRecord,
} from './databaseLibraryRepository.ts';
import {
  getMetadataRefreshState as getMetadataRefreshStateRecord,
  recordMetadataRefresh as recordMetadataRefreshRecord,
  type MetadataRefreshCategory,
} from './databaseMetadataRefreshRepository.ts';
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
  createSecureSettingsPersistence,
  type SecureSettingsCodec,
} from './secureSettings.ts';
import {
  createDatabaseSegmentsRepository,
  type SegmentAnalysisInventory,
  type StoredMediaFingerprint,
} from './databaseSegmentsRepository.ts';
import {
  hasProfileStremioAccess as hasProfileStremioAccessRecord,
  hasLegacyStremioAddonState,
  listProfileStremioAccess as listProfileStremioAccessRecords,
  loadStremioAddonState as loadStremioAddonStateRecord,
  saveStremioAddonState as saveStremioAddonStateRecord,
  setProfileStremioAccess as setProfileStremioAccessRecord,
  type PersistedStremioAddonSnapshot,
  type StremioSecurePersistence,
  type StremioStateAuditContext,
} from './databasePluginRepository.ts';
import {
  listPluginAudit,
  PluginSecretStore,
  recordPluginAudit,
  type PluginAuditEntry,
  type PluginSecretReference,
  type SecretCodec,
} from './pluginSecretStore.ts';
import type { SegmentAnalysisJob, SegmentAnalysisJobState } from './skipSegments/analysisJobs.ts';
import type {
  MediaSegment,
  MediaSegmentCandidate,
  MediaSegmentSource,
  ProviderCacheEntry,
} from './skipSegments/types';
import { profilesMigrationPending } from './databaseMigrations.ts';
import { openConsolidatedVideoDatabase, videoDatabaseRevision, canonicalVideoConnection } from './consolidatedVideoDatabase.ts';
import {
  clearDeviceProfileSelection as clearDeviceProfileSelectionRecord,
  createProfile as createProfileRecord,
  createGuestProfile as createGuestProfileRecord,
  deleteProfile as deleteProfileRecord,
  getDeviceProfileSelectionState as getDeviceProfileSelectionStateRecord,
  getDeviceSelectionRevision as getDeviceSelectionRevisionRecord,
  getProfile as getProfileRecord,
  getProfileLists as getProfileListsRecord,
  getProfilePinCredentials as getProfilePinCredentialsRecord,
  getProfilePreferences as getProfilePreferencesRecord,
  getProfileRestrictions as getProfileRestrictionsRecord,
  listProfiles as listProfileRecords,
  reorderProfiles as reorderProfileRecords,
  resetOwnerProfile as resetOwnerProfileRecord,
  saveProfilePreferences as saveProfilePreferencesRecord,
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
  ProfileUpdateInput,
} from './databaseProfilesRepository.ts';
export type { CachedArtwork,  } from './databaseArtworkRepository.ts';
export type { StoredMediaFingerprint } from './databaseSegmentsRepository.ts';
export type { PersistedStremioAddonSnapshot } from './databasePluginRepository.ts';

let db: BetterSqlite3.Database | null = null;
let artworkRepository: ReturnType<typeof createDatabaseArtworkRepository> | null = null;
let thumbnailRepository: ReturnType<typeof createThumbnailCache> | null = null;
let segmentRepository: ReturnType<typeof createDatabaseSegmentsRepository> | null = null;
let pluginSecretStore: PluginSecretStore | null = null;

function databasePath(): string {
  return path.join(app.getPath('userData'), 'loomtv-canonical.sqlite');
}

function artworkCacheDirectory(): string {
  return path.join(app.getPath('userData'), 'artwork-cache');
}

function pluginArtworkCacheDirectory(): string {
  return path.join(app.getPath('userData'), 'plugin-artwork-cache');
}

function getDb(): BetterSqlite3.Database {
  if (db) return db;

  const connection = openConsolidatedVideoDatabase(app.getPath('userData'));
  db = connection;
  scheduleDatabaseMaintenance(connection);
  return connection;
}

/**
 * Compact a mostly-empty file once, then fold the WAL back into the database
 * before the process exits. The handle stays open: late callbacks during quit
 * may still write, and a closed handle would turn those into uncaught
 * main-process errors.
 */
export function checkpointDatabaseForQuit(): void {
  if (!db) return;
  try {
    compactDatabaseIfWasteful(db);
  } catch (error) {
    console.warn('[database] Quit compaction failed:', error);
  }
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    console.warn('[database] Quit checkpoint failed:', error);
  }
}

let freePageTrimTimer: NodeJS.Timeout | null = null;

/**
 * Return free pages a bounded step at a time until none are left. One step
 * per launch took many launches to give back a large deletion, such as the
 * thumbnail BLOBs moving out of the database.
 */
function scheduleFreePageTrim(database: BetterSqlite3.Database, delayMs = 1_000): void {
  if (freePageTrimTimer) return;
  freePageTrimTimer = setTimeout(() => {
    freePageTrimTimer = null;
    if (db !== database) return;
    try {
      if (trimFreePages(database) > 0) scheduleFreePageTrim(database);
      else database.pragma('wal_checkpoint(PASSIVE)');
    } catch (error) {
      console.warn('[database] Free page trim failed:', error);
    }
  }, delayMs);
  freePageTrimTimer.unref();
}

function scheduleDatabaseMaintenance(database: BetterSqlite3.Database): void {
  const timer = setTimeout(() => {
    if (db !== database) return;
    try {
      database.pragma('optimize');
      database.pragma('wal_checkpoint(PASSIVE)');
    } catch (error) {
      console.warn('[database] Idle maintenance failed:', error);
    }
    scheduleFreePageTrim(database, 0);
  }, 30_000);
  timer.unref();
}

const secureSettingsCodec: SecureSettingsCodec = {
  isEncryptionAvailable: localSecretStorage.isEncryptionAvailable,
  encrypt: (value) => encryptLocalSecret(value).toString('base64'),
  decrypt: (value) => {
    const bytes = Buffer.from(value, 'base64');
    if (!bytes.length || bytes.toString('base64') !== value) throw new Error('Invalid encrypted settings encoding.');
    return decryptLocalSecret(bytes).plaintext;
  },
  isCurrentCiphertext: (value) => isLocalSecretCiphertext(Buffer.from(value, 'base64')),
};

export function profileCanReadCanonicalVideo(profileId: string, mediaId: string, locator?: string): boolean {
  return profileAllowsCanonicalMedia(canonicalVideoConnection(getDb()) as unknown as DatabaseSync, profileId, mediaId, locator);
}

export function createProfileCanonicalVideoAccess(profileId: string): (mediaId: string, locator?: string) => boolean {
  return createCanonicalMediaAccess(canonicalVideoConnection(getDb()) as unknown as DatabaseSync, profileId);
}

export function resolveCanonicalVideoId(alias: string): string | null {
  const row = canonicalVideoConnection(getDb()).prepare('SELECT media_id FROM media_identity_aliases WHERE alias=? ORDER BY created_at DESC LIMIT 1')
    .get(alias) as {media_id: string} | undefined;
  return row?.media_id || null;
}

export function getVideoDatabaseRevision(): string {
  return videoDatabaseRevision(getDb());
}

export function isProfilesMigrationComplete(): boolean {
  return !profilesMigrationPending(getDb());
}

/** The committed canonical migration id, or null when there is none or it cannot be read. */
export function readCommittedCanonicalMigrationId(): string | null {
  const canonicalPath = path.join(app.getPath('userData'), 'loomtv-canonical.sqlite');
  if (!fs.existsSync(canonicalPath)) return null;
  let canonical: BetterSqlite3.Database | null = null;
  try {
    canonical = new BetterSqlite3(canonicalPath, { readonly: true, fileMustExist: true });
    const row = canonical.prepare("SELECT id FROM migration_markers WHERE state = 'committed'").get() as { id?: unknown } | undefined;
    return typeof row?.id === 'string' && row.id ? row.id : null;
  } catch {
    return null;
  } finally {
    canonical?.close();
  }
}

function getSegmentRepository(): ReturnType<typeof createDatabaseSegmentsRepository> {
  segmentRepository ||= createDatabaseSegmentsRepository(getDb());
  return segmentRepository;
}

function getPluginSecretStore(): PluginSecretStore {
  if (pluginSecretStore) return pluginSecretStore;
  if (!localSecretStorage.isEncryptionAvailable()) {
    throw new Error('The local secret store is unavailable.');
  }
  const database = getDb();
  const row = database.prepare('SELECT ciphertext FROM plugin_secret_store_keys WHERE id = 1').get() as { ciphertext?: string } | undefined;
  let macKey: Buffer;
  if (!row?.ciphertext) {
    macKey = randomBytes(32);
    const protectedKey = encryptLocalSecret(macKey.toString('base64')).toString('base64');
    database.prepare('INSERT OR REPLACE INTO plugin_secret_store_keys (id, ciphertext, created_at) VALUES (1, ?, ?)')
      .run(protectedKey, Date.now());
  } else {
    try {
      const recovered = decryptLocalSecret(Buffer.from(row.ciphertext, 'base64'));
      macKey = Buffer.from(recovered.plaintext, 'base64');
      if (recovered.needsMigration) {
        database.prepare('UPDATE plugin_secret_store_keys SET ciphertext = ? WHERE id = 1')
          .run(encryptLocalSecret(recovered.plaintext).toString('base64'));
      }
    } catch (error) {
      throw new Error('LoomTV could not recover its saved secret-store key.', { cause: error });
    }
    if (macKey.length < 32) throw new Error('The recovered LoomTV secret-store key is invalid.');
  }
  const codec: SecretCodec = {
    encrypt: (value) => encryptLocalSecret(value).toString('base64'),
    decrypt: (value) => decryptLocalSecret(Buffer.from(value, 'base64')).plaintext,
  };
  pluginSecretStore = new PluginSecretStore(database, codec, macKey);
  pluginSecretStore.migrateCiphertexts((value) => isLocalSecretCiphertext(Buffer.from(value, 'base64')));
  return pluginSecretStore;
}

function configFieldsForAddon(addonId: string): readonly StremioPluginConfigurationField[] {
  const record = loadStremioAddonState()?.addons.find((candidate) => candidate.addonId === addonId);
  const config = (record?.manifest as { config?: readonly StremioPluginConfigurationField[] } | undefined)?.config || [];
  return config.map((field) => ({
    key: field.key,
    type: field.type,
    required: field.required,
    ...(field.title ? { title: field.title } : {}),
    ...(field.options ? { options: [...field.options] } : {}),
  }));
}

export function getStremioAddonConfiguration(addonId: string): Readonly<Record<string, string>> {
  try {
    const allowedFields = new Set(configFieldsForAddon(addonId).map((field) => field.key));
    return Object.fromEntries(Object.entries(getPluginSecretStore().values(addonId))
      .filter(([field]) => allowedFields.has(field)));
  } catch {
    return {};
  }
}

export function isStremioAddonConfigured(addonId: string, requiredFields?: readonly string[]): boolean {
  const fields = requiredFields || configFieldsForAddon(addonId).filter((field) => field.required).map((field) => field.key);
  try {
    return getPluginSecretStore().hasRequired(addonId, fields);
  } catch {
    return fields.length === 0;
  }
}

export function getStremioAddonConfigurationState(addonId: string, fields = configFieldsForAddon(addonId)) {
  const record = loadStremioAddonState()?.addons.find((candidate) => candidate.addonId === addonId);
  const requiresHostConfiguration = Boolean(
    (record?.manifest as { behaviorHints?: { configurationRequired?: boolean } } | undefined)?.behaviorHints?.configurationRequired
    || fields.some((field) => field.required),
  );
  const references: readonly PluginSecretReference[] = (() => {
    try { return getPluginSecretStore().list(addonId); } catch { return []; }
  })();
  const configuredFields = references
    .map((reference) => reference.fieldKey)
    .filter((key) => fields.some((field) => field.key === key));
  const requiredFields = fields.filter((field) => field.required).map((field) => field.key);
  return {
    fields,
    configured: requiresHostConfiguration
      && !((record?.manifest as { behaviorHints?: { configurationRequired?: boolean } } | undefined)?.behaviorHints?.configurationRequired && fields.length === 0)
      ? isStremioAddonConfigured(addonId, requiredFields)
      : !requiresHostConfiguration,
    configuredFields,
    revision: (() => {
      try { return getPluginSecretStore().getRevision(); } catch { return 0; }
    })(),
  };
}

function normalizeConfigValue(field: StremioPluginConfigurationField, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (field.type === 'checkbox' || field.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`Configuration field ${field.key} must be boolean.`);
    return value ? 'true' : 'false';
  }
  if (field.type === 'number') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error(`Configuration field ${field.key} must be numeric.`);
    return String(number);
  }
  const text = typeof value === 'string' ? value : String(value);
  if (field.options?.length && !field.options.includes(text)) throw new Error(`Configuration field ${field.key} has an unsupported option.`);
  return text;
}

export function saveStremioAddonConfiguration(addonId: string, rawValues: Readonly<Record<string, unknown>>) {
  const fields = configFieldsForAddon(addonId);
  const definitions = new Map(fields.map((field) => [field.key, field]));
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawValues)) {
    if (key.startsWith('loomtvHost_')) throw new Error('Host-reserved configuration fields cannot be changed.');
    const field = definitions.get(key);
    if (!field) throw new Error(`Unknown configuration field ${key}.`);
    const normalized = normalizeConfigValue(field, value);
    if (normalized !== undefined) values[key] = normalized;
  }
  for (const field of fields) {
    if (field.required && !values[field.key]) throw new Error(`Configuration field ${field.key} is required.`);
  }
  getPluginSecretStore().replace(addonId, values);
  return getStremioAddonConfigurationState(addonId, fields);
}

export function listStremioPluginAudit(addonId: string, limit = 100): readonly PluginAuditEntry[] {
  return listPluginAudit(getDb(), addonId, limit);
}

export function recordStremioPluginAudit(addonId: string, eventType: string, detail: Record<string, unknown> = {}): void {
  recordPluginAudit(getDb(), addonId, eventType, { actor: 'host:system', detail });
}

function getArtworkRepository(): ReturnType<typeof createDatabaseArtworkRepository> {
  artworkRepository ||= createDatabaseArtworkRepository(getDb(), {
    cacheDirectory: artworkCacheDirectory(),
    fetchArtworkBytes,
    resizeArtworkBytes: (bytes, mimeType, maxWidth) => runBoundedArtworkFetch(() => resizeArtworkBytes(bytes, mimeType, maxWidth)),
  });
  return artworkRepository;
}

function thumbnailCacheDirectory(): string {
  return path.join(app.getPath('userData'), 'thumbnail-cache');
}

function getThumbnailRepository(): ReturnType<typeof createThumbnailCache> {
  const database = getDb();
  thumbnailRepository ||= createThumbnailCache({
    directory: thumbnailCacheDirectory(),
    database,
    scheduleMigration: true,
    onLegacyDrained: () => scheduleFreePageTrim(database),
  });
  return thumbnailRepository;
}

export function thumbnailCacheKey(
  filePath: string,
  time: string,
  embedded: boolean,
  streamIndex?: number,
): string | null {
  try {
    const stat = fs.statSync(filePath);
    return createHash('sha256').update(JSON.stringify({
      filePath: path.resolve(filePath),
      fileSize: stat.size,
      modifiedAtMs: stat.mtimeMs,
      time,
      embedded,
      streamIndex: streamIndex ?? null,
    })).digest('hex');
  } catch {
    return null;
  }
}

export function getCachedThumbnail(cacheKey: string): CachedThumbnail | null {
  return getThumbnailRepository().getCachedThumbnail(cacheKey);
}

export function saveCachedThumbnail(cacheKey: string, bytes: Buffer, mimeType = 'image/jpeg'): void {
  getThumbnailRepository().saveCachedThumbnail(cacheKey, bytes, mimeType);
}


export function loadLibraryFromDatabase(): LibraryData | null {
  // The library payload is profile-neutral: viewer recency is derived from the
  // selected profile's progress by each client, never baked into the catalog.
  const library = loadLibraryRecord(getDb(), getCustomArtworkTargets());
  if (!library) return {
    movies: [], tvShows: [], animeShows: [], libraryFolders: [],
    libraryFolderGroups: { movies: [], tvShows: [], anime: [], others: [] }, scanCache: {},
  };
  // Legacy episode rows had no rating column. Keep canonical episode policies
  // available to the native profile filter without changing repository SQL.
  const ratings = canonicalVideoConnection(getDb()).prepare(`SELECT json_extract(extension_json,'$.seriesId') series_id,
    series_season season,series_episode episode,
    COALESCE(json_extract(extension_json,'$.contentRatings'),json_extract(extension_json,'$.metadata.contentRatings')) ratings_json
    FROM catalog_items WHERE media_kind='episode' AND ratings_json IS NOT NULL`).all() as Array<{
      series_id: string; season: number; episode: number; ratings_json: string;
    }>;
  const bySeries = new Map<string, Map<string, MediaItem['contentRatings']>>();
  for (const row of ratings) {
    const contentRatings: unknown = JSON.parse(row.ratings_json);
    if (!contentRatings || typeof contentRatings !== 'object' || Array.isArray(contentRatings)) continue;
    if (!bySeries.has(row.series_id)) bySeries.set(row.series_id, new Map());
    bySeries.get(row.series_id)?.set(`${row.season}:${row.episode}`, contentRatings as MediaItem['contentRatings']);
  }
  for (const show of [...library.tvShows, ...library.animeShows]) {
    const episodes = bySeries.get(show.id);
    if (!episodes) continue;
    show.episodes = show.episodes?.map((episode) => {
      const contentRatings = episodes.get(`${episode.season}:${episode.number}`);
      return contentRatings ? { ...episode, contentRatings } : episode;
    });
  }
  return library;
}

export function saveLibraryToDatabase(data: LibraryData): void {
  const database = getDb();
  const items = [...data.movies, ...data.tvShows, ...(data.animeShows || [])];
  const desired = new Set(items.map((item) => item.id));
  const groups = data.libraryFolderGroups || { movies: data.libraryFolders, tvShows: [], anime: [], others: [] };
  database.transaction(() => {
    const previous = loadLibraryFromDatabase();
    const removed = [...(previous?.movies || []), ...(previous?.tvShows || []), ...(previous?.animeShows || [])]
      .filter((item) => !desired.has(item.id)).map((item) => item.id);
    const folders = new Set<string>();
    const insert = database.prepare('INSERT OR REPLACE INTO library_folders(path,kind,added_at) VALUES(?,?,?)');
    for (const [kind, paths] of Object.entries(groups)) for (const folder of paths || []) {
      folders.add(folder);
      insert.run(folder, kind, Date.now());
    }
    saveLibraryScanDeltaRecord(database, items, removed, data.scanCache || {});
    for (const folder of previous?.libraryFolders || []) if (!folders.has(folder)) {
      database.prepare('DELETE FROM library_folders WHERE path=?').run(folder);
      database.prepare('DELETE FROM scan_cache WHERE folder_path=?').run(folder);
    }
  }).immediate();
}

export function saveLibraryItemToDatabase(item: import('./metadata/types.ts').MediaItem): void {
  saveLibraryItemRecord(getDb(), item);
}

export function getMetadataRefreshState(mediaId: string, category: MetadataRefreshCategory) {
  return getMetadataRefreshStateRecord(getDb(), mediaId, category);
}

export function recordMetadataRefresh(
  mediaId: string,
  category: MetadataRefreshCategory,
  result: { refreshedAt?: number; error?: string; locked?: boolean },
): void {
  recordMetadataRefreshRecord(getDb(), mediaId, category, result);
}

export function remapLibraryMediaReferences(aliases: ReadonlyMap<string, string>): void {
  remapLibraryMediaReferencesRecord(getDb(), aliases);
}
/**
 * The live TV service owns its tables end to end and rewrites a source's
 * channels and guide entries as single transactions, so it takes the
 * connection rather than a facade wrapper for each statement.
 */
export function getIptvDatabase(): BetterSqlite3.Database {
  return getDb();
}

/**
 * Renaming media files rewrites path-, ID-, and revision-keyed rows across
 * several tables in one transaction, so it also takes the connection.
 */
export function getMediaRenameDatabase(): BetterSqlite3.Database {
  return getDb();
}

let unreadableSecureSettingsPending = false;
/** Photos share the Electron database and its whole-database backup. */
export function getPhotoDatabase(): BetterSqlite3.Database {
  return getDb();
}

/** Non-video repositories own separate table groups in the shared database. */
export function getMediaLibraryDatabase(): BetterSqlite3.Database {
  return getDb();
}

function secureSettingsPersistence() {
  const database = getDb();
  return createSecureSettingsPersistence({
    load: () => loadSettingsRecord(database),
    save: (settings) => saveSettingsRecord(database, settings),
    transaction: (action) => database.transaction(action)(),
  }, secureSettingsCodec, {
    onUnreadable: (error) => {
      if (!unreadableSecureSettingsPending) console.warn('[settings] Saved credentials could not be decrypted; continuing without them:', error.message);
      unreadableSecureSettingsPending = true;
    },
  });
}

/** True once per launch in which saved credentials could not be decrypted. */
export function takeUnreadableSecureSettingsWarning(): boolean {
  const pending = unreadableSecureSettingsPending;
  unreadableSecureSettingsPending = false;
  return pending;
}

export function loadSettingsFromDatabase(): SettingsData | null {
  return secureSettingsPersistence().load();
}

export function migrateLegacyCredentialStorage(): void {
  secureSettingsPersistence().load();
  getPluginSecretStore();
}

export function loadMetadataOfflineModeFromDatabase(): boolean | null {
  const stored = loadSettingsRecord(getDb());
  return stored ? Boolean(stored.metadataOfflineMode) : null;
}

export function saveSettingsToDatabase(settings: SettingsData): void {
  secureSettingsPersistence().save(settings);
}

function stremioSecurePersistence(): StremioSecurePersistence {
  const database = getDb();
  const secrets = getPluginSecretStore();
  return {
    protectManifestUrl: (addonId, manifestUrl) => secrets.put(addonId, 'loomtvHost_manifestUrl', manifestUrl).ref,
    resolveManifestUrl: (addonId, secretRef) => secrets.get(addonId, secretRef, 'loomtvHost_manifestUrl'),
    signState: (addonId, revision, serializedRecord) => secrets.signState(addonId, revision, serializedRecord),
    verifyState: (addonId, revision, serializedRecord, integrityMac) => secrets.verifyState(addonId, revision, serializedRecord, integrityMac),
    recordAudit: (context) => recordPluginAudit(database, context.addonId, context.eventType, {
      actor: context.actor,
      priorRevision: context.priorRevision,
      newRevision: context.newRevision,
      outcome: context.outcome,
      detail: { ...context.detail },
      createdAt: context.createdAt,
    }),
  };
}

export function loadStremioAddonState(): PersistedStremioAddonSnapshot | null {
  const database = getDb();
  const secure = stremioSecurePersistence();
  const snapshot = loadStremioAddonStateRecord(database, secure);
  if (snapshot && hasLegacyStremioAddonState(database)) {
    // The outer repository transaction covers URL protection, v2 state, and
    // the migration audit row. Any encryption or integrity failure rolls all
    // three back, leaving the v1 row available for a later recovery attempt.
    const migrationAddon = snapshot.addons[0];
    if (!migrationAddon) return snapshot;
    saveStremioAddonStateRecord(database, snapshot, secure, {
      addonId: migrationAddon.addonId,
      eventType: 'trust_state_v2_migrated',
      actor: 'host:migration',
      detail: { addonCount: snapshot.addons.length },
    });
  }
  return snapshot;
}

export function saveStremioAddonState(
  snapshot: unknown,
  audit?: StremioStateAuditContext,
): PersistedStremioAddonSnapshot {
  return saveStremioAddonStateRecord(getDb(), snapshot, stremioSecurePersistence(), audit);
}

export function listProfileStremioAccess(profileId: string): string[] {
  return listProfileStremioAccessRecords(getDb(), profileId);
}

export function hasProfileStremioAccess(profileId: string, addonId: string): boolean {
  return hasProfileStremioAccessRecord(getDb(), profileId, addonId);
}

export function setProfileStremioAccess(profileId: string, addonId: string, enabled: boolean): boolean {
  return setProfileStremioAccessRecord(getDb(), profileId, addonId, enabled);
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

export function createProfile(input: ProfileCreateInput): ProfileRecord {
  return createProfileRecord(getDb(), input);
}

export function updateProfile(profileId: string, patch: ProfileUpdateInput): ProfileRecord {
  return updateProfileRecord(getDb(), profileId, patch);
}

export function deleteProfile(profileId: string): void {
  deleteProfileRecord(getDb(), profileId);
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
  const raw = canonicalVideoConnection(getDb());
  raw.prepare(`DELETE FROM profiles WHERE kind='guest' AND (guest_device_id IN (SELECT device_id FROM native_selection_revisions)
    OR guest_device_id IN (SELECT id FROM devices WHERE kind='desktop' AND disabled=1))`).run();
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

export function getProfileRestrictionState(profileId: string): { restrictions: ProfileRestrictions; configured: boolean } {
  const database = getDb();
  const restrictions = getProfileRestrictionsRecord(database, profileId);
  const raw = canonicalVideoConnection(database);
  const stored = raw.prepare('SELECT allowed_root_ids_json FROM profile_restrictions WHERE profile_id=?')
    .get(profileId) as { allowed_root_ids_json: string | null } | undefined;
  const paths = raw.prepare('SELECT 1 FROM profile_path_grants WHERE profile_id=? LIMIT 1').get(profileId);
  const constrained = stored?.allowed_root_ids_json != null || Boolean(paths);
  return {
    restrictions: { ...restrictions, ...(constrained && restrictions.allowedFolders.length === 0 ? { denyAll: true } : {}) },
    configured: Boolean(stored),
  };
}

export function getProfileRestrictions(profileId: string): ProfileRestrictions {
  return getProfileRestrictionState(profileId).restrictions;
}

export function saveProfileRestrictions(profileId: string, input: Omit<ProfileRestrictions, 'revision'>): ProfileRestrictions {
  const database = getDb();
  return database.transaction(() => {
    const profile = getProfileRecord(database, profileId);
    if (!profile) throw new Error('That profile no longer exists.');
    if (!RATING_COUNTRIES.has(input.country)) throw new Error('Choose a supported ratings country.');
    const requestedMaximumAge = input.maximumAge === null ? null : Number(input.maximumAge);
    if (requestedMaximumAge !== null && !Number.isFinite(requestedMaximumAge)) throw new Error('Choose a valid maximum age.');
    const maximumAge = requestedMaximumAge === null ? null : Math.min(18, Math.max(0, Math.round(requestedMaximumAge)));
    if (profile.type === 'kid' && maximumAge === null) throw new Error('Choose a maximum age for a Kids profile.');
    if (input.denyAll !== undefined && typeof input.denyAll !== 'boolean') throw new Error('Choose valid folder access.');
    const folders = [...new Set(input.allowedFolders.map(String).map((folder) => folder.trim()).filter(Boolean))];
    const before = getProfileRestrictions(profileId);
    const sameFolders = JSON.stringify([...folders].sort()) === JSON.stringify([...before.allowedFolders].sort());
    const denyAll = input.denyAll ?? (folders.length === 0 && before.denyAll === true);
    const raw = canonicalVideoConnection(database);
    const stored = raw.prepare('SELECT allowed_root_ids_json FROM profile_restrictions WHERE profile_id=?')
      .get(profileId) as { allowed_root_ids_json: string | null } | undefined;
    // An age-only edit must preserve the canonical root IDs and narrower grants.
    const preserveFolders = sameFolders && denyAll === Boolean(before.denyAll);
    if (!preserveFolders) {
      const available = raw.prepare("SELECT 1 FROM library_roots WHERE state!='removed' AND loom_contains(locator,?) LIMIT 1");
      for (const folder of folders) if (!available.get(folder)) throw new Error('Folder access must use a current library folder.');
    }
    const roots = denyAll ? '[]' : preserveFolders ? stored?.allowed_root_ids_json ?? null : null;
    const payload = JSON.stringify({ country: input.country, maximumAge, allowUnrated: Boolean(input.allowUnrated) });
    raw.prepare(`INSERT INTO profile_restrictions(profile_id,allowed_root_ids_json,payload_json,revision) VALUES(?,?,?,1)
      ON CONFLICT(profile_id) DO UPDATE SET allowed_root_ids_json=excluded.allowed_root_ids_json,
        payload_json=excluded.payload_json,revision=profile_restrictions.revision+1`)
      .run(profileId, roots, payload);
    raw.prepare(`INSERT INTO native_profile_ui(profile_id,restrictions_updated_at) VALUES(?,?)
      ON CONFLICT(profile_id) DO UPDATE SET restrictions_updated_at=excluded.restrictions_updated_at`).run(profileId, Date.now());
    if (!preserveFolders) {
      raw.prepare('DELETE FROM profile_path_grants WHERE profile_id=?').run(profileId);
      const insert = raw.prepare('INSERT INTO profile_path_grants(profile_id,folder_path) VALUES(?,?)');
      if (!denyAll) for (const folder of folders) insert.run(profileId, folder);
    }
    raw.prepare('UPDATE profile_selections SET revision=revision+1 WHERE profile_id=?').run(profileId);
    return getProfileRestrictions(profileId);
  }).immediate();
}

export function getProfileLists(profileId: string, kind?: ProfileListKind): ProfileListEntry[] {
  return getProfileListsRecord(getDb(), profileId, kind);
}

export function setProfileListEntry(profileId: string, mediaId: string, kind: ProfileListKind, present: boolean): ProfileListEntry[] {
  return setProfileListEntryRecord(getDb(), profileId, mediaId, kind, present);
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
    ['appHomeStyle', new Set(['default', 'modern'])],
    ['appPlayerControlStyle', new Set(['default', 'pill'])],
    ['appModernHeroMode', new Set(['continue-watching', 'featured'])],
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
    || preferences.sidebarNavOrder.length > 256
    || preferences.sidebarNavOrder.some((entry) => typeof entry !== 'string')
  )) throw new Error('The profile navigation order is invalid.');
  if (preferences.hiddenSidebarItems !== undefined && (
    !Array.isArray(preferences.hiddenSidebarItems)
    || preferences.hiddenSidebarItems.length > 256
    || preferences.hiddenSidebarItems.some(entry => typeof entry !== 'string' || entry.length > 8192)
  )) throw new Error('The profile sidebar visibility is invalid.');
  if (preferences.autoplayNextEnabled !== undefined && typeof preferences.autoplayNextEnabled !== 'boolean') {
    throw new Error('The profile preferences are invalid.');
  }

  const restrictions = value.restrictions;
  if (
    !isRecord(restrictions)
    || !RATING_COUNTRIES.has(String(restrictions.country))
    || (restrictions.maximumAge !== null && (!Number.isInteger(restrictions.maximumAge) || Number(restrictions.maximumAge) < 0 || Number(restrictions.maximumAge) > 18))
    || typeof restrictions.allowUnrated !== 'boolean'
    || (restrictions.denyAll !== undefined && typeof restrictions.denyAll !== 'boolean')
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
      || (entry.kind !== 'watchlist' && entry.kind !== 'favorite' && entry.kind !== 'watched')
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
    saveProfileRestrictions(profile.id, {
      country: bundle.restrictions?.country || 'US',
      maximumAge: type === 'kid' ? bundle.restrictions?.maximumAge ?? 13 : bundle.restrictions?.maximumAge ?? null,
      allowUnrated: Boolean(bundle.restrictions?.allowUnrated),
      allowedFolders: Array.isArray(bundle.restrictions?.allowedFolders) ? bundle.restrictions.allowedFolders : [],
      ...(bundle.restrictions?.denyAll === true ? {denyAll:true} : {}),
    });
    for (const entry of listEntries) {
      const isDiscoverWatched = entry.kind === 'watched' && entry.mediaId.startsWith('discover:');
      if ((!validMediaIds.has(entry.mediaId) && !isDiscoverWatched)
        || (entry.kind !== 'watchlist' && entry.kind !== 'favorite' && entry.kind !== 'watched')) {
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
function getCustomArtworkTargets(): Map<string, Set<string>> {
  return getArtworkRepository().getCustomArtworkTargets();
}
export function getCachedArtwork(sourceUrl: string): CachedArtwork | null {
  return getArtworkRepository().getCachedArtwork(sourceUrl);
}
async function fetchArtworkBytes(sourceUrl: string): Promise<FetchedArtworkBytes | null> {
  if (!artworkNegativeCacheAllows(sourceUrl)) return null;
  try {
    const response = await safeFetch(sourceUrl, {}, {
      allowedHosts: [
        '.fanart.tv',
        '.anilist.co',
        '.media-amazon.com',
        '.metahub.space',
        '.myanimelist.net',
        '.themoviedb.org',
        '.thetvdb.com',
        '.tmdb.org',
        '.tvmaze.com',
      ],
      timeoutMs: 20_000,
      maxBytes: 5 * 1024 * 1024,
      retries: 2,
    });
    if (!response.ok) {
      rememberArtworkFailure(sourceUrl);
      return null;
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0] || '';
    if (!mimeType.startsWith('image/')) {
      rememberArtworkFailure(sourceUrl);
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const sanitized = await sanitizeArtworkBytes(bytes, mimeType, { fallbackDecoder: nativeImage });
    rememberArtworkSuccess(sourceUrl);
    return sanitized;
  } catch {
    rememberArtworkFailure(sourceUrl);
    return null;
  }
}

// The desktop is the LAN artwork source. When an older library entry has not
// been pre-cached yet, fetch and persist the image here instead of making a
// paired device follow a redirect to the metadata provider.
export async function cacheArtworkSource(sourceUrl: string): Promise<CachedArtwork | null> {
  return getArtworkRepository().cacheArtworkSource(sourceUrl);
}

export function getResizedArtwork(sourceUrl: string, maxWidth: number): CachedArtwork | null {
  return getArtworkRepository().getResizedArtwork(sourceUrl, maxWidth);
}

export async function cacheResizedArtwork(sourceUrl: string, maxWidth: number): Promise<CachedArtwork | null> {
  return getArtworkRepository().cacheResizedArtwork(sourceUrl, maxWidth);
}

const PLUGIN_ARTWORK_MAX_ENTRIES_PER_ADDON = 512;
const PLUGIN_ARTWORK_MAX_BYTES_PER_ADDON = 64 * 1024 * 1024;
const pendingPluginArtwork = new Map<string, Promise<CachedArtwork | null>>();

type PluginArtworkObjectRow = {
  content_hash: string;
  cache_path: string;
  mime_type: string;
  byte_length: number;
};

function pluginArtworkObject(addonId: string, sourceUrl: string): PluginArtworkObjectRow | null {
  const row = getDb().prepare(`
    SELECT object.content_hash, object.cache_path, object.mime_type, object.byte_length
    FROM plugin_artwork_references AS reference
    JOIN plugin_artwork_objects AS object ON object.content_hash = reference.content_hash
    WHERE reference.addon_id = ? AND reference.source_url = ?
  `).get(addonId, sourceUrl) as PluginArtworkObjectRow | undefined;
  if (!row || (row.mime_type !== 'image/png' && row.mime_type !== 'image/jpeg') || !fs.existsSync(row.cache_path)) return null;
  try {
    // Streams and remembers the digest per file version rather than reading
    // the whole image into memory on every poster request.
    const { byteLength, contentHash } = hashArtworkFile(row.cache_path);
    if (byteLength !== row.byte_length || contentHash !== row.content_hash) throw new Error('integrity mismatch');
    getDb().prepare('UPDATE plugin_artwork_references SET updated_at = ? WHERE addon_id = ? AND source_url = ?')
      .run(Date.now(), addonId, sourceUrl);
    return row;
  } catch {
    removePluginArtworkReference(addonId, sourceUrl);
    return null;
  }
}

function removeUnreferencedPluginArtworkObject(contentHash: string): void {
  const database = getDb();
  const count = database.prepare('SELECT COUNT(*) AS count FROM plugin_artwork_references WHERE content_hash = ?')
    .get(contentHash) as { count: number };
  if (count.count > 0) {
    database.prepare('UPDATE plugin_artwork_objects SET ref_count = ?, updated_at = ? WHERE content_hash = ?')
      .run(count.count, Date.now(), contentHash);
    return;
  }
  const row = database.prepare('SELECT cache_path FROM plugin_artwork_objects WHERE content_hash = ?')
    .get(contentHash) as { cache_path: string } | undefined;
  database.prepare('DELETE FROM plugin_artwork_objects WHERE content_hash = ?').run(contentHash);
  if (row?.cache_path) {
    try { fs.unlinkSync(row.cache_path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[plugin-artwork] orphan cleanup failed');
    }
  }
}

function removePluginArtworkReference(addonId: string, sourceUrl: string): void {
  const database = getDb();
  const row = database.prepare('SELECT content_hash FROM plugin_artwork_references WHERE addon_id = ? AND source_url = ?')
    .get(addonId, sourceUrl) as { content_hash: string } | undefined;
  if (!row) return;
  database.prepare('DELETE FROM plugin_artwork_references WHERE addon_id = ? AND source_url = ?').run(addonId, sourceUrl);
  removeUnreferencedPluginArtworkObject(row.content_hash);
}

function enforcePluginArtworkQuota(addonId: string, incomingBytes: number, sourceUrl: string): void {
  const database = getDb();
  const usage = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(object.byte_length), 0) AS bytes
    FROM plugin_artwork_references AS reference
    JOIN plugin_artwork_objects AS object ON object.content_hash = reference.content_hash
    WHERE reference.addon_id = ? AND reference.source_url <> ?
  `).get(addonId, sourceUrl) as { count: number; bytes: number };
  if (incomingBytes > PLUGIN_ARTWORK_MAX_BYTES_PER_ADDON) throw new Error('Plugin artwork exceeds the provider quota.');
  const rows = database.prepare(`
    SELECT reference.source_url, object.byte_length
    FROM plugin_artwork_references AS reference
    JOIN plugin_artwork_objects AS object ON object.content_hash = reference.content_hash
    WHERE reference.addon_id = ? AND reference.source_url <> ?
    ORDER BY reference.updated_at ASC
  `).all(addonId, sourceUrl) as Array<{ source_url: string; byte_length: number }>;
  let count = usage.count;
  let bytes = usage.bytes;
  for (const row of rows) {
    if (count + 1 <= PLUGIN_ARTWORK_MAX_ENTRIES_PER_ADDON && bytes + incomingBytes <= PLUGIN_ARTWORK_MAX_BYTES_PER_ADDON) break;
    removePluginArtworkReference(addonId, row.source_url);
    count -= 1;
    bytes -= row.byte_length;
  }
  if (count + 1 > PLUGIN_ARTWORK_MAX_ENTRIES_PER_ADDON || bytes + incomingBytes > PLUGIN_ARTWORK_MAX_BYTES_PER_ADDON) {
    throw new Error('Plugin artwork exceeds the provider quota.');
  }
}

export function getCachedPluginArtwork(addonId: string, sourceUrl: string): CachedArtwork | null {
  const row = pluginArtworkObject(addonId, sourceUrl);
  return row ? {
    cachePath: row.cache_path,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    contentHash: row.content_hash,
  } : null;
}

export async function cachePluginArtworkSource(addonId: string, sourceUrl: string): Promise<CachedArtwork | null> {
  const existing = getCachedPluginArtwork(addonId, sourceUrl);
  if (existing) return existing;
  const pendingKey = `${addonId}\0${sourceUrl}`;
  const pending = pendingPluginArtwork.get(pendingKey);
  if (pending) return pending;
  const request = (async () => {
    const sanitized = await runBoundedArtworkFetch(async () => {
      const response = await safeFetch(sourceUrl, {}, {
        timeoutMs: 20_000,
        maxBytes: 5 * 1024 * 1024,
        retries: 1,
        maxRedirects: 1,
      });
      if (!response.ok) return null;
      const mimeType = response.headers.get('content-type')?.split(';')[0] || '';
      if (!mimeType.startsWith('image/')) return null;
      return sanitizeArtworkBytes(Buffer.from(await response.arrayBuffer()), mimeType, { fallbackDecoder: nativeImage });
    });
    if (!sanitized) return null;
    enforcePluginArtworkQuota(addonId, sanitized.byteLength, sourceUrl);

    const cachePath = path.join(pluginArtworkCacheDirectory(), `${sanitized.contentHash}${artworkExtensionForMimeType(sanitized.mimeType)}`);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    if (!fs.existsSync(cachePath)) {
      try { fs.writeFileSync(cachePath, sanitized.bytes, { flag: 'wx' }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const database = getDb();
    const previous = database.prepare('SELECT content_hash FROM plugin_artwork_references WHERE addon_id = ? AND source_url = ?')
      .get(addonId, sourceUrl) as { content_hash: string } | undefined;
    database.transaction(() => {
      database.prepare(`
        INSERT INTO plugin_artwork_objects (content_hash, cache_path, mime_type, byte_length, ref_count, updated_at)
        VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT(content_hash) DO UPDATE SET updated_at = excluded.updated_at
      `).run(sanitized.contentHash, cachePath, sanitized.mimeType, sanitized.byteLength, Date.now());
      database.prepare(`
        INSERT INTO plugin_artwork_references (addon_id, source_url, content_hash, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(addon_id, source_url) DO UPDATE SET content_hash = excluded.content_hash, updated_at = excluded.updated_at
      `).run(addonId, sourceUrl, sanitized.contentHash, Date.now());
    })();
    // Re-check after insertion as well as before it. Concurrent fetches for
    // different URLs can both pass the initial snapshot; this synchronous
    // reconciliation makes the last insertion evict LRU references until the
    // provider is back within its exact quota.
    enforcePluginArtworkQuota(addonId, sanitized.byteLength, sourceUrl);
    removeUnreferencedPluginArtworkObject(sanitized.contentHash);
    if (previous && previous.content_hash !== sanitized.contentHash) removeUnreferencedPluginArtworkObject(previous.content_hash);
    return getCachedPluginArtwork(addonId, sourceUrl);
  })().catch(() => null).finally(() => pendingPluginArtwork.delete(pendingKey));
  pendingPluginArtwork.set(pendingKey, request);
  return request;
}

export function removePluginArtworkForAddon(addonId: string): number {
  const database = getDb();
  const rows = database.prepare('SELECT source_url, content_hash FROM plugin_artwork_references WHERE addon_id = ?')
    .all(addonId) as Array<{ source_url: string; content_hash: string }>;
  database.prepare('DELETE FROM plugin_artwork_references WHERE addon_id = ?').run(addonId);
  for (const hash of new Set(rows.map((row) => row.content_hash))) removeUnreferencedPluginArtworkObject(hash);
  return rows.length;
}

export async function cacheLibraryArtwork(data: LibraryData | string[]): Promise<void> {
  await getArtworkRepository().cacheLibraryArtwork(data);
}
export async function backupDatabase(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const result = await dialog.showSaveDialog({
    title: 'Back Up LoomTV Database',
    defaultPath: `loomtv-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
    filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };

  const destination = result.filePath;
  const userData = app.getPath('userData');
  if (backupDestinationOverlapsLiveDatabase(destination, [databasePath(), path.join(userData, 'loomtv.sqlite')])) {
    return { ok: false, error: 'Choose a different file. A backup cannot replace a database LoomTV is using.' };
  }

  const database = getDb();
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  const previousPath = `${destination}.${randomUUID()}.previous`;
  let movedExistingBackup = false;

  try {
    fs.closeSync(fs.openSync(temporaryPath, 'wx', 0o600));
    await database.backup(temporaryPath);

    const backup = new BetterSqlite3(temporaryPath, { readonly: true });
    try {
      const check = backup.pragma('quick_check') as Array<{ quick_check?: string }>;
      if (check.length === 0 || check.some((row) => row.quick_check !== 'ok')) {
        throw new Error('The backup failed SQLite integrity verification.');
      }
    } finally {
      backup.close();
    }

    if (fs.existsSync(destination)) {
      fs.renameSync(destination, previousPath);
      movedExistingBackup = true;
    }

    try {
      fs.renameSync(temporaryPath, destination);
    } catch (error) {
      if (movedExistingBackup && !fs.existsSync(destination) && fs.existsSync(previousPath)) {
        fs.renameSync(previousPath, destination);
      }
      throw error;
    }

    if (movedExistingBackup) {
      try {
        fs.rmSync(previousPath, { force: true });
      } catch (error) {
        console.warn('[database] Could not remove the previous backup copy:', error);
      }
    }

    return { ok: true, path: destination };
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    if (movedExistingBackup && !fs.existsSync(destination) && fs.existsSync(previousPath)) {
      try {
        fs.renameSync(previousPath, destination);
      } catch {
        // Keep the previous copy in place if restoration cannot be completed.
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function clearDatabase(): ProfileRecord {
  const database = getDb();
  const ownerId = randomUUID();
  const now = Date.now();
  database.transaction(() => {
    database.exec(`
    DELETE FROM music_roots;
    DELETE FROM audiobooks_roots;
    DELETE FROM books_roots;
    DELETE FROM comics_roots;
    DELETE FROM photo_items;
    DELETE FROM photo_directories;
    DELETE FROM photo_roots;
    DELETE FROM segment_manual_history;
    DELETE FROM media_segments;
    DELETE FROM media_segment_candidates;
    DELETE FROM segment_source_cache;
    DELETE FROM media_fingerprints;
    DELETE FROM media_auxiliary_fingerprints;
    DELETE FROM segment_analysis_inventory;
    DELETE FROM segment_analysis_jobs;
    DELETE FROM segment_analysis_state;
    DELETE FROM media_metadata_refresh_state;
    DELETE FROM artwork_cache;
    DELETE FROM thumbnail_cache;
    DELETE FROM custom_artwork;
    DELETE FROM plugin_artwork_references;
    DELETE FROM plugin_artwork_objects;
    DELETE FROM playback_progress;
    DELETE FROM playback_track_preferences;
    DELETE FROM profile_stremio_access;
    DELETE FROM profile_media_lists;
    DELETE FROM profile_library_access;
    DELETE FROM profile_restrictions;
    DELETE FROM profile_preferences;
    DELETE FROM device_profile_selections;
    DELETE FROM device_profile_selection_revisions;
    DELETE FROM profiles;
    DELETE FROM stremio_plugin_state_metadata;
    DELETE FROM stremio_addons;
    DELETE FROM plugin_secrets;
    DELETE FROM plugin_secret_revisions;
    DELETE FROM plugin_secret_store_keys;
    DELETE FROM stremio_plugin_audit;
    DELETE FROM episode_files;
    DELETE FROM episodes;
    DELETE FROM seasons;
    DELETE FROM media_items;
    DELETE FROM library_folders;
    DELETE FROM scan_cache;
    DELETE FROM iptv_recent;
    DELETE FROM iptv_favorites;
    DELETE FROM iptv_programmes;
    DELETE FROM iptv_channels;
    DELETE FROM iptv_stream_health;
    DELETE FROM iptv_sources;
    DELETE FROM app_settings;
    INSERT OR IGNORE INTO plugin_secret_revisions (id, revision) VALUES (1, 0);
    `);
    // Native views retain removed video identities during normal scans. A reset
    // removes their canonical records and revokes capabilities issued before it.
    canonicalVideoConnection(database).exec(`
      DELETE FROM offline_download_leases;
      DELETE FROM invitation_sessions;
      DELETE FROM invitations;
      DELETE FROM account_sessions;
      DELETE FROM device_credentials;
      DELETE FROM pairing_requests;
      UPDATE devices SET disabled=1,revoked_at=${now},revoked_reason='app_data_reset',updated_at=${now};
      UPDATE accounts SET root_ids_json='[]',updated_at=${now} WHERE account_type!='owner';
      DELETE FROM profile_selections;
      DELETE FROM native_selection_revisions;
      DELETE FROM watch_history;
      DELETE FROM catalog_items;
      DELETE FROM library_roots;
      DELETE FROM scan_state;
      DELETE FROM backup_state;
      DELETE FROM meta WHERE key='native_owner_profile';
    `);
    database.prepare(`
      INSERT INTO profiles (id, name, avatar_key, color_key, profile_type, created_at, updated_at, sort_order)
      VALUES (?, 'Owner', 'glyph-01', 'ember', 'owner', ?, ?, 0)
    `).run(ownerId, now, now);
  }).immediate();
  // The cached signer holds the MAC key that was just deleted. Drop it so the
  // next plugin write creates and persists a fresh key.
  pluginSecretStore = null;

  thumbnailRepository?.clear();
  for (const cacheDirectory of [artworkCacheDirectory(), pluginArtworkCacheDirectory(), thumbnailCacheDirectory()]) {
    try {
      fs.rmSync(cacheDirectory, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[database] Could not clear cache directory ${cacheDirectory}:`, error);
    }
  }

  database.pragma('wal_checkpoint(TRUNCATE)');
  database.exec('VACUUM;');
  const owner = getProfile(ownerId);
  if (!owner) throw new Error('The clean Owner profile could not be created.');
  return owner;
}

export function saveLibraryScanDeltaToDatabase(
  changed: Parameters<typeof saveLibraryScanDeltaRecord>[1], removed: Parameters<typeof saveLibraryScanDeltaRecord>[2],
  cache: Parameters<typeof saveLibraryScanDeltaRecord>[3], aliases?: Parameters<typeof saveLibraryScanDeltaRecord>[4],
  removedFiles?: Parameters<typeof saveLibraryScanDeltaRecord>[5], statuses: readonly LibraryFolderStatus[] = [],
): number {
  const database = getDb();
  return database.transaction(() => {
    const result = saveLibraryScanDeltaRecord(database, changed, removed, cache, aliases, removedFiles);
    const raw = canonicalVideoConnection(database);
    for (const status of statuses) {
      const root = raw.prepare("SELECT id FROM library_roots WHERE locator=? AND state!='removed'").get(status.path) as { id: string } | undefined;
      if (!root) continue;
      const online = status.state === 'available';
      raw.prepare('UPDATE library_roots SET state=? WHERE id=?').run(online ? 'available' : 'offline', root.id);
      raw.prepare('UPDATE media_sources SET state=? WHERE root_id=? AND state=?').run(online ? 'online' : 'offline', root.id, online ? 'offline' : 'online');
    }
    return result;
  }).immediate();
}
