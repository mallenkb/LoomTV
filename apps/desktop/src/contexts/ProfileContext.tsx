import { replaceEqualDeep } from '@tanstack/react-query';
import { invalidateDesktopData, setQueryProfile } from '@/lib/queryClient';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  desktopApi,
  type ActiveProfileState,
  type ProfileCreateInput,
  type ProfileListEntry,
  type ProfileListKind,
  type ProfilePreferences,
  type ProfileRestrictions,
  type ProfileSummary,
  type ProfileTransferResult,
  type ProfileUpdateInput,
} from '@/lib/desktopApi';
import { useConfirm } from '@/components/ConfirmProvider';
import { hasActivePlayback, shutdownActivePlayback } from '@/lib/playbackLifecycle';
import { flushProgressWrites, refreshProgressFromDatabase, setProgressProfile } from '@/lib/progress';

/**
 * Optional destination when opening the gate: jump straight into edit mode,
 * optionally with a specific profile's editor (or the new-profile editor)
 * already open. Lets Settings deep-link into management without extra hops.
 */
export type GateIntent =
  | { mode: 'edit'; editProfileId?: string | 'new'; returnTo?: string }
  | { mode: 'select'; profileId: string; returnTo?: string };

type ProfileContextValue = {
  profiles: ProfileSummary[];
  activeProfile: ProfileSummary | null;
  activeState: ActiveProfileState;
  preferences: ProfilePreferences;
  lists: ProfileListEntry[];
  watchedKeys: ReadonlySet<string>;
  isLoading: boolean;
  loadError: string | null;
  gateOpen: boolean;
  gateIntent: GateIntent | null;
  clearGateIntent: () => void;
  generation: number;
  canManageProfiles: boolean;
  canCreateProfiles: boolean;
  openGate: (intent?: GateIntent) => void;
  closeGate: () => void;
  selectProfile: (profileId: string, pin?: string) => Promise<void>;
  selectGuestProfile: () => Promise<void>;
  lockProfile: () => Promise<void>;
  createProfile: (input: ProfileCreateInput) => Promise<ProfileSummary>;
  updateProfile: (profileId: string, patch: ProfileUpdateInput) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  reorderProfiles: (profileIds: string[]) => Promise<void>;
  changeProfilePin: (profileId: string, pin: string | null) => Promise<void>;
  resetOwnerProfile: (confirmation: string) => Promise<void>;
  setAutomaticSignIn: (enabled: boolean) => Promise<void>;
  savePreferences: (patch: ProfilePreferences) => Promise<void>;
  getRestrictions: (profileId: string) => Promise<ProfileRestrictions>;
  saveRestrictions: (profileId: string, input: Omit<ProfileRestrictions, 'revision'>) => Promise<ProfileRestrictions>;
  setListEntry: (mediaId: string, kind: ProfileListKind, present: boolean) => Promise<void>;
  setWatched: (mediaId: string, present: boolean) => Promise<void>;
  setWatchedEntries: (mediaIds: readonly string[], present: boolean) => Promise<void>;
  exportProfile: (profileId: string) => Promise<ProfileTransferResult>;
  importProfile: () => Promise<ProfileTransferResult>;
};

const EMPTY_ACTIVE_STATE: ActiveProfileState = {
  profileId: null,
  selectionRequired: true,
  selectionRevision: 0,
  automaticSignIn: false,
};

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [activeState, setActiveState] = useState<ActiveProfileState>(EMPTY_ACTIVE_STATE);
  const [preferences, setPreferences] = useState<ProfilePreferences>({});
  const [lists, setLists] = useState<ProfileListEntry[]>([]);
  const [listOverrides, setListOverrides] = useState<Record<string, { entry: ProfileListEntry; present: boolean; revision: number }>>({});
  const listRevision = useRef(0);
  const visibleLists = useMemo(() => {
    const entries = new Map(lists.map(entry => [`${entry.kind}:${entry.mediaId}`, entry]));
    for (const [key, override] of Object.entries(listOverrides)) {
      if (override.present) entries.set(key, override.entry);
      else entries.delete(key);
    }
    return Array.from(entries.values());
  }, [lists, listOverrides]);
  const [watchedOverrides, setWatchedOverrides] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedThisSession, setSelectedThisSession] = useState(false);
  const [ownerSessionAuthorized, setOwnerSessionAuthorized] = useState(false);
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const profilesRef = useRef<ProfileSummary[]>([]);
  const activeStateRef = useRef<ActiveProfileState>(EMPTY_ACTIVE_STATE);
  const watchedMutationRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);
  const personalWriteRevision = useRef(0);
  const pendingPersonalWrites = useRef(0);

  const hydratePersonalState = useCallback(async (profileId: string | null) => {
    const hydrationGeneration = ++generationRef.current;
    setGeneration(hydrationGeneration);
    const writeRevision = personalWriteRevision.current;
    const hadPendingWrites = pendingPersonalWrites.current > 0;
    setPreferences({});
    setLists([]);
    watchedMutationRef.current.clear();
    setListOverrides({});
    setWatchedOverrides({});
    setQueryProfile(profileId);
    await setProgressProfile(profileId);
    if (hydrationGeneration !== generationRef.current) return;
    if (!profileId) {
      setPreferences({});
      setLists([]);
      return;
    }
    const [nextPreferences, nextLists] = await Promise.all([
      desktopApi.getProfilePreferences(),
      desktopApi.getProfileLists(),
    ]);
    if (!mountedRef.current || hydrationGeneration !== generationRef.current
      || hadPendingWrites || pendingPersonalWrites.current > 0 || writeRevision !== personalWriteRevision.current) return;
    setPreferences(current => replaceEqualDeep(current, nextPreferences));
    setLists(current => replaceEqualDeep(current, nextLists));
  }, []);

  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  useEffect(() => {
    activeStateRef.current = activeState;
  }, [activeState]);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const [nextProfiles, nextActiveState] = await Promise.all([
          desktopApi.listProfiles(),
          desktopApi.getActiveProfileState(),
        ]);
        if (!mountedRef.current) return;
        setProfiles(current => replaceEqualDeep(current, nextProfiles));
        setActiveState(current => replaceEqualDeep(current, nextActiveState));
        setLoadError(null);
        const active = nextProfiles.find((profile) => profile.id === nextActiveState.profileId);
        const mayEnter = Boolean(active && nextActiveState.automaticSignIn);
        setSelectedThisSession(mayEnter);
        setOwnerSessionAuthorized(Boolean(mayEnter && active?.type === 'owner'));
        if (mayEnter) await hydratePersonalState(nextActiveState.profileId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The profile session could not be loaded.';
        console.error('Failed to load profile session:', error);
        if (mountedRef.current) setLoadError(message);
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
    })();

    const unsubscribeProfiles = desktopApi.onProfilesChanged((event) => {
      if (mountedRef.current) setProfiles(event.profiles);
    });
    const unsubscribeActive = desktopApi.onActiveProfileChanged((state) => {
      if (mountedRef.current) setActiveState(state);
    });
    let disposed = false;
    let refreshPending = false;
    const refreshBrowserHostState = async () => {
      if (disposed || refreshPending || document.visibilityState !== 'visible') return;
      const refreshGeneration = generationRef.current;
      const previousState = activeStateRef.current;
      refreshPending = true;
      try {
        const [nextProfiles, nextActiveState] = await Promise.all([
          desktopApi.listProfiles(),
          desktopApi.getActiveProfileState(),
        ]);
        if (disposed || !mountedRef.current || refreshGeneration !== generationRef.current || previousState !== activeStateRef.current) return;
        const stableProfiles = replaceEqualDeep(profilesRef.current, nextProfiles);
        const stableActiveState = replaceEqualDeep(activeStateRef.current, nextActiveState);
        const previousProfileId = activeStateRef.current.profileId;
        profilesRef.current = stableProfiles;
        activeStateRef.current = stableActiveState;
        setProfiles(stableProfiles);
        setActiveState(stableActiveState);
        if (nextActiveState.profileId !== previousProfileId) {
          const active = nextProfiles.find((profile) => profile.id === nextActiveState.profileId);
          setSelectedThisSession(Boolean(active));
          setOwnerSessionAuthorized(active?.type === 'owner');
          await hydratePersonalState(nextActiveState.profileId);
          return;
        }
        invalidateDesktopData(['getProfilePreferences', 'getProfileLists', 'getProgress']);
        if (!nextActiveState.profileId) return;
        const hydrationGeneration = generationRef.current;
        const writeRevision = personalWriteRevision.current;
        const hadPendingWrites = pendingPersonalWrites.current > 0;
        const [nextPreferences, nextLists] = await Promise.all([
          desktopApi.getProfilePreferences(),
          desktopApi.getProfileLists(),
          refreshProgressFromDatabase(),
        ]);
        if (disposed || !mountedRef.current || hydrationGeneration !== generationRef.current
          || hadPendingWrites || pendingPersonalWrites.current > 0 || writeRevision !== personalWriteRevision.current) return;
        setPreferences(current => replaceEqualDeep(current, nextPreferences));
        setLists(current => replaceEqualDeep(current, nextLists));
      } catch {
        // Preserve the last host snapshot until the next visible refresh.
      } finally {
        refreshPending = false;
      }
    };
    const handleBrowserFocus = () => { void refreshBrowserHostState(); };
    window.addEventListener('focus', handleBrowserFocus);
    document.addEventListener('visibilitychange', handleBrowserFocus);
    const remoteProfileRefresh = desktopApi.isRemoteLibraryMode()
      ? window.setInterval(handleBrowserFocus, 30_000)
      : null;
    return () => {
      disposed = true;
      mountedRef.current = false;
      generationRef.current += 1;
      unsubscribeProfiles();
      unsubscribeActive();
      window.removeEventListener('focus', handleBrowserFocus);
      document.removeEventListener('visibilitychange', handleBrowserFocus);
      if (remoteProfileRefresh !== null) window.clearInterval(remoteProfileRefresh);
    };
  }, [hydratePersonalState]);

  const prepareForSwitch = useCallback(async (profileId: string) => {
    if (activeState.profileId === profileId) return;
    if (hasActivePlayback()) {
      const confirmed = await confirm({
        title: 'Switch profiles?',
        description: 'Playback will stop. Your current position is saved first, so you can pick this title back up later.',
        confirmLabel: 'Stop and switch',
      });
      if (!confirmed) throw new Error('Profile switch cancelled.');
      await shutdownActivePlayback();
    }
    await flushProgressWrites();
  }, [activeState.profileId, confirm]);

  const selectProfile = useCallback(async (profileId: string, pin?: string) => {
    await prepareForSwitch(profileId);
    const selected = await desktopApi.selectProfile(profileId, pin);
    if (!mountedRef.current) return;
    const state = await desktopApi.getActiveProfileState();
    setActiveState(state);
    setSelectedThisSession(true);
    setOwnerSessionAuthorized(selected.type === 'owner');
    await hydratePersonalState(selected.id);
  }, [hydratePersonalState, prepareForSwitch]);

  const selectGuestProfile = useCallback(async () => {
    await prepareForSwitch('__guest__');
    const selected = await desktopApi.selectGuestProfile();
    if (!mountedRef.current) return;
    setProfiles((current) => [...current.filter((profile) => !profile.isGuest), selected]);
    setActiveState(await desktopApi.getActiveProfileState());
    setSelectedThisSession(true);
    setOwnerSessionAuthorized(false);
    await hydratePersonalState(selected.id);
  }, [hydratePersonalState, prepareForSwitch]);

  const refreshProfiles = useCallback((nextProfiles: ProfileSummary[]) => {
    setProfiles(current => replaceEqualDeep(current, nextProfiles));
    setActiveState((current) => current.profileId && nextProfiles.some((profile) => profile.id === current.profileId)
      ? current
      : EMPTY_ACTIVE_STATE);
  }, []);

  const createProfile = useCallback(async (input: ProfileCreateInput) => {
    const nextProfiles = await desktopApi.createProfile(input);
    refreshProfiles(nextProfiles);
    const created = nextProfiles.reduce((latest, profile) => profile.sortOrder > latest.sortOrder ? profile : latest);
    return created;
  }, [refreshProfiles]);

  const updateProfile = useCallback(async (profileId: string, patch: ProfileUpdateInput) => {
    refreshProfiles(await desktopApi.updateProfile(profileId, patch));
  }, [refreshProfiles]);

  const deleteProfile = useCallback(async (profileId: string) => {
    refreshProfiles(await desktopApi.deleteProfile(profileId));
  }, [refreshProfiles]);

  const reorder = useCallback(async (profileIds: string[]) => {
    refreshProfiles(await desktopApi.reorderProfiles(profileIds));
  }, [refreshProfiles]);

  const changePin = useCallback(async (profileId: string, pin: string | null) => {
    const updated = await desktopApi.changeProfilePin(profileId, pin);
    setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
  }, []);

  const resetOwner = useCallback(async (confirmation: string) => {
    const owner = await desktopApi.resetOwnerProfile(confirmation);
    setProfiles((current) => current.map((profile) => profile.type === 'owner' ? owner : profile));
    setActiveState(await desktopApi.getActiveProfileState());
    setSelectedThisSession(true);
    setOwnerSessionAuthorized(true);
    await hydratePersonalState(owner.id);
  }, [hydratePersonalState]);

  const lock = useCallback(async () => {
    await shutdownActivePlayback();
    await flushProgressWrites();
    const state = await desktopApi.lockProfile();
    setActiveState(state);
    setSelectedThisSession(false);
    setOwnerSessionAuthorized(false);
    await hydratePersonalState(null);
  }, [hydratePersonalState]);

  const setAutomaticSignIn = useCallback(async (enabled: boolean) => {
    setActiveState(await desktopApi.setAutomaticProfileSignIn(enabled));
  }, []);

  const savePreferences = useCallback(async (patch: ProfilePreferences) => {
    const expectedProfileId = activeState.profileId || undefined;
    const writeGeneration = generationRef.current;
    personalWriteRevision.current += 1;
    pendingPersonalWrites.current += 1;
    try {
      const saved = await desktopApi.saveProfilePreferences(patch, expectedProfileId);
      if (mountedRef.current && writeGeneration === generationRef.current) setPreferences(saved);
    } finally {
      pendingPersonalWrites.current -= 1;
      personalWriteRevision.current += 1;
    }
  }, [activeState.profileId]);

  const setListEntry = useCallback(async (mediaId: string, kind: ProfileListKind, present: boolean) => {
    const expectedProfileId = activeState.profileId || undefined;
    const writeGeneration = generationRef.current;
    const revision = ++listRevision.current;
    personalWriteRevision.current += 1;
    pendingPersonalWrites.current += 1;
    const key = `${kind}:${mediaId}`;
    setListOverrides(current => ({ ...current, [key]: { entry: { mediaId, kind, createdAt: Date.now() }, present, revision } }));
    try {
      const saved = await desktopApi.setProfileListEntry(mediaId, kind, present, expectedProfileId);
      if (writeGeneration === generationRef.current) setLists(saved);
    } finally {
      pendingPersonalWrites.current -= 1;
      personalWriteRevision.current += 1;
      if (writeGeneration === generationRef.current) setListOverrides(current => {
        if (current[key]?.revision !== revision) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }, [activeState.profileId]);

  const watchedKeys = useMemo(
    () => {
      const next = new Set(visibleLists.filter((entry) => entry.kind === 'watched').map((entry) => entry.mediaId));
      for (const [mediaId, present] of Object.entries(watchedOverrides)) {
        if (present) next.add(mediaId);
        else next.delete(mediaId);
      }
      return next;
    },
    [visibleLists, watchedOverrides],
  );

  const setWatched = useCallback(async (mediaId: string, present: boolean) => {
    const expectedProfileId = activeState.profileId || undefined;
    const writeGeneration = generationRef.current;
    const previousPresent = watchedKeys.has(mediaId);
    const mutationId = (watchedMutationRef.current.get(mediaId) || 0) + 1;
    watchedMutationRef.current.set(mediaId, mutationId);
    personalWriteRevision.current += 1;
    pendingPersonalWrites.current += 1;

    // Keep the icon and My List responsive while the profile store persists.
    setWatchedOverrides((current) => ({ ...current, [mediaId]: present }));

    try {
      const saved = await desktopApi.setProfileListEntry(mediaId, 'watched', present, expectedProfileId);
      const isLatestMutation = watchedMutationRef.current.get(mediaId) === mutationId;
      if (!mountedRef.current || writeGeneration !== generationRef.current || !isLatestMutation) return;
      watchedMutationRef.current.delete(mediaId);
      setLists(saved);
      setWatchedOverrides((current) => {
        if (!(mediaId in current) || current[mediaId] !== present) return current;
        const next = { ...current };
        delete next[mediaId];
        return next;
      });
    } catch (error) {
      const isLatestMutation = watchedMutationRef.current.get(mediaId) === mutationId;
      if (!mountedRef.current || writeGeneration !== generationRef.current || !isLatestMutation) return;
      watchedMutationRef.current.delete(mediaId);
      setWatchedOverrides((current) => ({ ...current, [mediaId]: previousPresent }));
      console.error('Failed to update watched state:', error);
    } finally {
      pendingPersonalWrites.current -= 1;
      personalWriteRevision.current += 1;
    }
  }, [activeState.profileId, watchedKeys]);

  const setWatchedEntries = useCallback(async (mediaIds: readonly string[], present: boolean) => {
    await Promise.all(mediaIds.map((mediaId) => setWatched(mediaId, present)));
  }, [setWatched]);

  const exportProfile = useCallback((profileId: string) => desktopApi.exportProfile(profileId), []);
  const importProfile = useCallback(async () => {
    const result = await desktopApi.importProfile();
    if (result.ok) refreshProfiles(await desktopApi.listProfiles());
    return result;
  }, [refreshProfiles]);

  const [gateIntent, setGateIntent] = useState<GateIntent | null>(null);
  const openGate = useCallback((intent?: GateIntent) => {
    setGateIntent(intent ?? null);
    setSelectedThisSession(false);
  }, []);
  const clearGateIntent = useCallback(() => setGateIntent(null), []);
  const closeGate = useCallback(() => {
    setGateIntent(null);
    if (activeState.profileId) setSelectedThisSession(true);
  }, [activeState.profileId]);
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeState.profileId) || null,
    [profiles, activeState.profileId],
  );
  const gateOpen = !isLoading && (!selectedThisSession || !activeProfile);
  const canManageProfiles = Boolean(
    window.desktopApi
    && !desktopApi.isRemoteLibraryMode()
    && ownerSessionAuthorized
    && activeProfile?.type === 'owner',
  );
  const canCreateProfiles = canManageProfiles || desktopApi.isRemoteLibraryMode();

  const value = useMemo<ProfileContextValue>(() => ({
    profiles,
    activeProfile,
    activeState,
    preferences,
    lists: visibleLists,
    watchedKeys,
    isLoading,
    loadError,
    gateOpen,
    gateIntent,
    clearGateIntent,
    generation,
    canManageProfiles,
    canCreateProfiles,
    openGate,
    closeGate,
    selectProfile,
    selectGuestProfile,
    lockProfile: lock,
    createProfile,
    updateProfile,
    deleteProfile,
    reorderProfiles: reorder,
    changeProfilePin: changePin,
    resetOwnerProfile: resetOwner,
    setAutomaticSignIn,
    savePreferences,
    getRestrictions: desktopApi.getProfileRestrictions,
    saveRestrictions: desktopApi.saveProfileRestrictions,
    setListEntry,
    setWatched,
    setWatchedEntries,
    exportProfile,
    importProfile,
  }), [
    profiles, activeProfile, activeState, preferences, visibleLists, isLoading, loadError, gateOpen, gateIntent, clearGateIntent,
    generation, canManageProfiles, canCreateProfiles,
    openGate, closeGate, selectProfile, selectGuestProfile, lock, createProfile, updateProfile,
    deleteProfile, reorder, changePin, resetOwner, setAutomaticSignIn, savePreferences, setListEntry, setWatched,
    setWatchedEntries, watchedKeys,
    exportProfile, importProfile,
  ]);

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfiles(): ProfileContextValue {
  const context = useContext(ProfileContext);
  if (!context) throw new Error('useProfiles must be used within a ProfileProvider.');
  return context;
}
