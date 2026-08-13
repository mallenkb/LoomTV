import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import type {
  Connection,
  DiscoveredHost,
  MobileProfile,
  MobileProfileListEntry,
  SavedConnection,
  StoredProgress,
} from './mobileDomain';
import { mobileConnectionLifecycleAction } from './mobileLifecycle';
import { useMobileBonjourDiscovery } from './useMobileBonjourDiscovery';
import { useMobileOfflinePersistence } from './useMobileOfflinePersistence';

export type MobileProfilePickerMode = 'startup' | 'lock' | 'profile-required' | 'voluntary';

export function useMobileConnectionSessionController({
  cancelActiveRequests,
  stopSecureTransport,
}: {
  cancelActiveRequests: () => void;
  stopSecureTransport: () => Promise<void> | void;
}) {
  const [baseUrl, setBaseUrl] = useState('');
  const [shareCode, setShareCode] = useState('');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [profiles, setProfiles] = useState<MobileProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<MobileProfile | null>(null);
  const [automaticProfileSignIn, setAutomaticProfileSignIn] = useState(false);
  const [profilePickerMode, setProfilePickerMode] = useState<MobileProfilePickerMode | null>(null);
  const [profilePinTarget, setProfilePinTarget] = useState<MobileProfile | null>(null);
  const [profilePin, setProfilePin] = useState('');
  const [profileError, setProfileError] = useState('');
  const [profileLists, setProfileLists] = useState<MobileProfileListEntry[]>([]);
  const [savedConnection, setSavedConnection] = useState<SavedConnection | null>(null);
  const [isRestoringConnection, setIsRestoringConnection] = useState(true);
  const [isPairing, setIsPairing] = useState(false);
  const [error, setError] = useState('');
  const [isServerOffline, setIsServerOffline] = useState(false);
  const [isOnboarding, setIsOnboarding] = useState(false);
  const [isCheckingConnection, setIsCheckingConnection] = useState(false);
  const [offlineSnapshotSavedAt, setOfflineSnapshotSavedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState<Record<string, StoredProgress>>({});
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

  const profileHydrationGenerationRef = useRef(0);
  const reconnectingSavedConnectionRef = useRef(false);
  const savedReconnectCompletionRef = useRef<Promise<void> | null>(null);
  const automaticHostAttemptRef = useRef(new Map<string, number>());
  const requestedHostRepairRef = useRef<string | null>(null);
  const credentialRefreshPromiseRef = useRef<{ key: string; promise: Promise<SavedConnection> } | null>(null);
  const credentialRefreshKeyRef = useRef('');
  const connectionHealthCheckRef = useRef(false);
  const reconnectSavedConnectionHandlerRef = useRef<(saved: SavedConnection) => Promise<boolean>>(async () => false);
  const pairWithDesktopHandlerRef = useRef<(host?: DiscoveredHost) => Promise<void>>(async () => undefined);
  const checkDesktopConnectionHandlerRef = useRef<() => Promise<void>>(async () => undefined);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const showProfilePicker = profilePickerMode !== null;
  const connectionLifecycleAction = mobileConnectionLifecycleAction({
    appState,
    hasConnection: Boolean(connection),
    hasSavedConnection: Boolean(savedConnection),
    isPairing,
    isServerOffline,
  });
  const discovery = useMobileBonjourDiscovery({ connection, isServerOffline });

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') cancelActiveRequests();
      appStateRef.current = nextState;
      setAppState(nextState);
    });
    return () => subscription.remove();
  }, [cancelActiveRequests]);

  useEffect(() => () => {
    cancelActiveRequests();
    void stopSecureTransport();
  }, [cancelActiveRequests, stopSecureTransport]);

  useMobileOfflinePersistence({
    activeProfile,
    automaticProfileSignIn,
    connection,
    isServerOffline,
    profileLists,
    profiles,
    progress,
    showProfilePicker,
  });

  return {
    activeProfile,
    appState,
    appStateRef,
    automaticProfileSignIn,
    automaticHostAttemptRef,
    baseUrl,
    checkDesktopConnectionHandlerRef,
    connection,
    connectionHealthCheckRef,
    connectionLifecycleAction,
    credentialRefreshKeyRef,
    credentialRefreshPromiseRef,
    error,
    isCheckingConnection,
    isOnboarding,
    isPairing,
    isRestoringConnection,
    isServerOffline,
    offlineSnapshotSavedAt,
    pairWithDesktopHandlerRef,
    profileError,
    profileHydrationGenerationRef,
    profileLists,
    profilePickerMode,
    profilePin,
    profilePinTarget,
    profiles,
    progress,
    reconnectingSavedConnectionRef,
    reconnectSavedConnectionHandlerRef,
    requestedHostRepairRef,
    savedReconnectCompletionRef,
    savedConnection,
    setActiveProfile,
    setAutomaticProfileSignIn,
    setBaseUrl,
    setConnection,
    setError,
    setIsCheckingConnection,
    setIsOnboarding,
    setIsPairing,
    setIsRestoringConnection,
    setIsServerOffline,
    setOfflineSnapshotSavedAt,
    setProfileError,
    setProfileLists,
    setProfilePickerMode,
    setProfilePin,
    setProfilePinTarget,
    setProfiles,
    setProgress,
    setSavedConnection,
    setShareCode,
    shareCode,
    showProfilePicker,
    ...discovery,
  };
}
