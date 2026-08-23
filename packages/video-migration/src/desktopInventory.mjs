/**
 * Read-only inventory of a legacy desktop database.
 *
 * The desktop app owns `<userData>/loomtv.sqlite` through better-sqlite3. The bridge
 * opens the same file through `node:sqlite` in read-only mode with `query_only` set, so
 * a migration can never write to, upgrade, or checkpoint the state it is migrating.
 * The desktop app must be stopped first; a live WAL is not a supported source.
 *
 * Every table and column is probed before it is read, because installations that never
 * reached the newest desktop schema still have to migrate.
 */

import fsSync from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrationError } from './errors.mjs';
import { opaqueFingerprint } from './redaction.mjs';

export const DESKTOP_DATABASE_FILENAME = 'loomtv.sqlite';

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columnsOf(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => row.name));
}

/**
 * Selects the requested columns that actually exist. A caller gets `undefined` for a
 * column an older schema never had, which every mapper below treats as absent rather
 * than as a zero value.
 */
function readRows(database, table, wanted) {
  if (!tableExists(database, table)) return null;
  const present = columnsOf(database, table);
  const selected = wanted.filter((column) => present.has(column));
  if (!selected.length) return [];
  const projection = selected.map((column) => JSON.stringify(column)).join(',');
  return database.prepare(`SELECT ${projection} FROM ${JSON.stringify(table)}`).all();
}

/**
 * Strict JSON column read.
 *
 * An absent or empty column is a legitimately absent value and takes the fallback. A
 * column that holds text which is not JSON, or JSON of the wrong shape, is corruption:
 * normalizing it to an empty object would silently discard a profile's preferences,
 * restrictions, or provider identifiers without telling the operator anything. Migration
 * stops instead, and the error names the table, the column, and an opaque row reference.
 */
function parseJson(value, fallback, context) {
  const { recordId, ...safeContext } = context;
  const details = recordId
    ? { ...safeContext, recordReference: opaqueFingerprint(recordId) }
    : safeContext;
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') {
    throw migrationError('desktop_state_malformed', 'A desktop JSON column does not hold text.', details);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw migrationError('desktop_state_malformed', 'A desktop JSON column could not be parsed.', {
      ...details,
      byteLength: Buffer.byteLength(value),
    });
  }
  if (parsed === null || parsed === undefined) return fallback;
  const expectedArray = Array.isArray(fallback);
  if (expectedArray !== Array.isArray(parsed) || typeof parsed !== 'object') {
    throw migrationError('desktop_state_malformed', 'A desktop JSON column holds a value of the wrong shape.', {
      ...details,
      expected: expectedArray ? 'array' : 'object',
    });
  }
  return parsed;
}

const asNumber = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const asText = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
const asBoolean = (value) => value === 1 || value === true;

/**
 * @param {object} input
 * @param {string} input.databasePath absolute path to the desktop `loomtv.sqlite`
 * @returns {object} raw inventory. Nothing here is redacted: PIN and token hashes are
 *   present because the canonical import carries them. Callers must never serialize
 *   this object into a report or a log.
 */
export function readDesktopInventory({ databasePath, settingsPath = null }) {
  if (!fsSync.existsSync(databasePath)) {
    throw migrationError('desktop_database_missing', 'The desktop database was not found at the supplied path.');
  }
  let externalSettings = {};
  if (settingsPath && fsSync.existsSync(settingsPath)) {
    try {
      externalSettings = JSON.parse(fsSync.readFileSync(settingsPath, 'utf8'));
      if (!externalSettings || typeof externalSettings !== 'object' || Array.isArray(externalSettings)) throw new Error('shape');
    } catch {
      throw migrationError('desktop_state_malformed', 'The desktop settings document could not be parsed.', {
        table: 'desktop_settings', column: 'document', recordReference: opaqueFingerprint('settings-singleton'),
      });
    }
  }
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA query_only=ON');
  } catch (error) {
    throw migrationError('desktop_database_unreadable', 'The desktop database could not be opened read-only.', {
      cause: error?.code || error?.message || 'unknown',
    });
  }

  try {
    if (!tableExists(database, 'media_items') && !tableExists(database, 'library_folders')) {
      throw migrationError('desktop_schema_unsupported', 'The desktop database has no library tables to migrate.');
    }

    const settingsRow = tableExists(database, 'app_settings')
      ? database.prepare('SELECT data_json FROM app_settings WHERE id = 1').get()
      : null;
    const databaseSettings = parseJson(settingsRow?.data_json, {}, { table: 'app_settings', column: 'data_json' });
    const settings = { ...externalSettings, ...databaseSettings };
    const externalDevices = Array.isArray(externalSettings.localNetworkPairedDevices) ? externalSettings.localNetworkPairedDevices : [];
    const databaseDevices = Array.isArray(databaseSettings.localNetworkPairedDevices) ? databaseSettings.localNetworkPairedDevices : [];
    if (externalDevices.length || databaseDevices.length) {
      settings.localNetworkPairedDevices = [...new Map([...externalDevices, ...databaseDevices]
        .filter((entry) => entry && typeof entry.id === 'string' && entry.id)
        .map((entry) => [entry.id, entry])).values()];
    }

    const folders = (readRows(database, 'library_folders', ['path', 'kind', 'added_at']) || []).map((row) => ({
      path: asText(row.path),
      kind: asText(row.kind, 'others'),
      addedAt: asNumber(row.added_at, 1),
    })).filter((folder) => folder.path);

    const mediaItems = (readRows(database, 'media_items', [
      'id', 'type', 'format', 'title', 'year', 'poster', 'backdrop', 'logo', 'summary', 'rating',
      'content_rating', 'content_ratings_json', 'runtime', 'season_count', 'episode_count',
      'provider_ratings_json', 'file_path', 'file_size', 'last_played', 'genres_json',
      'provider_ids_json', 'local_metadata_json', 'updated_at',
    ]) || []).map((row) => ({
      id: asText(row.id),
      type: asText(row.type, 'movie'),
      format: asText(row.format),
      title: asText(row.title),
      year: asNumber(row.year, 0),
      artwork: { poster: asText(row.poster), backdrop: asText(row.backdrop), logo: asText(row.logo) },
      summary: asText(row.summary),
      rating: asNumber(row.rating, 0),
      contentRating: asText(row.content_rating),
      contentRatings: parseJson(row.content_ratings_json, {}, { table: 'media_items', column: 'content_ratings_json', recordId: asText(row.id) }),
      runtime: asText(row.runtime),
      seasonCount: row.season_count === null || row.season_count === undefined ? null : asNumber(row.season_count),
      episodeCount: row.episode_count === null || row.episode_count === undefined ? null : asNumber(row.episode_count),
      providerRatings: parseJson(row.provider_ratings_json, {}, { table: 'media_items', column: 'provider_ratings_json', recordId: asText(row.id) }),
      providerIds: parseJson(row.provider_ids_json, {}, { table: 'media_items', column: 'provider_ids_json', recordId: asText(row.id) }),
      genres: parseJson(row.genres_json, [], { table: 'media_items', column: 'genres_json', recordId: asText(row.id) }),
      localMetadata: parseJson(row.local_metadata_json, null, { table: 'media_items', column: 'local_metadata_json', recordId: asText(row.id) }),
      filePath: asText(row.file_path),
      sizeBytes: row.file_size === null || row.file_size === undefined ? null : asNumber(row.file_size),
      lastPlayedAt: row.last_played === null || row.last_played === undefined ? null : asNumber(row.last_played),
      updatedAt: asNumber(row.updated_at, 1),
    })).filter((item) => item.id);

    const episodeFiles = (readRows(database, 'episode_files', [
      'media_id', 'season', 'episode', 'file_path', 'title', 'thumbnail', 'still', 'local_metadata_json',
    ]) || []).map((row) => ({
      seriesId: asText(row.media_id),
      season: asNumber(row.season, 1),
      episode: asNumber(row.episode, 0),
      filePath: asText(row.file_path),
      title: asText(row.title),
      artwork: { thumbnail: asText(row.thumbnail), still: asText(row.still) },
      localMetadata: parseJson(row.local_metadata_json, null, { table: 'episode_files', column: 'local_metadata_json', recordId: asText(row.media_id) }),
    })).filter((file) => file.seriesId && file.filePath);

    const seasons = (readRows(database, 'seasons', ['media_id', 'number', 'title', 'episode_count']) || []).map((row) => ({
      seriesId: asText(row.media_id),
      season: asNumber(row.number, 1),
      title: asText(row.title),
      episodeCount: asNumber(row.episode_count, 0),
    })).filter((entry) => entry.seriesId);

    const episodes = (readRows(database, 'episodes', [
      'media_id', 'season', 'number', 'title', 'summary', 'still', 'rating', 'air_date',
    ]) || []).map((row) => ({
      seriesId: asText(row.media_id),
      season: asNumber(row.season, 1),
      episode: asNumber(row.number, 0),
      title: asText(row.title),
      summary: asText(row.summary),
      artwork: { still: asText(row.still) },
      rating: asNumber(row.rating, 0),
      airDate: asText(row.air_date),
    }));

    const profiles = (readRows(database, 'profiles', [
      'id', 'name', 'avatar_key', 'color_key', 'profile_type', 'pin_hash', 'pin_salt',
      'created_at', 'updated_at', 'last_used_at', 'sort_order', 'is_guest', 'guest_device_id',
    ]) || []).map((row) => ({
      id: asText(row.id),
      name: asText(row.name, 'Viewer'),
      avatarKey: asText(row.avatar_key, 'glyph-01'),
      colorKey: asText(row.color_key, 'ember'),
      profileType: asText(row.profile_type, 'standard'),
      pinHash: asText(row.pin_hash) || null,
      pinSalt: asText(row.pin_salt) || null,
      createdAt: asNumber(row.created_at, 1),
      updatedAt: asNumber(row.updated_at, 1),
      lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : asNumber(row.last_used_at),
      sortOrder: asNumber(row.sort_order, 0),
      isGuest: asBoolean(row.is_guest),
      guestDeviceId: asText(row.guest_device_id) || null,
    })).filter((profile) => profile.id);

    const preferences = (readRows(database, 'profile_preferences', [
      'profile_id', 'preferences_json', 'revision', 'updated_at',
    ]) || []).map((row) => ({
      profileId: asText(row.profile_id),
      preferences: parseJson(row.preferences_json, {}, { table: 'profile_preferences', column: 'preferences_json', recordId: asText(row.profile_id) }),
      revision: asNumber(row.revision, 0),
      updatedAt: asNumber(row.updated_at, 1),
    })).filter((entry) => entry.profileId);

    const restrictions = (readRows(database, 'profile_restrictions', [
      'profile_id', 'country', 'maximum_age', 'allow_unrated', 'revision', 'updated_at',
    ]) || []).map((row) => ({
      profileId: asText(row.profile_id),
      country: asText(row.country, 'US'),
      maximumAge: row.maximum_age === null || row.maximum_age === undefined ? null : asNumber(row.maximum_age),
      allowUnrated: asBoolean(row.allow_unrated),
      revision: asNumber(row.revision, 0),
      updatedAt: asNumber(row.updated_at, 1),
    })).filter((entry) => entry.profileId);

    const libraryAccess = (readRows(database, 'profile_library_access', ['profile_id', 'folder_path']) || [])
      .map((row) => ({ profileId: asText(row.profile_id), folderPath: asText(row.folder_path) }))
      .filter((entry) => entry.profileId && entry.folderPath);

    const mediaLists = (readRows(database, 'profile_media_lists', [
      'profile_id', 'media_id', 'list_kind', 'created_at',
    ]) || []).map((row) => ({
      profileId: asText(row.profile_id),
      mediaId: asText(row.media_id),
      kind: asText(row.list_kind, 'watchlist'),
      createdAt: asNumber(row.created_at, 1),
    })).filter((entry) => entry.profileId && entry.mediaId);

    const progress = (readRows(database, 'playback_progress', [
      'profile_id', 'file_path', 'position', 'duration', 'updated_at', 'watched',
    ]) || []).map((row) => ({
      profileId: asText(row.profile_id),
      filePath: asText(row.file_path),
      positionSeconds: Math.max(0, asNumber(row.position, 0)),
      durationSeconds: Math.max(0, asNumber(row.duration, 0)),
      watched: asBoolean(row.watched),
      updatedAt: asNumber(row.updated_at, 1),
    })).filter((entry) => entry.filePath);

    const trackPreferences = (readRows(database, 'playback_track_preferences', [
      'profile_id', 'scope', 'preferences_json', 'updated_at',
    ]) || []).map((row) => ({
      profileId: asText(row.profile_id),
      scope: asText(row.scope),
      preferences: parseJson(row.preferences_json, {}, { table: 'playback_track_preferences', column: 'preferences_json', recordId: asText(row.profile_id) }),
      updatedAt: asNumber(row.updated_at, 1),
    })).filter((entry) => entry.scope);

    // A later desktop schema moved the selection revision into its own table. Read both and
    // keep the higher value, so a stale-selection check on the canonical side cannot accept
    // a revision the desktop app had already superseded.
    const selectionRevisions = new Map((readRows(database, 'device_profile_selection_revisions', ['device_id', 'revision']) || [])
      .map((row) => [asText(row.device_id), asNumber(row.revision, 0)]));
    const selections = (readRows(database, 'device_profile_selections', [
      'device_id', 'profile_id', 'selected_at', 'automatic_sign_in', 'selection_revision',
    ]) || []).map((row) => ({
      deviceId: asText(row.device_id),
      profileId: asText(row.profile_id) || null,
      selectedAt: asNumber(row.selected_at, 1),
      automaticSignIn: asBoolean(row.automatic_sign_in),
      revision: Math.max(asNumber(row.selection_revision, 0), selectionRevisions.get(asText(row.device_id)) ?? 0),
    })).filter((entry) => entry.deviceId);

    const customArtwork = (readRows(database, 'custom_artwork', ['media_id', 'target', 'data_url', 'updated_at']) || [])
      .map((row) => ({
        mediaId: asText(row.media_id),
        target: asText(row.target),
        dataUrl: asText(row.data_url),
        updatedAt: asNumber(row.updated_at, 1),
      }))
      .filter((entry) => entry.mediaId && entry.dataUrl);

    const stremioAddons = tableExists(database, 'stremio_addons')
      ? asNumber(database.prepare('SELECT COUNT(*) AS count FROM stremio_addons').get()?.count, 0)
      : 0;
    const pluginSecrets = tableExists(database, 'plugin_secrets')
      ? asNumber(database.prepare('SELECT COUNT(*) AS count FROM plugin_secrets').get()?.count, 0)
      : 0;
    const skipSegments = tableExists(database, 'media_segments')
      ? asNumber(database.prepare('SELECT COUNT(*) AS count FROM media_segments').get()?.count, 0)
      : 0;

    return {
      databasePath,
      settings,
      folders,
      mediaItems,
      seasons,
      episodes,
      episodeFiles,
      profiles,
      preferences,
      restrictions,
      libraryAccess,
      mediaLists,
      progress,
      trackPreferences,
      selections,
      customArtwork,
      /** Desktop-only state with no canonical destination in the video scope. */
      outOfScope: { stremioAddons, pluginSecrets, skipSegments },
    };
  } finally {
    database.close();
  }
}
