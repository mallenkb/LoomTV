import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { canonicalProfileKind } from '@loom-media-server/video-contracts';
import { migrateLegacyProfileKind } from '@loom-media-server/video-contracts/server';

const LEGACY_STATE_FILENAME = 'headless-client.json';
const STATE_FILENAME = 'headless-client.sqlite';
const MAX_PROFILES = 32;
const MAX_PROGRESS = 20_000;
const MAX_NAME_LENGTH = 80;
const PROFILE_UNLOCK_TTL_MS = 30 * 60 * 1000;
const MAX_PIN_FAILURES = 2_048;
const scrypt = promisify(scryptCallback);

const safeNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

function assignmentAccess(value) {
  if (value === 'use' || value === 'manage') return value;
  throw Object.assign(new Error('Profile assignment access is invalid.'), { status: 422, code: 'profile_assignment_invalid' });
}

function persistedProfileKind(value) {
  try { return canonicalProfileKind(value); } catch { return migrateLegacyProfileKind(value); }
}

function profileKindInput(input, fallback = 'adult') {
  if (input?.kind !== undefined) return canonicalProfileKind(input.kind);
  if (input?.type !== undefined) return migrateLegacyProfileKind(input.type);
  return fallback;
}

function legacyProfileType(kind) {
  if (kind === 'adult') return 'standard';
  if (kind === 'child') return 'kid';
  return 'guest';
}

function normalizeProfile(profile) {
  const kind = persistedProfileKind(profile.kind ?? profile.type);
  return {
    id: String(profile.id).slice(0, 128),
    name: String(profile.name || 'Viewer').trim().slice(0, MAX_NAME_LENGTH) || 'Viewer',
    kind,
    avatarKey: String(profile.avatarKey || 'glyph-01').slice(0, 80),
    colorKey: String(profile.colorKey || 'ember').slice(0, 80),
    hasPin: profile.hasPin === true,
    isGuest: kind === 'guest',
    ...(typeof profile.guestDeviceId === 'string' ? { guestDeviceId: profile.guestDeviceId.slice(0, 128) } : {}),
    sortOrder: safeNumber(profile.sortOrder),
    createdAt: safeNumber(profile.createdAt, Date.now()),
    updatedAt: safeNumber(profile.updatedAt, Date.now()),
    ...(profile.lastUsedAt === undefined ? {} : { lastUsedAt: safeNumber(profile.lastUsedAt) }),
  };
}

function normalizeCarrierArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object').map((item) => ({ ...item })) : [];
}

function canonicalPreferencesInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Profile preferences must be an object.'), { status: 400, code: 'invalid_request' });
  }
  const allowed = new Set(['themeMode','themeColor','showProviderRatingBadges','sidebarNavOrder','autoplayNextEnabled','skipBackSeconds','skipForwardSeconds']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw Object.assign(new Error('Profile preferences contain an unsupported field.'), { status: 400, code: 'invalid_request' });
  }
  const result = {};
  if (value.themeMode !== undefined) {
    if (!['dark','light'].includes(value.themeMode)) throw Object.assign(new Error('themeMode is invalid.'), { status: 400, code: 'invalid_request' });
    result.themeMode = value.themeMode;
  }
  if (value.themeColor !== undefined) {
    if (!['orange','yellow','red','blue','twitch'].includes(value.themeColor)) throw Object.assign(new Error('themeColor is invalid.'), { status: 400, code: 'invalid_request' });
    result.themeColor = value.themeColor;
  }
  for (const key of ['showProviderRatingBadges','autoplayNextEnabled']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw Object.assign(new Error(`${key} must be boolean.`), { status: 400, code: 'invalid_request' });
      result[key] = value[key];
    }
  }
  if (value.sidebarNavOrder !== undefined) {
    if (!Array.isArray(value.sidebarNavOrder) || value.sidebarNavOrder.length > 32
      || value.sidebarNavOrder.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 64)) {
      throw Object.assign(new Error('sidebarNavOrder is invalid.'), { status: 400, code: 'invalid_request' });
    }
    result.sidebarNavOrder = [...new Set(value.sidebarNavOrder)];
  }
  for (const key of ['skipBackSeconds','skipForwardSeconds']) {
    if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 600) {
        throw Object.assign(new Error(`${key} is invalid.`), { status: 400, code: 'invalid_request' });
      }
      result[key] = value[key];
    }
  }
  return result;
}

function trackPreferencesInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['audio','subtitle'].includes(key))) {
    throw Object.assign(new Error('Track preferences are invalid.'), { status: 400, code: 'invalid_request' });
  }
  const result = {};
  for (const kind of ['audio','subtitle']) {
    const preference = value[kind];
    if (preference === undefined) continue;
    if (!preference || typeof preference !== 'object' || Array.isArray(preference)
      || Object.keys(preference).some((key) => !['enabled','trackId','index','language','title','codec','forced'].includes(key))
      || typeof preference.enabled !== 'boolean'
      || (preference.index !== undefined && (!Number.isSafeInteger(preference.index) || preference.index < 0))
      || ['trackId','language','title','codec'].some((key) => preference[key] !== undefined
        && (typeof preference[key] !== 'string' || preference[key].length > 128 || preference[key].includes('\u0000')))
      || (preference.forced !== undefined && typeof preference.forced !== 'boolean')) {
      throw Object.assign(new Error(`${kind} track preference is invalid.`), { status: 400, code: 'invalid_request' });
    }
    result[kind] = { ...preference };
  }
  return result;
}

export function normalizeHeadlessClientState(raw) {
  const state = {
    profiles: [], profileCredentials: [], assignments: [], selections: [], progress: [], history: [],
    profilePreferences: [], profileRestrictions: [], profileListEntries: [], trackPreferences: [],
  };
  if (!raw || typeof raw !== 'object') return state;
  state.profiles = (Array.isArray(raw.profiles) ? raw.profiles : [])
    .filter((profile) => profile && typeof profile.id === 'string')
    .map(normalizeProfile).slice(0, MAX_PROFILES);
  const profileIds = new Set(state.profiles.map((profile) => profile.id));

  if (Array.isArray(raw.assignments)) {
    state.assignments = raw.assignments
      .filter((item) => item && profileIds.has(item.profileId) && typeof item.accountId === 'string')
      .map((item) => ({
        profileId: item.profileId.slice(0, 128), accountId: item.accountId.slice(0, 128),
        access: assignmentAccess(item.access), createdAt: safeNumber(item.createdAt, Date.now()),
      }));
  }
  const assigned = new Set(state.assignments.map((item) => item.profileId));
  for (const source of Array.isArray(raw.profiles) ? raw.profiles : []) {
    if (!profileIds.has(source?.id) || assigned.has(source.id) || typeof source.ownerId !== 'string') continue;
    state.assignments.push({ profileId: source.id, accountId: source.ownerId.slice(0, 128), access: 'manage', createdAt: safeNumber(source.createdAt, Date.now()) });
  }
  state.assignments = [...new Map(state.assignments.map((item) => [`${item.profileId}\u0000${item.accountId}`, item])).values()];

  if (Array.isArray(raw.selections)) {
    state.selections = raw.selections.filter((item) => item && typeof item.accountId === 'string').map((item) => ({
      accountId: item.accountId.slice(0, 128), deviceId: String(item.deviceId || `account:${item.accountId}`).slice(0, 128),
      profileId: typeof item.profileId === 'string' ? item.profileId.slice(0, 128) : null,
      revision: safeNumber(item.revision), automaticSignIn: item.automaticSignIn === true,
      ...(item.selectedAt === undefined ? {} : { selectedAt: safeNumber(item.selectedAt) }),
    }));
  } else if (raw.selections && typeof raw.selections === 'object') {
    state.selections = Object.entries(raw.selections).filter(([, profileId]) => typeof profileId === 'string').map(([accountId, profileId]) => ({
      accountId: accountId.slice(0, 128), deviceId: `account:${accountId}`.slice(0, 128), profileId: profileId.slice(0, 128),
      revision: 0, automaticSignIn: false, selectedAt: Date.now(),
    }));
  }

  if (Array.isArray(raw.progress)) {
    state.progress = raw.progress.filter((item) => item && typeof item.profileId === 'string' && typeof item.mediaId === 'string').map((item) => ({
      profileId: item.profileId.slice(0, 128), mediaId: item.mediaId.slice(0, 128),
      positionSeconds: safeNumber(item.positionSeconds ?? item.position), durationSeconds: safeNumber(item.durationSeconds ?? item.duration),
      watched: item.watched === true, updatedAt: safeNumber(item.updatedAt, Date.now()),
    })).slice(0, MAX_PROGRESS * MAX_PROFILES);
  } else if (raw.progress && typeof raw.progress === 'object') {
    for (const [profileId, entries] of Object.entries(raw.progress)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      for (const [mediaId, item] of Object.entries(entries).slice(0, MAX_PROGRESS)) {
        if (!item || typeof item !== 'object') continue;
        state.progress.push({ profileId: profileId.slice(0, 128), mediaId: mediaId.slice(0, 128),
          positionSeconds: safeNumber(item.position), durationSeconds: safeNumber(item.duration),
          watched: item.watched === true, updatedAt: safeNumber(item.updatedAt, Date.now()) });
      }
    }
  }
  for (const key of ['profileCredentials','profilePreferences','profileRestrictions','profileListEntries','trackPreferences']) {
    state[key] = normalizeCarrierArray(raw[key]).filter((item) => profileIds.has(item.profileId));
  }
  state.history = normalizeCarrierArray(raw.history).filter((item) => profileIds.has(item.profileId));
  return state;
}

function publicProfile(profile) {
  return {
    id: profile.id, name: profile.name, kind: profile.kind,
    hasPin: profile.hasPin === true, avatarKey: profile.avatarKey,
    colorKey: profile.colorKey, sortOrder: profile.sortOrder, createdAt: profile.createdAt, updatedAt: profile.updatedAt,
    ...(profile.guestDeviceId ? { guestDeviceId: profile.guestDeviceId } : {}),
    ...(profile.lastUsedAt === undefined ? {} : { lastUsedAt: profile.lastUsedAt }),
  };
}

function legacySnapshot(state) {
  const owners = new Map();
  for (const assignment of state.assignments) if (assignment.access === 'manage' && !owners.has(assignment.profileId)) owners.set(assignment.profileId, assignment.accountId);
  const progress = {};
  for (const item of state.progress) {
    progress[item.profileId] ||= {};
    progress[item.profileId][item.mediaId] = { position: item.positionSeconds, duration: item.durationSeconds, watched: item.watched, updatedAt: item.updatedAt };
  }
  const selections = {};
  for (const item of state.selections) if (item.profileId) selections[item.accountId] = item.profileId;
  return {
    profiles: state.profiles.map((profile) => ({ ...profile, ownerId: owners.get(profile.id) || '', type: legacyProfileType(profile.kind) })),
    assignments: state.assignments, progress, selections, history: state.history,
    profileCredentials: state.profileCredentials, profilePreferences: state.profilePreferences,
    profileRestrictions: state.profileRestrictions, profileListEntries: state.profileListEntries,
    trackPreferences: state.trackPreferences,
  };
}

export function createHeadlessClientState({ store, validateAccount = async () => false }) {
  if (!store) throw new Error('createHeadlessClientState requires the canonical state store.');
  const unlockedSelections = new Map();
  const pinFailures = new Map();
  const unlockKey = (accountId, deviceId, profileId) => `${accountId}\u0000${deviceId}\u0000${profileId}`;
  const prunePinState = () => {
    const current = Date.now();
    for (const [key, value] of unlockedSelections) if (value.expiresAt <= current) unlockedSelections.delete(key);
    for (const [key, value] of pinFailures) if (current - value.lastAttemptAt > 24 * 60 * 60 * 1000) pinFailures.delete(key);
    while (pinFailures.size > MAX_PIN_FAILURES) pinFailures.delete(pinFailures.keys().next().value);
  };
  const verifyPin = async (pin, credential) => {
    try {
      if (!/^\d{4}$/.test(String(pin || '')) || !credential) return false;
      const expected = Buffer.from(String(credential.pinHash || credential.hash || ''), 'base64');
      const salt = Buffer.from(String(credential.pinSalt || credential.salt || ''), 'base64');
      if (expected.length !== 32 || salt.length < 8) return false;
      const actual = await scrypt(String(pin), salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch { return false; }
  };
  const requireProfile = (state, profileId, accountId, canSeeAll) => {
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) throw Object.assign(new Error('Profile was not found.'), { status: 404, code: 'profile_not_found' });
    const assignment = canSeeAll ? { access: 'manage' } : state.assignments.find((item) => item.profileId === profileId && item.accountId === accountId);
    if (!assignment) throw Object.assign(new Error('That profile is not available to this account.'), { status: 403, code: 'profile_forbidden' });
    return { profile, assignment };
  };

  const restrictedProfileContext = (state, accountId, profile, assignment, media, context) => {
    const restrictions = state.profileRestrictions.find((item) => item.profileId === profile.id) || null;
    if (profile.kind === 'child' && !restrictions) {
      throw Object.assign(new Error('The child profile has no enforceable restriction record.'), { status: 403, code: 'permission_denied' });
    }
    if (restrictions && media) {
      if (restrictions.allowedRootIds !== null
        && (!Array.isArray(restrictions.allowedRootIds) || !restrictions.allowedRootIds.includes(media.rootId))) {
        throw Object.assign(new Error('The active profile cannot access this library root.'), { status: 403, code: 'permission_denied' });
      }
      const country = String(restrictions.country || '').toUpperCase();
      const ratingEntry = Object.entries(media.contentRatings || {}).find(([key]) => key.toUpperCase() === country)?.[1];
      const contentAge = Number(ratingEntry?.minimumAge ?? media.maximumAge ?? media.ageRating ?? media.localMetadata?.maximumAge);
      const rated = Number.isFinite(contentAge) && contentAge >= 0;
      if (!rated && restrictions.allowUnrated === false) {
        throw Object.assign(new Error('The active profile does not allow unrated media.'), { status: 403, code: 'permission_denied' });
      }
      if (rated && Number.isFinite(restrictions.maximumAge) && contentAge > restrictions.maximumAge) {
        throw Object.assign(new Error('The active profile age limit excludes this media.'), { status: 403, code: 'permission_denied' });
      }
    }
    return {
      profile: publicProfile(profile), profileId: profile.id,
      assignmentAccess: assignment.access,
      restrictions: restrictions ? { ...restrictions } : null,
      ...context,
    };
  };

  const playbackContext = (state, accountId, deviceId, media) => {
    const normalizedDeviceId = String(deviceId || `account:${accountId}`).slice(0, 128);
    const selection = state.selections.find((item) => item.accountId === accountId && item.deviceId === normalizedDeviceId);
    if (!selection?.profileId) throw Object.assign(new Error('Select a viewing profile before playback.'), { status: 409, code: 'profile_required' });
    const profile = state.profiles.find((item) => item.id === selection.profileId);
    const assignment = state.assignments.find((item) => item.profileId === selection.profileId && item.accountId === accountId);
    if (!profile || !assignment) throw Object.assign(new Error('The active profile selection is no longer authorized.'), { status: 409, code: 'stale_profile_selection' });
    if (profile.hasPin) {
      prunePinState();
      const unlocked = unlockedSelections.get(unlockKey(accountId, normalizedDeviceId, profile.id));
      if (!unlocked || unlocked.revision !== selection.revision || unlocked.expiresAt <= Date.now()) {
        throw Object.assign(new Error('The active profile is locked.'), { status: 403, code: 'profile_locked' });
      }
    }
    return restrictedProfileContext(state, accountId, profile, assignment, media, {
      deviceId: normalizedDeviceId, selectionRevision: selection.revision,
    });
  };

  return {
    async ready() {},
    async exportState() { return legacySnapshot(store.readClientState()); },
    async importState(raw) {
      const normalized = normalizeHeadlessClientState(raw);
      store.replaceClientState(normalized);
      return legacySnapshot(normalized);
    },
    async listProfiles(accountId, canSeeAll = false) {
      const state = store.readClientState();
      const allowed = canSeeAll ? null : new Set(state.assignments.filter((item) => item.accountId === accountId).map((item) => item.profileId));
      return state.profiles.filter((profile) => !allowed || allowed.has(profile.id)).map(publicProfile);
    },
    async createProfile(input, accountId) {
      return store.mutateClientState((state) => {
        if (state.profiles.length >= MAX_PROFILES || state.assignments.filter((item) => item.accountId === accountId && item.access === 'manage').length >= 10) {
          throw Object.assign(new Error('The server has reached its profile limit.'), { status: 400, code: 'profile_limit' });
        }
        const name = String(input.name || '').trim().slice(0, MAX_NAME_LENGTH);
        if (!name) throw Object.assign(new Error('Profile name is required.'), { status: 400, code: 'profile_name_required' });
        const now = Date.now();
        const kind = profileKindInput(input);
        const profile = { id: randomUUID(), name, kind, avatarKey: String(input.avatarKey || 'glyph-01').slice(0, 80),
          colorKey: String(input.colorKey || 'ember').slice(0, 80), hasPin: false, isGuest: kind === 'guest',
          sortOrder: state.profiles.length, createdAt: now, updatedAt: now };
        state.profiles.push(profile);
        state.assignments.push({ profileId: profile.id, accountId, access: 'manage', createdAt: now });
        if (!state.selections.some((item) => item.accountId === accountId)) state.selections.push({ accountId, deviceId: `account:${accountId}`, profileId: profile.id, revision: 0, automaticSignIn: false, selectedAt: now });
        return publicProfile(profile);
      });
    },
    async updateProfile(profileId, input, accountId, canSeeAll = false) {
      return store.mutateClientState((state) => {
        const { profile, assignment } = requireProfile(state, profileId, accountId, canSeeAll);
        if (assignment.access !== 'manage') throw Object.assign(new Error('That account cannot manage this profile.'), { status: 403, code: 'profile_forbidden' });
        if (input.name !== undefined) {
          const name = String(input.name || '').trim().slice(0, MAX_NAME_LENGTH);
          if (!name) throw Object.assign(new Error('Profile name is required.'), { status: 400, code: 'profile_name_required' });
          profile.name = name;
        }
        if (input.kind !== undefined || input.type !== undefined) profile.kind = profileKindInput(input, profile.kind);
        if (input.avatarKey !== undefined) profile.avatarKey = String(input.avatarKey || '').trim().slice(0, 80);
        if (input.colorKey !== undefined) profile.colorKey = String(input.colorKey || '').trim().slice(0, 80);
        profile.updatedAt = Date.now();
        return publicProfile(profile);
      });
    },
    async removeProfile(profileId, accountId, canSeeAll = false) {
      const removed = store.mutateClientState((state) => {
        const { assignment } = requireProfile(state, profileId, accountId, canSeeAll);
        if (assignment.access !== 'manage') throw Object.assign(new Error('That account cannot manage this profile.'), { status: 403, code: 'profile_forbidden' });
        if (state.profiles.length <= 1) throw Object.assign(new Error('The last viewing profile cannot be removed.'), { status: 409, code: 'conflict' });
        state.profiles = state.profiles.filter((item) => item.id !== profileId);
        for (const key of ['profileCredentials','assignments','progress','history','profilePreferences','profileRestrictions','profileListEntries','trackPreferences']) {
          state[key] = state[key].filter((item) => item.profileId !== profileId);
        }
        for (const selection of state.selections) if (selection.profileId === profileId) {
          selection.profileId = null;
          selection.automaticSignIn = false;
          selection.revision += 1;
          selection.selectedAt = Date.now();
        }
        return true;
      });
      const suffix = `\u0000${profileId}`;
      for (const key of unlockedSelections.keys()) if (key.endsWith(suffix)) unlockedSelections.delete(key);
      for (const key of pinFailures.keys()) if (key.endsWith(suffix)) pinFailures.delete(key);
      return removed;
    },
    async updateProfilePin(profileId, pin, accountId, canSeeAll = false) {
      const before = store.readClientState();
      const { profile, assignment } = requireProfile(before, profileId, accountId, canSeeAll);
      if (assignment.access !== 'manage') throw Object.assign(new Error('That account cannot manage this profile.'), { status: 403, code: 'profile_forbidden' });
      if (profile.kind === 'guest') throw Object.assign(new Error('Guest profiles cannot have a PIN.'), { status: 409, code: 'conflict' });
      const remove = pin === null || pin === undefined || pin === '';
      if (!remove && !/^\d{4}$/.test(String(pin))) throw Object.assign(new Error('A profile PIN must contain exactly four digits.'), { status: 400, code: 'invalid_request' });
      let credential = null;
      if (!remove) {
        const salt = randomBytes(16);
        const hash = await scrypt(String(pin), salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        credential = { profileId, pinSalt: salt.toString('base64'), pinHash: hash.toString('base64'), pinAlgorithm: 'scrypt', updatedAt: Date.now() };
      }
      const result = store.mutateClientState((state) => {
        const { profile: current, assignment: currentAssignment } = requireProfile(state, profileId, accountId, canSeeAll);
        if (currentAssignment.access !== 'manage') throw Object.assign(new Error('That account cannot manage this profile.'), { status: 403, code: 'profile_forbidden' });
        state.profileCredentials = state.profileCredentials.filter((item) => item.profileId !== profileId);
        if (credential) state.profileCredentials.push(credential);
        current.hasPin = Boolean(credential);
        current.updatedAt = Date.now();
        for (const selection of state.selections) if (selection.profileId === profileId) {
          selection.automaticSignIn = false;
          selection.revision += 1;
        }
        return publicProfile(current);
      });
      const suffix = `\u0000${profileId}`;
      for (const key of unlockedSelections.keys()) if (key.endsWith(suffix)) unlockedSelections.delete(key);
      for (const key of pinFailures.keys()) if (key.endsWith(suffix)) pinFailures.delete(key);
      return result;
    },
    async selectProfile(profileId, accountId, canSeeAll = false, deviceId = undefined, pin = undefined, address = '') {
      const normalizedDeviceId = String(deviceId || `account:${accountId}`).slice(0, 128);
      const before = store.readClientState();
      const { profile } = requireProfile(before, profileId, accountId, false);
      if (profile.hasPin) {
        prunePinState();
        const remoteAddress = String(address || 'unknown').slice(0, 128);
        const failureKeys = [
          `account\u0000${accountId}\u0000${profileId}`,
          `address\u0000${remoteAddress}\u0000${profileId}`,
          `device\u0000${accountId}\u0000${normalizedDeviceId}\u0000${profileId}`,
        ];
        const failureStates = failureKeys.map((key) => pinFailures.get(key)).filter(Boolean);
        const current = Date.now();
        const blockedUntil = Math.max(0, ...failureStates.map((entry) => entry.blockedUntil));
        if (blockedUntil > current) throw Object.assign(new Error('That PIN could not be accepted.'), {
          status: 429, code: 'profile_locked', retryAfter: Math.max(1, Math.ceil((blockedUntil - current) / 1000)),
        });
        const credential = before.profileCredentials.find((item) => item.profileId === profileId);
        if (!await verifyPin(pin, credential)) {
          const failures = Math.max(0, ...failureStates.map((entry) => entry.failures)) + 1;
          const delayMs = failures < 5 ? 0 : Math.min(15 * 60 * 1000, 30_000 * 2 ** (failures - 5));
          for (const key of failureKeys) pinFailures.set(key, { failures, blockedUntil: current + delayMs, lastAttemptAt: current });
          throw Object.assign(new Error('That PIN could not be accepted.'), {
            status: delayMs ? 429 : 403, code: 'profile_locked', ...(delayMs ? { retryAfter: Math.ceil(delayMs / 1000) } : {}),
          });
        }
        for (const key of failureKeys) pinFailures.delete(key);
      }
      let selectedRevision = 0;
      const selected = store.mutateClientState((state) => {
        const { profile } = requireProfile(state, profileId, accountId, false);
        const existing = state.selections.find((item) => item.accountId === accountId && item.deviceId === normalizedDeviceId);
        if (existing) { existing.profileId = profileId; existing.revision += 1; existing.selectedAt = Date.now(); }
        else state.selections.push({ accountId, deviceId: normalizedDeviceId, profileId, revision: 0, automaticSignIn: false, selectedAt: Date.now() });
        selectedRevision = existing?.revision || 0;
        return publicProfile(profile);
      });
      if (profile.hasPin) unlockedSelections.set(unlockKey(accountId, normalizedDeviceId, profileId), {
        revision: selectedRevision, expiresAt: Date.now() + PROFILE_UNLOCK_TTL_MS,
      });
      return selected;
    },
    async requireActivePlaybackProfile(accountId, deviceId, media = undefined) {
      return playbackContext(store.readClientState(), accountId, deviceId, media);
    },
    async requireScopedProfile(accountId, profileId, media = undefined, deviceId = undefined) {
      const state = store.readClientState();
      const { profile, assignment } = requireProfile(state, profileId, accountId, false);
      const restrictions = state.profileRestrictions.find((item) => item.profileId === profile.id) || null;
      return restrictedProfileContext(state, accountId, profile, assignment, media, {
        deviceId: String(deviceId || `invitation:${profileId}`).slice(0, 128),
        selectionRevision: Number(restrictions?.revision || 0),
      });
    },
    async getActiveProfileState(accountId, deviceId) {
      prunePinState();
      const state = store.readClientState();
      const normalizedDeviceId = String(deviceId || `account:${accountId}`).slice(0, 128);
      const selection = state.selections.find((item) => item.accountId === accountId && item.deviceId === normalizedDeviceId);
      const profile = selection?.profileId ? state.profiles.find((item) => item.id === selection.profileId) : null;
      const unlocked = profile?.hasPin
        ? unlockedSelections.get(unlockKey(accountId, normalizedDeviceId, profile.id))
        : null;
      return {
        profileId: profile?.id || null,
        profile: profile ? publicProfile(profile) : null,
        selectionRevision: selection?.revision || 0,
        automaticSignIn: selection?.automaticSignIn === true,
        locked: Boolean(profile?.hasPin && (!unlocked || unlocked.revision !== selection?.revision || unlocked.expiresAt <= Date.now())),
      };
    },
    async lockActiveProfile(accountId, deviceId) {
      const normalizedDeviceId = String(deviceId || `account:${accountId}`).slice(0, 128);
      const state = store.readClientState();
      const selection = state.selections.find((item) => item.accountId === accountId && item.deviceId === normalizedDeviceId);
      if (selection?.profileId) unlockedSelections.delete(unlockKey(accountId, normalizedDeviceId, selection.profileId));
      if (selection) store.mutateClientState((next) => {
        const current = next.selections.find((item) => item.accountId === accountId && item.deviceId === normalizedDeviceId);
        if (current) current.revision += 1;
      });
      return this.getActiveProfileState(accountId, normalizedDeviceId);
    },
    async clearActiveProfile(accountId, deviceId) {
      const normalizedDeviceId = String(deviceId || `account:${accountId}`).slice(0, 128);
      const before = store.readClientState().selections.find((item) => item.accountId === accountId && item.deviceId === normalizedDeviceId);
      if (before?.profileId) unlockedSelections.delete(unlockKey(accountId, normalizedDeviceId, before.profileId));
      store.mutateClientState((state) => {
        const selection = state.selections.find((item) => item.accountId === accountId && item.deviceId === normalizedDeviceId);
        if (!selection) return;
        selection.profileId = null;
        selection.automaticSignIn = false;
        selection.revision += 1;
        selection.selectedAt = Date.now();
      });
      return this.getActiveProfileState(accountId, normalizedDeviceId);
    },
    async setAutomaticSignIn(accountId, deviceId, enabled) {
      const normalizedDeviceId = String(deviceId || `account:${accountId}`).slice(0, 128);
      store.mutateClientState((state) => {
        const selection = state.selections.find((item) => item.accountId === accountId && item.deviceId === normalizedDeviceId);
        if (!selection) throw Object.assign(new Error('Select a profile first.'), { status: 409, code: 'profile_required' });
        const profile = selection.profileId ? state.profiles.find((item) => item.id === selection.profileId) : null;
        if (enabled === true && (!profile || profile.hasPin || profile.kind === 'guest')) {
          throw Object.assign(new Error('Automatic sign-in requires an unlocked non-guest profile without a PIN.'), { status: 409, code: 'conflict' });
        }
        selection.automaticSignIn = enabled === true;
        selection.revision += 1;
      });
      return this.getActiveProfileState(accountId, normalizedDeviceId);
    },
    async assertSelectionRevision(accountId, deviceId, revision) {
      const active = await this.getActiveProfileState(accountId, deviceId);
      if (!Number.isSafeInteger(Number(revision)) || Number(revision) !== active.selectionRevision) {
        throw Object.assign(new Error('The profile selection changed.'), { status: 409, code: 'stale_profile_selection' });
      }
      return active;
    },
    async getProfilePreferences(profileId, accountId, canSeeAll = false) {
      const state = store.readClientState();
      requireProfile(state, profileId, accountId, canSeeAll);
      return { ...(state.profilePreferences.find((item) => item.profileId === profileId)?.preferences || {}) };
    },
    async saveProfilePreferences(profileId, preferences, accountId, canSeeAll = false) {
      return store.mutateClientState((state) => {
        requireProfile(state, profileId, accountId, canSeeAll);
        const index = state.profilePreferences.findIndex((item) => item.profileId === profileId);
        const current = index >= 0 ? state.profilePreferences[index].preferences : {};
        const next = { profileId, preferences: { ...current, ...canonicalPreferencesInput(preferences) }, updatedAt: Date.now() };
        if (index >= 0) state.profilePreferences[index] = next; else state.profilePreferences.push(next);
        return { ...next.preferences };
      });
    },
    async getProfileLists(profileId, kind, accountId, canSeeAll = false) {
      const state = store.readClientState();
      requireProfile(state, profileId, accountId, canSeeAll);
      if (kind && !['watchlist', 'favorite', 'watched'].includes(kind)) throw Object.assign(new Error('The profile list kind is invalid.'), { status: 400, code: 'invalid_request' });
      return state.profileListEntries.filter((item) => item.profileId === profileId && (!kind || item.kind === kind)).map((item) => ({ ...item }));
    },
    async setProfileListEntry(profileId, mediaId, kind, enabled, accountId, canSeeAll = false) {
      if (!['watchlist', 'favorite', 'watched'].includes(kind)) throw Object.assign(new Error('The profile list kind is invalid.'), { status: 400, code: 'invalid_request' });
      return store.mutateClientState((state) => {
        requireProfile(state, profileId, accountId, canSeeAll);
        state.profileListEntries = state.profileListEntries.filter((item) => !(item.profileId === profileId && item.mediaId === mediaId && item.kind === kind));
        if (enabled) state.profileListEntries.push({ profileId, mediaId: String(mediaId).slice(0, 128), kind, createdAt: Date.now() });
        return state.profileListEntries.filter((item) => item.profileId === profileId).map((item) => ({ ...item }));
      });
    },
    async getTrackPreferences(profileId, scope, accountId, canSeeAll = false) {
      const state = store.readClientState();
      requireProfile(state, profileId, accountId, canSeeAll);
      const item = state.trackPreferences.find((entry) => entry.profileId === profileId && entry.scope === scope);
      if (!item) return {};
      const { profileId: _profileId, scope: _scope, updatedAt: _updatedAt, preferences, ...canonical } = item;
      return { ...(preferences || canonical) };
    },
    async saveTrackPreferences(profileId, scope, preferences, accountId, canSeeAll = false) {
      return store.mutateClientState((state) => {
        requireProfile(state, profileId, accountId, canSeeAll);
        const normalizedScope = String(scope || '').trim().slice(0, 128);
        if (!normalizedScope) throw Object.assign(new Error('Track preference scope is required.'), { status: 400, code: 'invalid_request' });
        const next = { profileId, scope: normalizedScope, ...trackPreferencesInput(preferences), updatedAt: Date.now() };
        const index = state.trackPreferences.findIndex((item) => item.profileId === profileId && item.scope === next.scope);
        if (index >= 0) state.trackPreferences[index] = next; else state.trackPreferences.push(next);
        const { profileId: _profileId, scope: _scope, updatedAt: _updatedAt, ...saved } = next;
        return saved;
      });
    },
    async revokeDeviceAccess(deviceId) {
      const marker = `\u0000${String(deviceId)}\u0000`;
      for (const key of unlockedSelections.keys()) if (key.includes(marker)) unlockedSelections.delete(key);
      for (const key of pinFailures.keys()) if (key.includes(marker)) pinFailures.delete(key);
      return true;
    },
    async revokeAllAccess() {
      unlockedSelections.clear();
      pinFailures.clear();
      return true;
    },
    async listProfileAssignments(profileId, accountId, canSeeAll = false) {
      const state = store.readClientState();
      const { assignment } = requireProfile(state, profileId, accountId, canSeeAll);
      if (assignment.access !== 'manage') throw Object.assign(new Error('That account cannot manage this profile.'), { status: 403, code: 'profile_forbidden' });
      return state.assignments.filter((item) => item.profileId === profileId);
    },
    async assignProfile(profileId, targetAccountId, access, accountId, canSeeAll = false) {
      const normalizedAccountId = String(targetAccountId || '').trim().slice(0, 128);
      if (!normalizedAccountId) throw Object.assign(new Error('An account is required.'), { status: 400, code: 'invalid_request' });
      const normalizedAccess = assignmentAccess(access);
      if (!await validateAccount(normalizedAccountId)) throw Object.assign(new Error('The target account is unavailable or disabled.'), { status: 404, code: 'account_not_found' });
      return store.mutateClientState((state) => {
        const { assignment } = requireProfile(state, profileId, accountId, canSeeAll);
        if (assignment.access !== 'manage') throw Object.assign(new Error('That account cannot manage this profile.'), { status: 403, code: 'profile_forbidden' });
        const existing = state.assignments.find((item) => item.profileId === profileId && item.accountId === normalizedAccountId);
        if (existing) existing.access = normalizedAccess;
        else state.assignments.push({ profileId, accountId: normalizedAccountId, access: normalizedAccess, createdAt: Date.now() });
        return { ...(existing || state.assignments.at(-1)) };
      });
    },
    async listProgress(profileId, accountId, canSeeAll = false) {
      const state = store.readClientState();
      requireProfile(state, profileId, accountId, canSeeAll);
      return Object.fromEntries(state.progress.filter((item) => item.profileId === profileId).map((item) => [item.mediaId,
        { position: item.positionSeconds, duration: item.durationSeconds, watched: item.watched, updatedAt: item.updatedAt }]));
    },
    async getProgress(profileId, mediaId, accountId, canSeeAll = false) {
      const state = store.readClientState();
      requireProfile(state, profileId, accountId, canSeeAll);
      const item = state.progress.find((entry) => entry.profileId === profileId && entry.mediaId === String(mediaId));
      return item ? { position: item.positionSeconds, duration: item.durationSeconds, watched: item.watched, updatedAt: item.updatedAt } : null;
    },
    async saveProgress(profileId, mediaId, input, accountId, canSeeAll = false) {
      return store.mutateClientState((state) => {
        requireProfile(state, profileId, accountId, canSeeAll);
        const mediaKey = String(mediaId).slice(0, 128);
        const positionSeconds = safeNumber(input.position);
        const durationSeconds = safeNumber(input.duration);
        const next = {
          profileId, mediaId: mediaKey, positionSeconds, durationSeconds,
          watched: input.watched === true || (durationSeconds > 0 && positionSeconds / durationSeconds >= 0.9),
          updatedAt: Date.now(),
        };
        const index = state.progress.findIndex((item) => item.profileId === profileId && item.mediaId === mediaKey);
        if (index >= 0) state.progress[index] = next; else state.progress.push(next);
        const recent = state.progress.filter((item) => item.profileId === profileId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PROGRESS);
        state.progress = state.progress.filter((item) => item.profileId !== profileId).concat(recent);
        return { position: next.positionSeconds, duration: next.durationSeconds, watched: next.watched, updatedAt: next.updatedAt };
      });
    },
    async close() {},
  };
}

export const headlessClientStateFilename = STATE_FILENAME;
export const legacyHeadlessClientStateFilename = LEGACY_STATE_FILENAME;
