import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { normalizeProfileType, profileView } from '@loom-media-server/media-core';

/**
 * Durable hosted-client state (profiles, watch progress, profile selection).
 *
 * Persistence is SQLite via the Node built-in driver: it needs no native
 * build step in the multi-arch container image, writes are transactional,
 * and progress no longer lives in one ever-growing JSON document. The legacy
 * `headless-client.json` store is migrated in on first open and kept beside
 * the database as a `.migrated` backup.
 *
 * The exported interface and the backup snapshot shape are unchanged, so the
 * admin backup/restore envelope remains compatible across the JSON and
 * SQLite eras in both directions.
 */

const LEGACY_STATE_FILENAME = 'headless-client.json';
const STATE_FILENAME = 'headless-client.sqlite';
const MAX_PROFILES = 32;
const MAX_PROGRESS = 20_000;
const MAX_NAME_LENGTH = 80;
const PROFILE_TYPES = new Set(['owner', 'standard', 'kid', 'guest']);

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeState(raw) {
  const state = { profiles: [], progress: {}, selections: {} };
  if (!raw || typeof raw !== 'object') return state;
  if (Array.isArray(raw.profiles)) {
    state.profiles = raw.profiles
      .filter((profile) => profile && typeof profile.id === 'string' && typeof profile.ownerId === 'string')
      .map((profile) => ({
        id: profile.id.slice(0, 128),
        ownerId: profile.ownerId.slice(0, 128),
        name: String(profile.name || 'Viewer').trim().slice(0, MAX_NAME_LENGTH) || 'Viewer',
        type: normalizeProfileType(profile.type),
        avatarKey: String(profile.avatarKey || 'glyph-01').slice(0, 80),
        colorKey: String(profile.colorKey || 'ember').slice(0, 80),
        hasPin: false,
        isGuest: profile.isGuest === true || profile.type === 'guest',
        createdAt: safeNumber(profile.createdAt, Date.now()),
        updatedAt: safeNumber(profile.updatedAt, Date.now()),
      }))
      .slice(0, MAX_PROFILES);
  }
  if (raw.progress && typeof raw.progress === 'object' && !Array.isArray(raw.progress)) {
    for (const [profileId, entries] of Object.entries(raw.progress)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      const normalizedEntries = {};
      for (const [mediaId, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        normalizedEntries[String(mediaId).slice(0, 128)] = {
          position: safeNumber(entry.position),
          duration: safeNumber(entry.duration),
          watched: entry.watched === true,
          updatedAt: safeNumber(entry.updatedAt, Date.now()),
        };
        if (Object.keys(normalizedEntries).length >= MAX_PROGRESS) break;
      }
      state.progress[String(profileId).slice(0, 128)] = normalizedEntries;
    }
  }
  if (raw.selections && typeof raw.selections === 'object' && !Array.isArray(raw.selections)) {
    for (const [ownerId, profileId] of Object.entries(raw.selections)) {
      if (typeof profileId === 'string') state.selections[String(ownerId).slice(0, 128)] = profileId.slice(0, 128);
    }
  }
  return state;
}

function publicProfile(profile) {
  const portable = profileView(profile);
  return {
    ...portable,
    avatarKey: profile.avatarKey,
    colorKey: profile.colorKey,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function profileRowView(row) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    type: row.type,
    avatarKey: row.avatarKey,
    colorKey: row.colorKey,
    hasPin: false,
    isGuest: row.isGuest === 1,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function progressRowView(row) {
  return {
    position: Number(row.position),
    duration: Number(row.duration),
    watched: row.watched === 1,
    updatedAt: Number(row.updatedAt),
  };
}

export function createHeadlessClientState({ dataDir }) {
  const resolvedDataDir = path.resolve(dataDir);
  const databasePath = path.join(resolvedDataDir, STATE_FILENAME);
  const legacyPath = path.join(resolvedDataDir, LEGACY_STATE_FILENAME);
  let databasePromise;

  function writeState(database, state) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec('DELETE FROM profiles; DELETE FROM progress; DELETE FROM selections;');
      const insertProfile = database.prepare(
        'INSERT INTO profiles (id, ownerId, name, type, avatarKey, colorKey, isGuest, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const profile of state.profiles) {
        insertProfile.run(profile.id, profile.ownerId, profile.name, profile.type, profile.avatarKey, profile.colorKey, profile.isGuest ? 1 : 0, profile.createdAt, profile.updatedAt);
      }
      const insertProgress = database.prepare(
        'INSERT INTO progress (profileId, mediaId, position, duration, watched, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const [profileId, entries] of Object.entries(state.progress)) {
        for (const [mediaId, entry] of Object.entries(entries)) {
          insertProgress.run(profileId, mediaId, entry.position, entry.duration, entry.watched ? 1 : 0, entry.updatedAt);
        }
      }
      const insertSelection = database.prepare('INSERT INTO selections (ownerId, profileId) VALUES (?, ?)');
      for (const [ownerId, profileId] of Object.entries(state.selections)) insertSelection.run(ownerId, profileId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  async function openDatabase() {
    if (!databasePromise) {
      databasePromise = (async () => {
        await fs.mkdir(resolvedDataDir, { recursive: true });
        const database = new DatabaseSync(databasePath);
        database.exec('PRAGMA journal_mode = WAL');
        database.exec(`
          CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            ownerId TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            avatarKey TEXT NOT NULL,
            colorKey TEXT NOT NULL,
            isGuest INTEGER NOT NULL DEFAULT 0,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS profiles_owner ON profiles (ownerId);
          CREATE TABLE IF NOT EXISTS progress (
            profileId TEXT NOT NULL,
            mediaId TEXT NOT NULL,
            position REAL NOT NULL DEFAULT 0,
            duration REAL NOT NULL DEFAULT 0,
            watched INTEGER NOT NULL DEFAULT 0,
            updatedAt INTEGER NOT NULL,
            PRIMARY KEY (profileId, mediaId)
          );
          CREATE INDEX IF NOT EXISTS progress_updated ON progress (profileId, updatedAt);
          CREATE TABLE IF NOT EXISTS selections (
            ownerId TEXT PRIMARY KEY,
            profileId TEXT NOT NULL
          );
        `);
        const hasProfiles = database.prepare('SELECT COUNT(*) AS count FROM profiles').get().count > 0;
        if (!hasProfiles) {
          // One-time migration from the legacy JSON store.
          const legacyRaw = await fs.readFile(legacyPath, 'utf8').catch(() => null);
          if (legacyRaw !== null) {
            try {
              writeState(database, normalizeState(JSON.parse(legacyRaw)));
              await fs.rename(legacyPath, `${legacyPath}.migrated`);
            } catch {
              // A corrupt legacy file must not block the server; the store
              // simply starts empty and the file stays on disk for triage.
            }
          }
        }
        return database;
      })();
    }
    return databasePromise;
  }

  function requireProfile(database, profileId, ownerId) {
    const profile = database.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!profile) throw Object.assign(new Error('Profile was not found.'), { status: 404, code: 'profile_not_found' });
    if (profile.ownerId !== ownerId && ownerId !== '__owner__') {
      throw Object.assign(new Error('That profile is not available to this account.'), { status: 403, code: 'profile_forbidden' });
    }
    return profileRowView(profile);
  }

  return {
    /**
     * Return a normalized, credential-free snapshot for the admin backup
     * envelope. The snapshot shape matches the legacy JSON store so backups
     * restore across both persistence eras.
     */
    async exportState() {
      const database = await openDatabase();
      const state = { profiles: [], progress: {}, selections: {} };
      state.profiles = database.prepare('SELECT * FROM profiles ORDER BY createdAt').all().map(profileRowView);
      for (const row of database.prepare('SELECT * FROM progress').all()) {
        state.progress[row.profileId] ||= {};
        state.progress[row.profileId][row.mediaId] = progressRowView(row);
      }
      for (const row of database.prepare('SELECT * FROM selections').all()) {
        state.selections[row.ownerId] = row.profileId;
      }
      return normalizeState(state);
    },

    /** Replace the client store from a validated backup snapshot. */
    async importState(raw) {
      const database = await openDatabase();
      const normalized = normalizeState(raw);
      writeState(database, normalized);
      return normalized;
    },

    async listProfiles(ownerId, canSeeAll = false) {
      const database = await openDatabase();
      const rows = canSeeAll
        ? database.prepare('SELECT * FROM profiles ORDER BY createdAt').all()
        : database.prepare('SELECT * FROM profiles WHERE ownerId = ? ORDER BY createdAt').all(ownerId);
      return rows.map((row) => publicProfile(profileRowView(row)));
    },

    async createProfile(input, ownerId) {
      const database = await openDatabase();
      const totalCount = database.prepare('SELECT COUNT(*) AS count FROM profiles').get().count;
      if (totalCount >= MAX_PROFILES) throw Object.assign(new Error('The server has reached its profile limit.'), { status: 400, code: 'profile_limit' });
      const ownedCount = database.prepare('SELECT COUNT(*) AS count FROM profiles WHERE ownerId = ?').get(ownerId).count;
      if (ownedCount >= 10) throw Object.assign(new Error('An account can have up to 10 profiles.'), { status: 400, code: 'profile_limit' });
      const name = String(input.name || '').trim().slice(0, MAX_NAME_LENGTH);
      if (!name) throw Object.assign(new Error('Profile name is required.'), { status: 400, code: 'profile_name_required' });
      const now = Date.now();
      const profile = {
        id: randomUUID(),
        ownerId,
        name,
        type: PROFILE_TYPES.has(input.type) ? input.type : 'standard',
        avatarKey: String(input.avatarKey || 'glyph-01').trim().slice(0, 80),
        colorKey: String(input.colorKey || 'ember').trim().slice(0, 80),
        hasPin: false,
        isGuest: input.type === 'guest',
        createdAt: now,
        updatedAt: now,
      };
      database.prepare(
        'INSERT INTO profiles (id, ownerId, name, type, avatarKey, colorKey, isGuest, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(profile.id, profile.ownerId, profile.name, profile.type, profile.avatarKey, profile.colorKey, profile.isGuest ? 1 : 0, now, now);
      database.prepare('INSERT OR IGNORE INTO selections (ownerId, profileId) VALUES (?, ?)').run(ownerId, profile.id);
      return publicProfile(profile);
    },

    async updateProfile(profileId, input, ownerId, canSeeAll = false) {
      const database = await openDatabase();
      const profile = requireProfile(database, profileId, canSeeAll ? '__owner__' : ownerId);
      if (input.name !== undefined) {
        const name = String(input.name || '').trim().slice(0, MAX_NAME_LENGTH);
        if (!name) throw Object.assign(new Error('Profile name is required.'), { status: 400, code: 'profile_name_required' });
        profile.name = name;
      }
      if (input.type !== undefined) profile.type = normalizeProfileType(input.type);
      if (input.avatarKey !== undefined) profile.avatarKey = String(input.avatarKey || '').trim().slice(0, 80);
      if (input.colorKey !== undefined) profile.colorKey = String(input.colorKey || '').trim().slice(0, 80);
      profile.updatedAt = Date.now();
      database.prepare('UPDATE profiles SET name = ?, type = ?, avatarKey = ?, colorKey = ?, updatedAt = ? WHERE id = ?')
        .run(profile.name, profile.type, profile.avatarKey, profile.colorKey, profile.updatedAt, profileId);
      return publicProfile(profile);
    },

    async selectProfile(profileId, ownerId, canSeeAll = false) {
      const database = await openDatabase();
      const profile = requireProfile(database, profileId, canSeeAll ? '__owner__' : ownerId);
      database.prepare('INSERT INTO selections (ownerId, profileId) VALUES (?, ?) ON CONFLICT(ownerId) DO UPDATE SET profileId = excluded.profileId')
        .run(ownerId, profileId);
      return publicProfile(profile);
    },

    async listProgress(profileId, ownerId, canSeeAll = false) {
      const database = await openDatabase();
      requireProfile(database, profileId, canSeeAll ? '__owner__' : ownerId);
      const progress = {};
      for (const row of database.prepare('SELECT * FROM progress WHERE profileId = ?').all(profileId)) {
        progress[row.mediaId] = progressRowView(row);
      }
      return progress;
    },

    async getProgress(profileId, mediaId, ownerId, canSeeAll = false) {
      const database = await openDatabase();
      requireProfile(database, profileId, canSeeAll ? '__owner__' : ownerId);
      const row = database.prepare('SELECT * FROM progress WHERE profileId = ? AND mediaId = ?').get(profileId, String(mediaId).slice(0, 128));
      return row ? progressRowView(row) : null;
    },

    async saveProgress(profileId, mediaId, input, ownerId, canSeeAll = false) {
      const database = await openDatabase();
      requireProfile(database, profileId, canSeeAll ? '__owner__' : ownerId);
      const entry = {
        position: safeNumber(input.position),
        duration: safeNumber(input.duration),
        watched: input.watched === true || (safeNumber(input.duration) > 0 && safeNumber(input.position) >= safeNumber(input.duration) * 0.9),
        updatedAt: Date.now(),
      };
      database.prepare(
        `INSERT INTO progress (profileId, mediaId, position, duration, watched, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profileId, mediaId) DO UPDATE SET position = excluded.position, duration = excluded.duration, watched = excluded.watched, updatedAt = excluded.updatedAt`,
      ).run(profileId, String(mediaId).slice(0, 128), entry.position, entry.duration, entry.watched ? 1 : 0, entry.updatedAt);
      // Bound per-profile history: keep the most recently updated entries.
      database.prepare(
        `DELETE FROM progress WHERE profileId = ? AND mediaId NOT IN (
           SELECT mediaId FROM progress WHERE profileId = ? ORDER BY updatedAt DESC LIMIT ?
         )`,
      ).run(profileId, profileId, MAX_PROGRESS);
      return entry;
    },
  };
}

export const headlessClientStateFilename = STATE_FILENAME;
export const legacyHeadlessClientStateFilename = LEGACY_STATE_FILENAME;
