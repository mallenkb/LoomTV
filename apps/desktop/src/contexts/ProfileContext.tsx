import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { desktopApi, type ProfileCreateInput, type ProfileSummary, type ProfileUpdateInput } from '@/lib/desktopApi';
import { resetProgressForProfileSwitch } from '@/lib/progress';

type ProfileContextValue = {
  profiles: ProfileSummary[];
  activeProfile: ProfileSummary | null;
  isLoading: boolean;
  /** Whether the full-window Who's Watching gate is showing. */
  gateOpen: boolean;
  /** Re-opens the gate, e.g. from the sidebar Switch Profile action. */
  openGate: () => void;
  selectProfile: (profileId: string) => Promise<void>;
  createProfile: (input: ProfileCreateInput) => Promise<void>;
  updateProfile: (profileId: string, patch: ProfileUpdateInput) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
};

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Selecting is per app launch: with several profiles the picker is the front
  // door every cold start, like Netflix, even when a last-used profile exists.
  const [selectedThisSession, setSelectedThisSession] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const [nextProfiles, activeState] = await Promise.all([
          desktopApi.listProfiles(),
          desktopApi.getActiveProfileState(),
        ]);
        if (!mountedRef.current) return;
        setProfiles(nextProfiles);
        setActiveProfileId(activeState.profileId);
        if (nextProfiles.length <= 1) setSelectedThisSession(true);
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
    })();
    const unsubscribe = desktopApi.onProfilesChanged((nextProfiles) => {
      if (mountedRef.current) setProfiles(nextProfiles);
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, []);

  const selectProfile = useCallback(async (profileId: string) => {
    const isSwitch = activeProfileId !== null && activeProfileId !== profileId;
    const selected = await desktopApi.selectProfile(profileId);
    if (!mountedRef.current) return;
    setActiveProfileId(selected.id);
    setSelectedThisSession(true);
    if (isSwitch) await resetProgressForProfileSwitch();
  }, [activeProfileId]);

  const refreshProfiles = useCallback((nextProfiles: ProfileSummary[]) => {
    setProfiles(nextProfiles);
    setActiveProfileId((current) => (current && nextProfiles.some((profile) => profile.id === current) ? current : null));
  }, []);

  const createProfile = useCallback(async (input: ProfileCreateInput) => {
    refreshProfiles(await desktopApi.createProfile(input));
  }, [refreshProfiles]);

  const updateProfile = useCallback(async (profileId: string, patch: ProfileUpdateInput) => {
    refreshProfiles(await desktopApi.updateProfile(profileId, patch));
  }, [refreshProfiles]);

  const deleteProfile = useCallback(async (profileId: string) => {
    refreshProfiles(await desktopApi.deleteProfile(profileId));
  }, [refreshProfiles]);

  const openGate = useCallback(() => {
    setSelectedThisSession(false);
  }, []);

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) || null,
    [profiles, activeProfileId],
  );

  const gateOpen = !isLoading && profiles.length > 1 && (!selectedThisSession || !activeProfile);

  const value = useMemo<ProfileContextValue>(() => ({
    profiles,
    activeProfile,
    isLoading,
    gateOpen,
    openGate,
    selectProfile,
    createProfile,
    updateProfile,
    deleteProfile,
  }), [profiles, activeProfile, isLoading, gateOpen, openGate, selectProfile, createProfile, updateProfile, deleteProfile]);

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfiles(): ProfileContextValue {
  const context = useContext(ProfileContext);
  if (!context) throw new Error('useProfiles must be used within a ProfileProvider.');
  return context;
}
