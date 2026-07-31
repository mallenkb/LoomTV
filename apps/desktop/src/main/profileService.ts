import { BrowserWindow } from 'electron';
import {
  clearDeviceProfileSelection,
  createGuestProfile,
  getDeviceProfileSelectionState,
  getDeviceSelectionRevision,
  getOwnerProfile,
  getProfile,
  getProfilePinCredentials,
  listProfiles,
  resetOwnerProfile as resetOwnerProfileRecord,
  selectDeviceProfile,
  setDeviceAutomaticSignIn,
  setProfilePinCredentials,
  type ProfileRecord,
} from './database';
import { hashProfilePin, verifyProfilePin } from './profilePin.ts';

export const DESKTOP_DEVICE_ID = 'desktop-primary';
const UNLOCK_TTL_MS = 4 * 60 * 60 * 1_000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1_000;

export type ProfileErrorCode =
  | 'profile_required'
  | 'stale_profile_selection'
  | 'profile_locked'
  | 'owner_required'
  | 'content_restricted';

export class ProfileError extends Error {
  constructor(
    public readonly code: ProfileErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

export type ProfileSummary = {
  id: string;
  name: string;
  avatarKey: string;
  colorKey: string;
  type: ProfileRecord['type'];
  hasPin: boolean;
  isGuest: boolean;
  sortOrder: number;
  lastUsedAt?: number;
};

export type ActiveProfileState = {
  profileId: string | null;
  selectionRequired: boolean;
  selectionRevision: number;
  automaticSignIn: boolean;
};

type FailureState = { failures: number; blockedUntil: number };

const unlockedUntil = new Map<string, number>();
const failures = new Map<string, FailureState>();

function unlockKey(deviceId: string, profileId: string): string {
  return `${deviceId}:${profileId}`;
}

function failureKey(deviceId: string, profileId: string, address: string): string {
  return `${deviceId}:${profileId}:${address}`;
}

function summary(profile: ProfileRecord): ProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    avatarKey: profile.avatarKey,
    colorKey: profile.colorKey,
    type: profile.type,
    hasPin: profile.hasPin,
    isGuest: profile.isGuest,
    sortOrder: profile.sortOrder,
    ...(profile.lastUsedAt ? { lastUsedAt: profile.lastUsedAt } : {}),
  };
}

export function profileSummaries(deviceId?: string): ProfileSummary[] {
  return listProfiles(deviceId).map(summary);
}

function isUnlocked(deviceId: string, profileId: string): boolean {
  const expiry = unlockedUntil.get(unlockKey(deviceId, profileId)) ?? 0;
  if (expiry > Date.now()) return true;
  unlockedUntil.delete(unlockKey(deviceId, profileId));
  return false;
}

function markUnlocked(deviceId: string, profileId: string): void {
  unlockedUntil.set(unlockKey(deviceId, profileId), Date.now() + UNLOCK_TTL_MS);
}

async function unlockProfile(deviceId: string, profile: ProfileRecord, pin: string | undefined, address: string): Promise<void> {
  const credentials = getProfilePinCredentials(profile.id);
  if (!credentials || isUnlocked(deviceId, profile.id)) return;

  const key = failureKey(deviceId, profile.id, address);
  const state = failures.get(key);
  const now = Date.now();
  if (state && state.blockedUntil > now) {
    throw new ProfileError('profile_locked', 'That PIN could not be accepted.', state.blockedUntil - now);
  }

  if (!pin || !await verifyProfilePin(pin, credentials)) {
    const failureCount = (state?.failures ?? 0) + 1;
    const delay = failureCount < 5
      ? 0
      : Math.min(MAX_RETRY_DELAY_MS, 30_000 * 2 ** (failureCount - 5));
    failures.set(key, { failures: failureCount, blockedUntil: now + delay });
    throw new ProfileError('profile_locked', 'That PIN could not be accepted.', delay || undefined);
  }

  failures.delete(key);
  markUnlocked(deviceId, profile.id);
}

export function getActiveProfileState(deviceId: string): ActiveProfileState {
  const selection = getDeviceProfileSelectionState(deviceId);
  if (selection && getProfile(selection.profileId)) {
    return {
      profileId: selection.profileId,
      selectionRequired: false,
      selectionRevision: selection.selectionRevision,
      automaticSignIn: selection.automaticSignIn,
    };
  }

  return {
    profileId: null,
    selectionRequired: true,
    selectionRevision: getDeviceSelectionRevision(deviceId),
    automaticSignIn: false,
  };
}

export function getDesktopActiveProfileId(): string | null {
  return getActiveProfileState(DESKTOP_DEVICE_ID).profileId;
}

export function getDesktopActiveProfileState(): ActiveProfileState {
  return getActiveProfileState(DESKTOP_DEVICE_ID);
}

export function prepareDesktopProfileStartup(): void {
  const selection = getDeviceProfileSelectionState(DESKTOP_DEVICE_ID);
  if (!selection) return;
  const profile = getProfile(selection.profileId);
  if (!profile || profile.isGuest) clearDeviceProfileSelection(DESKTOP_DEVICE_ID);
}

export async function selectProfile(
  deviceId: string,
  profileId: string,
  pin?: string,
  address = 'local',
): Promise<ProfileSummary> {
  const profile = getProfile(profileId);
  if (!profile) throw new ProfileError('profile_required', 'That profile no longer exists.');
  if (profile.isGuest && profile.guestDeviceId !== deviceId) {
    throw new ProfileError('profile_required', 'That Guest session is no longer available.');
  }
  await unlockProfile(deviceId, profile, pin, address);
  const current = getDeviceProfileSelectionState(deviceId);
  if (current?.profileId !== profileId) clearGuestSelection(deviceId);
  const selected = selectDeviceProfile(deviceId, profileId);
  broadcastActiveProfileChanged(deviceId);
  return summary(selected);
}

export function selectDesktopProfile(profileId: string, pin?: string): Promise<ProfileSummary> {
  return selectProfile(DESKTOP_DEVICE_ID, profileId, pin);
}

export function createAndSelectGuest(deviceId: string): ProfileSummary {
  clearGuestSelection(deviceId);
  const guest = createGuestProfile(deviceId);
  broadcastProfilesChanged();
  broadcastActiveProfileChanged(deviceId);
  return summary(guest);
}

export function clearGuestSelection(deviceId: string): void {
  const selection = getDeviceProfileSelectionState(deviceId);
  if (!selection) return;
  const profile = getProfile(selection.profileId);
  if (!profile?.isGuest) return;
  unlockedUntil.delete(unlockKey(deviceId, profile.id));
  clearDeviceProfileSelection(deviceId);
}

export function lockProfile(deviceId: string): ActiveProfileState {
  const selection = getDeviceProfileSelectionState(deviceId);
  if (selection) unlockedUntil.delete(unlockKey(deviceId, selection.profileId));
  clearDeviceProfileSelection(deviceId);
  broadcastActiveProfileChanged(deviceId);
  return getActiveProfileState(deviceId);
}

/** Remove every profile capability associated with a revoked paired device. */
export function revokeDeviceProfileAccess(deviceId: string): void {
  const prefix = `${deviceId}:`;
  for (const key of unlockedUntil.keys()) {
    if (key.startsWith(prefix)) unlockedUntil.delete(key);
  }
  for (const key of failures.keys()) {
    if (key.startsWith(prefix)) failures.delete(key);
  }
  clearDeviceProfileSelection(deviceId);
  broadcastActiveProfileChanged(deviceId);
}

export function requireDesktopProfileId(expectedProfileId?: string): string {
  const profileId = getDesktopActiveProfileId();
  if (!profileId) throw new ProfileError('profile_required', 'No profile is selected on this device.');
  if (expectedProfileId && expectedProfileId !== profileId) {
    throw new ProfileError('stale_profile_selection', 'The active profile changed before this request completed.');
  }
  return profileId;
}

export function resolveLanProfileId(deviceId: string | null, requireExplicitSelection = false): string {
  if (!deviceId) return requireDesktopProfileId();
  const selection = getDeviceProfileSelectionState(deviceId);
  if (selection && getProfile(selection.profileId)) return selection.profileId;
  if (requireExplicitSelection) throw new ProfileError('profile_required', 'Select a profile to continue.');
  const owner = getOwnerProfile();
  if (owner) {
    selectDeviceProfile(deviceId, owner.id);
    return owner.id;
  }
  const first = listProfiles()[0];
  if (first) {
    selectDeviceProfile(deviceId, first.id);
    return first.id;
  }
  throw new ProfileError('profile_required', 'No profiles exist.');
}

export function requireOwner(deviceId = DESKTOP_DEVICE_ID): ProfileRecord {
  const selection = getDeviceProfileSelectionState(deviceId);
  const profile = selection ? getProfile(selection.profileId) : null;
  if (!profile || profile.type !== 'owner') {
    throw new ProfileError('owner_required', 'Switch to the Owner profile to manage LoomTV.');
  }
  if (profile.hasPin && !isUnlocked(deviceId, profile.id)) {
    throw new ProfileError('owner_required', 'Unlock the Owner profile to manage LoomTV.');
  }
  return profile;
}

export async function changeProfilePin(profileId: string, pin: string | null): Promise<ProfileSummary> {
  const activeProfileId = requireDesktopProfileId();
  const existingProfile = getProfile(profileId);
  if (!existingProfile) throw new Error('That profile no longer exists.');
  if (existingProfile.isGuest) throw new Error('Guest profiles cannot use a PIN.');
  if (activeProfileId !== profileId) {
    requireOwner();
  } else if (existingProfile.hasPin && !isUnlocked(DESKTOP_DEVICE_ID, profileId)) {
    throw new ProfileError('owner_required', 'Unlock this profile before changing its PIN.');
  }
  const credentials = pin === null ? null : await hashProfilePin(pin);
  const profile = setProfilePinCredentials(profileId, credentials);
  if (pin === null) unlockedUntil.delete(unlockKey(DESKTOP_DEVICE_ID, profileId));
  else markUnlocked(DESKTOP_DEVICE_ID, profileId);
  broadcastProfilesChanged();
  return summary(profile);
}

export function setDesktopAutomaticSignIn(enabled: boolean): ActiveProfileState {
  return setAutomaticSignIn(DESKTOP_DEVICE_ID, enabled);
}

export function setAutomaticSignIn(deviceId: string, enabled: boolean): ActiveProfileState {
  setDeviceAutomaticSignIn(deviceId, enabled);
  broadcastActiveProfileChanged(deviceId);
  return getActiveProfileState(deviceId);
}

export function resetOwnerProfile(confirmation: string): ProfileSummary {
  if (confirmation !== 'RESET') throw new Error('Enter RESET to confirm.');
  const owner = resetOwnerProfileRecord();
  unlockedUntil.clear();
  failures.clear();
  selectDeviceProfile(DESKTOP_DEVICE_ID, owner.id);
  broadcastProfilesChanged();
  broadcastActiveProfileChanged(DESKTOP_DEVICE_ID);
  return summary(owner);
}

export function broadcastProfilesChanged(): void {
  const profiles = profileSummaries();
  const selectionRevision = getDeviceSelectionRevision(DESKTOP_DEVICE_ID);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('profiles:changed', { profiles, selectionRevision });
  }
}

export function broadcastActiveProfileChanged(deviceId: string): void {
  if (deviceId !== DESKTOP_DEVICE_ID) return;
  const state = getDesktopActiveProfileState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('profile:active-changed', state);
  }
}
