import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeProfileType, profileView } from '@loom-media-server/media-core';

const STATE_FILENAME = 'headless-client.json';
const MAX_PROFILES = 32;
const MAX_PROGRESS = 20_000;
const MAX_NAME_LENGTH = 80;
const PROFILE_TYPES = new Set(['owner', 'standard', 'kid', 'guest']);

function defaultState() {
  return { profiles: [], progress: {}, selections: {} };
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeState(raw) {
  const state = defaultState();
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

export function createHeadlessClientState({ dataDir }) {
  const statePath = path.join(path.resolve(dataDir), STATE_FILENAME);
  let statePromise;
  let writeQueue = Promise.resolve();

  async function loadState() {
    if (!statePromise) {
      statePromise = fs.readFile(statePath, 'utf8')
        .then((value) => normalizeState(JSON.parse(value)))
        .catch(() => defaultState());
    }
    return statePromise;
  }

  async function saveState(state) {
    writeQueue = writeQueue.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      const temporaryPath = `${statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, statePath);
    });
    return writeQueue;
  }

  function assertProfileOwner(state, profileId, ownerId) {
    const profile = state.profiles.find((entry) => entry.id === profileId);
    if (!profile) throw Object.assign(new Error('Profile was not found.'), { status: 404, code: 'profile_not_found' });
    if (profile.ownerId !== ownerId && ownerId !== '__owner__') {
      throw Object.assign(new Error('That profile is not available to this account.'), { status: 403, code: 'profile_forbidden' });
    }
    return profile;
  }

  return {
    /**
     * Return a normalized, credential-free snapshot for the admin backup
     * envelope.  The client store is deliberately separate from the catalog
     * adapter, but it still participates in the same backup/restore contract.
     */
    async exportState() {
      const state = await loadState();
      return normalizeState(JSON.parse(JSON.stringify(state)));
    },

    /** Replace the client store from a validated backup snapshot. */
    async importState(raw) {
      const normalized = normalizeState(raw);
      await saveState(normalized);
      statePromise = Promise.resolve(normalized);
      return normalized;
    },

    async listProfiles(ownerId, canSeeAll = false) {
      const state = await loadState();
      const profiles = canSeeAll ? state.profiles : state.profiles.filter((profile) => profile.ownerId === ownerId);
      return profiles.map(publicProfile);
    },

    async createProfile(input, ownerId) {
      const state = await loadState();
      const ownedCount = state.profiles.filter((profile) => profile.ownerId === ownerId).length;
      if (state.profiles.length >= MAX_PROFILES) throw Object.assign(new Error('The server has reached its profile limit.'), { status: 400, code: 'profile_limit' });
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
      state.profiles.push(profile);
      if (!state.selections[ownerId]) state.selections[ownerId] = profile.id;
      await saveState(state);
      return publicProfile(profile);
    },

    async updateProfile(profileId, input, ownerId, canSeeAll = false) {
      const state = await loadState();
      const profile = assertProfileOwner(state, profileId, canSeeAll ? '__owner__' : ownerId);
      if (input.name !== undefined) {
        const name = String(input.name || '').trim().slice(0, MAX_NAME_LENGTH);
        if (!name) throw Object.assign(new Error('Profile name is required.'), { status: 400, code: 'profile_name_required' });
        profile.name = name;
      }
      if (input.type !== undefined) profile.type = normalizeProfileType(input.type);
      if (input.avatarKey !== undefined) profile.avatarKey = String(input.avatarKey || '').trim().slice(0, 80);
      if (input.colorKey !== undefined) profile.colorKey = String(input.colorKey || '').trim().slice(0, 80);
      profile.updatedAt = Date.now();
      await saveState(state);
      return publicProfile(profile);
    },

    async selectProfile(profileId, ownerId, canSeeAll = false) {
      const state = await loadState();
      const profile = assertProfileOwner(state, profileId, canSeeAll ? '__owner__' : ownerId);
      state.selections[ownerId] = profile.id;
      await saveState(state);
      return publicProfile(profile);
    },

    async listProgress(profileId, ownerId, canSeeAll = false) {
      const state = await loadState();
      assertProfileOwner(state, profileId, canSeeAll ? '__owner__' : ownerId);
      return state.progress[profileId] || {};
    },

    async getProgress(profileId, mediaId, ownerId, canSeeAll = false) {
      const state = await loadState();
      assertProfileOwner(state, profileId, canSeeAll ? '__owner__' : ownerId);
      return state.progress[profileId]?.[mediaId] || null;
    },

    async saveProgress(profileId, mediaId, input, ownerId, canSeeAll = false) {
      const state = await loadState();
      assertProfileOwner(state, profileId, canSeeAll ? '__owner__' : ownerId);
      const entry = {
        position: safeNumber(input.position),
        duration: safeNumber(input.duration),
        watched: input.watched === true || (safeNumber(input.duration) > 0 && safeNumber(input.position) >= safeNumber(input.duration) * 0.9),
        updatedAt: Date.now(),
      };
      state.progress[profileId] ||= {};
      state.progress[profileId][String(mediaId).slice(0, 128)] = entry;
      const entries = Object.entries(state.progress[profileId]);
      if (entries.length > MAX_PROGRESS) {
        entries.sort((left, right) => right[1].updatedAt - left[1].updatedAt);
        state.progress[profileId] = Object.fromEntries(entries.slice(0, MAX_PROGRESS));
      }
      await saveState(state);
      return entry;
    },
  };
}

export const headlessClientStateFilename = STATE_FILENAME;
