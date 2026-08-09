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
import { flushProgressWrites, setProgressProfile } from '@/lib/progress';

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
  const [watchedOverrides, setWatchedOverrides] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedThisSession, setSelectedThisSession] = useState(false);
  const [ownerSessionAuthorized, setOwnerSessionAuthorized] = useState(false);
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const watchedMutationRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);

  const hydratePersonalState = useCallback(async (profileId: string | null) => {
    const hydrationGeneration = ++generationRef.current;
    setGeneration(hydrationGeneration);
    watchedMutationRef.current.clear();
    setWatchedOverrides({});
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
    if (!mountedRef.current || hydrationGeneration !== generationRef.current) return;
    setPreferences(nextPreferences);
    setLists(nextLists);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const [nextProfiles, nextActiveState] = await Promise.all([
          desktopApi.listProfiles(),
          desktopApi.getActiveProfileState(),
        ]);
        if (!mountedRef.current) return;
        setProfiles(nextProfiles);
        setActiveState(nextActiveState);
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
    // Remote hosts have no push channel for profile edits, so poll while the
    // window is visible. Comparing the incoming payload against the last one we
    // applied avoids both a redundant re-render and re-serializing the current
    // list every tick.
    let lastRemoteProfilesSignature = '';
    const remoteProfileRefresh = desktopApi.isRemoteLibraryMode()
      ? window.setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          void desktopApi.listProfiles().then((nextProfiles) => {
            if (!mountedRef.current) return;
            const signature = JSON.stringify(nextProfiles);
            if (signature === lastRemoteProfilesSignature) return;
            lastRemoteProfilesSignature = signature;
            setProfiles(nextProfiles);
          }).catch(() => undefined);
        }, 5_000)
      : null;
    return () => {
      mountedRef.current = false;
      unsubscribeProfiles();
      unsubscribeActive();
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
    setProfiles(nextProfiles);
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
    const saved = await desktopApi.saveProfilePreferences(patch, expectedProfileId);
    if (writeGeneration === generationRef.current) setPreferences(saved);
  }, [activeState.profileId]);

  const setListEntry = useCallback(async (mediaId: string, kind: ProfileListKind, present: boolean) => {
    const expectedProfileId = activeState.profileId || undefined;
    const writeGeneration = generationRef.current;
    const saved = await desktopApi.setProfileListEntry(mediaId, kind, present, expectedProfileId);
    if (writeGeneration === generationRef.current) setLists(saved);
  }, [activeState.profileId]);

  const watchedKeys = useMemo(
    () => {
      const next = new Set(lists.filter((entry) => entry.kind === 'watched').map((entry) => entry.mediaId));
      for (const [mediaId, present] of Object.entries(watchedOverrides)) {
        if (present) next.add(mediaId);
        else next.delete(mediaId);
      }
      return next;
    },
    [lists, watchedOverrides],
  );

  const setWatched = useCallback(async (mediaId: string, present: boolean) => {
    const expectedProfileId = activeState.profileId || undefined;
    const writeGeneration = generationRef.current;
    const previousPresent = watchedKeys.has(mediaId);
    const mutationId = (watchedMutationRef.current.get(mediaId) || 0) + 1;
    watchedMutationRef.current.set(mediaId, mutationId);

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
    lists,
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
    profiles, activeProfile, activeState, preferences, lists, isLoading, loadError, gateOpen, gateIntent, clearGateIntent,
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
