import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  LanProfileListEntry,
  LanProfileListKind,
  LanProfilePreferences,
  LanProfileRestrictions,
  LanProfileType,
} from '../../../../packages/lan-protocol/src/index.ts';

export type ProfileType = LanProfileType;
export type ProfilePreferences = LanProfilePreferences;
export type ProfileRestrictions = LanProfileRestrictions;
export type ProfileListEntry = LanProfileListEntry;
export type ProfileListKind = LanProfileListKind;

export type ProfileRecord = {
  id: string;
  name: string;
  avatarKey: string;
  colorKey: string;
  type: ProfileType;
  hasPin: boolean;
  isGuest: boolean;
  guestDeviceId?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  sortOrder: number;
};

export type ProfileCreateInput = {
  name: string;
  avatarKey?: string;
  colorKey?: string;
  type?: 'standard' | 'kid';
};

export type ProfileUpdateInput = Partial<ProfileCreateInput>;

type ProfileRow = {
  id: string;
  name: string;
  avatar_key: string;
  color_key: string;
  profile_type: Exclude<ProfileType, 'guest'>;
  pin_hash: string | null;
  pin_salt: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  sort_order: number;
  is_guest: number;
  guest_device_id: string | null;
};

export type DeviceProfileSelection = {
  profileId: string;
  automaticSignIn: boolean;
  selectionRevision: number;
};

export const DEFAULT_AVATAR_KEY = 'weave-01';
export const DEFAULT_COLOR_KEY = 'ember';

const MAX_PROFILES = 10;
const MAX_NAME_LENGTH = 30;

function rowToRecord(row: ProfileRow): ProfileRecord {
  const isGuest = Boolean(row.is_guest);
  return {
    id: row.id,
    name: row.name,
    avatarKey: row.avatar_key,
    colorKey: row.color_key,
    type: isGuest ? 'guest' : row.profile_type,
    hasPin: Boolean(row.pin_hash),
    isGuest,
    ...(row.guest_device_id ? { guestDeviceId: row.guest_device_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    sortOrder: row.sort_order,
  };
}

function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function safeProfileName(name: unknown): string {
  return String(name ?? '').trim().slice(0, MAX_NAME_LENGTH);
}

function safeKey(value: unknown, fallback: string): string {
  const key = String(value ?? '').trim().slice(0, 40);
  return /^[a-z0-9-]+$/.test(key) ? key : fallback;
}

export function listProfiles(database: BetterSqlite3.Database, guestDeviceId?: string): ProfileRecord[] {
  const rows = guestDeviceId
    ? database.prepare('SELECT * FROM profiles WHERE is_guest = 0 OR guest_device_id = ? ORDER BY sort_order, created_at').all(guestDeviceId) as ProfileRow[]
    : database.prepare('SELECT * FROM profiles WHERE is_guest = 0 ORDER BY sort_order, created_at').all() as ProfileRow[];
  return rows.map(rowToRecord);
}

export function getProfile(database: BetterSqlite3.Database, profileId: string): ProfileRecord | null {
  const row = database.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as ProfileRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function getOwnerProfile(database: BetterSqlite3.Database): ProfileRecord | null {
  const row = database.prepare("SELECT * FROM profiles WHERE profile_type = 'owner'").get() as ProfileRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function createProfile(database: BetterSqlite3.Database, input: ProfileCreateInput): ProfileRecord {
  const name = safeProfileName(input.name);
  if (!name) throw new Error('A profile name is required.');
  const count = (database.prepare('SELECT COUNT(*) AS n FROM profiles WHERE is_guest = 0').get() as { n: number }).n;
  if (count >= MAX_PROFILES) throw new Error(`LoomTV supports up to ${MAX_PROFILES} profiles.`);
  const now = Date.now();
  const maxOrder = (database.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM profiles').get() as { m: number }).m;
  const id = randomUUID();
  database.prepare(`
    INSERT INTO profiles (id, name, avatar_key, color_key, profile_type, created_at, updated_at, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    safeKey(input.avatarKey, DEFAULT_AVATAR_KEY),
    safeKey(input.colorKey, DEFAULT_COLOR_KEY),
    input.type === 'kid' ? 'kid' : 'standard',
    now,
    now,
    maxOrder + 1,
  );
  const created = getProfile(database, id);
  if (!created) throw new Error('The profile could not be created.');
  return created;
}

export function updateProfile(database: BetterSqlite3.Database, profileId: string, patch: ProfileUpdateInput): ProfileRecord {
  const existing = getProfile(database, profileId);
  if (!existing) throw new Error('That profile no longer exists.');
  if (existing.isGuest) throw new Error('Guest profiles cannot be edited.');
  const name = patch.name === undefined ? existing.name : safeProfileName(patch.name);
  if (!name) throw new Error('A profile name is required.');
  // The Owner keeps its type; Standard and Kids may convert between each other.
  const editableType: Exclude<ProfileType, 'guest'> = existing.type === 'guest' ? 'standard' : existing.type;
  const nextType: Exclude<ProfileType, 'guest'> = editableType === 'owner'
    ? 'owner'
    : patch.type === 'kid' ? 'kid' : patch.type === 'standard' ? 'standard' : editableType;
  database.prepare(`
    UPDATE profiles SET name = ?, avatar_key = ?, color_key = ?, profile_type = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name,
    patch.avatarKey === undefined ? existing.avatarKey : safeKey(patch.avatarKey, existing.avatarKey),
    patch.colorKey === undefined ? existing.colorKey : safeKey(patch.colorKey, existing.colorKey),
    nextType,
    Date.now(),
    profileId,
  );
  const updated = getProfile(database, profileId);
  if (!updated) throw new Error('That profile no longer exists.');
  return updated;
}

export function deleteProfile(database: BetterSqlite3.Database, profileId: string): void {
  const existing = getProfile(database, profileId);
  if (!existing) return;
  if (existing.type === 'owner') throw new Error('The Owner profile cannot be deleted.');
  const count = (database.prepare('SELECT COUNT(*) AS n FROM profiles WHERE is_guest = 0').get() as { n: number }).n;
  if (count <= 1) throw new Error('The last remaining profile cannot be deleted.');
  // playback_progress, playback_track_preferences, and device_profile_selections
  // rows cascade via their profile_id foreign keys.
  database.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
}

export function getDeviceProfileSelection(database: BetterSqlite3.Database, deviceId: string): string | null {
  return getDeviceProfileSelectionState(database, deviceId)?.profileId ?? null;
}

export function getDeviceProfileSelectionState(database: BetterSqlite3.Database, deviceId: string): DeviceProfileSelection | null {
  const row = database.prepare(`
    SELECT profile_id, automatic_sign_in, selection_revision
    FROM device_profile_selections WHERE device_id = ?
  `).get(deviceId) as { profile_id: string; automatic_sign_in: number; selection_revision: number } | undefined;
  return row ? {
    profileId: row.profile_id,
    automaticSignIn: Boolean(row.automatic_sign_in),
    selectionRevision: row.selection_revision,
  } : null;
}

export function selectDeviceProfile(database: BetterSqlite3.Database, deviceId: string, profileId: string): ProfileRecord {
  const profile = getProfile(database, profileId);
  if (!profile) throw new Error('That profile no longer exists.');
  const now = Date.now();
  const safeDeviceId = String(deviceId).slice(0, 128);
  database.prepare(`
    INSERT INTO device_profile_selections (device_id, profile_id, selected_at, automatic_sign_in, selection_revision)
    VALUES (?, ?, ?, 0, 1)
    ON CONFLICT(device_id) DO UPDATE SET
      profile_id = excluded.profile_id,
      selected_at = excluded.selected_at,
      automatic_sign_in = CASE WHEN device_profile_selections.profile_id = excluded.profile_id THEN device_profile_selections.automatic_sign_in ELSE 0 END,
      selection_revision = device_profile_selections.selection_revision + 1
  `).run(safeDeviceId, profileId, now);
  database.prepare('UPDATE profiles SET last_used_at = ? WHERE id = ?').run(now, profileId);
  return profile;
}

export function createGuestProfile(database: BetterSqlite3.Database, deviceId: string): ProfileRecord {
  const safeDeviceId = String(deviceId).trim().slice(0, 128);
  if (!safeDeviceId) throw new Error('A device is required for Guest.');
  const create = database.transaction(() => {
    database.prepare('DELETE FROM profiles WHERE is_guest = 1 AND guest_device_id = ?').run(safeDeviceId);
    const now = Date.now();
    const id = randomUUID();
    database.prepare(`
      INSERT INTO profiles (
        id, name, avatar_key, color_key, profile_type, created_at, updated_at,
        sort_order, is_guest, guest_device_id
      ) VALUES (?, 'Guest', 'weave-08', 'slate', 'standard', ?, ?, 9999, 1, ?)
    `).run(id, now, now, safeDeviceId);
    selectDeviceProfile(database, safeDeviceId, id);
    return getProfile(database, id);
  });
  const profile = create();
  if (!profile) throw new Error('The Guest profile could not be created.');
  return profile;
}

export function clearDeviceProfileSelection(database: BetterSqlite3.Database, deviceId: string): void {
  const selection = getDeviceProfileSelectionState(database, deviceId);
  if (selection) {
    const profile = getProfile(database, selection.profileId);
    database.prepare('DELETE FROM device_profile_selections WHERE device_id = ?').run(deviceId);
    if (profile?.isGuest) database.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id);
  }
}

export function setDeviceAutomaticSignIn(database: BetterSqlite3.Database, deviceId: string, enabled: boolean): DeviceProfileSelection {
  const selection = getDeviceProfileSelectionState(database, deviceId);
  if (!selection) throw new Error('Select a profile before enabling automatic sign-in.');
  const profile = getProfile(database, selection.profileId);
  if (!profile || profile.isGuest || profile.hasPin) {
    throw new Error('Automatic sign-in requires an unprotected permanent profile.');
  }
  database.prepare('UPDATE device_profile_selections SET automatic_sign_in = ? WHERE device_id = ?')
    .run(enabled ? 1 : 0, deviceId);
  return { ...selection, automaticSignIn: enabled };
}

export function reorderProfiles(database: BetterSqlite3.Database, profileIds: readonly string[]): ProfileRecord[] {
  const permanent = listProfiles(database);
  const validIds = new Set(permanent.map((profile) => profile.id));
  const orderedIds = [...new Set(profileIds)].filter((id) => validIds.has(id));
  for (const profile of permanent) if (!orderedIds.includes(profile.id)) orderedIds.push(profile.id);
  const update = database.prepare('UPDATE profiles SET sort_order = ?, updated_at = ? WHERE id = ? AND is_guest = 0');
  database.transaction(() => orderedIds.forEach((id, index) => update.run(index, Date.now(), id)))();
  return listProfiles(database);
}

export function getProfilePinCredentials(
  database: BetterSqlite3.Database,
  profileId: string,
): { hash: string; salt: string } | null {
  const row = database.prepare('SELECT pin_hash, pin_salt FROM profiles WHERE id = ?').get(profileId) as {
    pin_hash: string | null;
    pin_salt: string | null;
  } | undefined;
  return row?.pin_hash && row.pin_salt ? { hash: row.pin_hash, salt: row.pin_salt } : null;
}

export function setProfilePinCredentials(
  database: BetterSqlite3.Database,
  profileId: string,
  credentials: { hash: string; salt: string } | null,
): ProfileRecord {
  const profile = getProfile(database, profileId);
  if (!profile) throw new Error('That profile no longer exists.');
  if (profile.isGuest) throw new Error('Guest profiles cannot use a PIN.');
  database.prepare(`
    UPDATE profiles SET pin_hash = ?, pin_salt = ?, updated_at = ? WHERE id = ?
  `).run(credentials?.hash ?? null, credentials?.salt ?? null, Date.now(), profileId);
  if (credentials) {
    database.prepare('UPDATE device_profile_selections SET automatic_sign_in = 0 WHERE profile_id = ?').run(profileId);
  }
  const updated = getProfile(database, profileId);
  if (!updated) throw new Error('That profile no longer exists.');
  return updated;
}

function normalizePreferences(value: ProfilePreferences): ProfilePreferences {
  const themeModes = new Set(['dark', 'light']);
  const colors = new Set(['orange', 'yellow', 'red', 'blue', 'twitch']);
  const loaders = new Set(['play-mark', 'logo-mark', 'horizontal-logo']);
  const seconds = (candidate: unknown): number | undefined => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? Math.min(120, Math.max(1, Math.round(parsed))) : undefined;
  };
  return {
    ...(themeModes.has(String(value.appThemeMode)) ? { appThemeMode: value.appThemeMode } : {}),
    ...(colors.has(String(value.appThemeColor)) ? { appThemeColor: value.appThemeColor } : {}),
    ...(value.appDarkTheme === 'black' ? { appDarkTheme: 'black' as const } : {}),
    ...(loaders.has(String(value.appLoaderStyle)) ? { appLoaderStyle: value.appLoaderStyle } : {}),
    ...(Array.isArray(value.sidebarNavOrder) ? {
      sidebarNavOrder: [...new Set(value.sidebarNavOrder.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 32),
    } : {}),
    ...(typeof value.autoplayNextEnabled === 'boolean' ? { autoplayNextEnabled: value.autoplayNextEnabled } : {}),
    ...(seconds(value.playbackSkipBackSeconds) !== undefined ? { playbackSkipBackSeconds: seconds(value.playbackSkipBackSeconds) } : {}),
    ...(seconds(value.playbackSkipForwardSeconds) !== undefined ? { playbackSkipForwardSeconds: seconds(value.playbackSkipForwardSeconds) } : {}),
  };
}

export function getProfilePreferences(database: BetterSqlite3.Database, profileId: string): ProfilePreferences {
  const row = database.prepare('SELECT preferences_json FROM profile_preferences WHERE profile_id = ?').get(profileId) as {
    preferences_json: string;
  } | undefined;
  return normalizePreferences(jsonParse(row?.preferences_json, {}));
}

export function saveProfilePreferences(
  database: BetterSqlite3.Database,
  profileId: string,
  patch: ProfilePreferences,
): ProfilePreferences {
  if (!getProfile(database, profileId)) throw new Error('That profile no longer exists.');
  const preferences = normalizePreferences({ ...getProfilePreferences(database, profileId), ...patch });
  const now = Date.now();
  database.prepare(`
    INSERT INTO profile_preferences (profile_id, preferences_json, revision, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      preferences_json = excluded.preferences_json,
      revision = profile_preferences.revision + 1,
      updated_at = excluded.updated_at
  `).run(profileId, JSON.stringify(preferences), now);
  return preferences;
}

const RESTRICTION_COUNTRIES = new Set<ProfileRestrictions['country']>(['US', 'GB', 'CA', 'AU']);

export function getProfileRestrictions(database: BetterSqlite3.Database, profileId: string): ProfileRestrictions {
  const row = database.prepare(`
    SELECT country, maximum_age, allow_unrated, revision
    FROM profile_restrictions WHERE profile_id = ?
  `).get(profileId) as {
    country: ProfileRestrictions['country'];
    maximum_age: number | null;
    allow_unrated: number;
    revision: number;
  } | undefined;
  const folders = database.prepare('SELECT folder_path FROM profile_library_access WHERE profile_id = ? ORDER BY folder_path')
    .all(profileId) as { folder_path: string }[];
  return {
    country: row?.country ?? 'US',
    maximumAge: row?.maximum_age ?? null,
    allowUnrated: Boolean(row?.allow_unrated),
    allowedFolders: folders.map((folder) => folder.folder_path),
    revision: row?.revision ?? 0,
  };
}

export function saveProfileRestrictions(
  database: BetterSqlite3.Database,
  profileId: string,
  input: Omit<ProfileRestrictions, 'revision'>,
): ProfileRestrictions {
  const profile = getProfile(database, profileId);
  if (!profile) throw new Error('That profile no longer exists.');
  const country = RESTRICTION_COUNTRIES.has(input.country) ? input.country : 'US';
  const maximumAge = input.maximumAge === null ? null : Math.min(18, Math.max(0, Math.round(Number(input.maximumAge))));
  if (profile.type === 'kid' && maximumAge === null) throw new Error('Choose a maximum age for a Kids profile.');
  const folders = [...new Set(input.allowedFolders.map(String).map((folder) => folder.trim()).filter(Boolean))];
  const now = Date.now();
  database.transaction(() => {
    database.prepare(`
      INSERT INTO profile_restrictions (profile_id, country, maximum_age, allow_unrated, revision, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        country = excluded.country,
        maximum_age = excluded.maximum_age,
        allow_unrated = excluded.allow_unrated,
        revision = profile_restrictions.revision + 1,
        updated_at = excluded.updated_at
    `).run(profileId, country, maximumAge, input.allowUnrated ? 1 : 0, now);
    database.prepare('DELETE FROM profile_library_access WHERE profile_id = ?').run(profileId);
    const insertFolder = database.prepare('INSERT INTO profile_library_access (profile_id, folder_path) VALUES (?, ?)');
    folders.forEach((folder) => insertFolder.run(profileId, folder));
  })();
  return getProfileRestrictions(database, profileId);
}

export function getProfileLists(
  database: BetterSqlite3.Database,
  profileId: string,
  kind?: ProfileListKind,
): ProfileListEntry[] {
  const rows = (kind
    ? database.prepare('SELECT media_id, list_kind, created_at FROM profile_media_lists WHERE profile_id = ? AND list_kind = ? ORDER BY created_at DESC').all(profileId, kind)
    : database.prepare('SELECT media_id, list_kind, created_at FROM profile_media_lists WHERE profile_id = ? ORDER BY created_at DESC').all(profileId)) as Array<{
      media_id: string;
      list_kind: ProfileListKind;
      created_at: number;
    }>;
  return rows.map((row) => ({ mediaId: row.media_id, kind: row.list_kind, createdAt: row.created_at }));
}

export function setProfileListEntry(
  database: BetterSqlite3.Database,
  profileId: string,
  mediaId: string,
  kind: ProfileListKind,
  present: boolean,
): ProfileListEntry[] {
  if (!getProfile(database, profileId)) throw new Error('That profile no longer exists.');
  const safeMediaId = String(mediaId).trim().slice(0, 240);
  if (!safeMediaId) throw new Error('A media ID is required.');
  if (present) {
    database.prepare(`
      INSERT OR IGNORE INTO profile_media_lists (profile_id, media_id, list_kind, created_at)
      VALUES (?, ?, ?, ?)
    `).run(profileId, safeMediaId, kind, Date.now());
  } else {
    database.prepare('DELETE FROM profile_media_lists WHERE profile_id = ? AND media_id = ? AND list_kind = ?')
      .run(profileId, safeMediaId, kind);
  }
  return getProfileLists(database, profileId);
}

export function profilePersonalDataCount(database: BetterSqlite3.Database, profileId: string): number {
  const tables = ['playback_progress', 'playback_track_preferences', 'profile_media_lists'] as const;
  return tables.reduce((total, table) => total + (
    database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE profile_id = ?`).get(profileId) as { n: number }
  ).n, 0);
}

export function resetOwnerProfile(database: BetterSqlite3.Database): ProfileRecord {
  const owner = getOwnerProfile(database);
  if (!owner) throw new Error('The Owner profile could not be found.');
  database.transaction(() => {
    for (const table of [
      'playback_progress',
      'playback_track_preferences',
      'profile_preferences',
      'profile_restrictions',
      'profile_library_access',
      'profile_media_lists',
    ]) database.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(owner.id);
    database.prepare(`
      UPDATE profiles SET
        name = 'Owner', avatar_key = ?, color_key = ?, pin_hash = NULL,
        pin_salt = NULL, updated_at = ?, last_used_at = NULL, sort_order = 0
      WHERE id = ?
    `).run(DEFAULT_AVATAR_KEY, DEFAULT_COLOR_KEY, Date.now(), owner.id);
    database.prepare('UPDATE device_profile_selections SET automatic_sign_in = 0 WHERE profile_id = ?').run(owner.id);
  })();
  const reset = getOwnerProfile(database);
  if (!reset) throw new Error('The Owner profile could not be reset.');
  return reset;
}
