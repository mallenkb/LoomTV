import { useEffect } from 'react';

import type { Connection, MobileProfile, MobileProfileListEntry, StoredProgress } from './mobileDomain';
import { reportNonFatal } from './mobileDiagnostics';
import { clearMobileOfflineSnapshot, saveMobileOfflineSnapshot } from './mobileOfflineCache';

export function useMobileOfflinePersistence({
  activeProfile,
  automaticProfileSignIn,
  connection,
  isServerOffline,
  profileLists,
  profiles,
  progress,
  showProfilePicker,
}: {
  activeProfile: MobileProfile | null;
  automaticProfileSignIn: boolean;
  connection: Connection | null;
  isServerOffline: boolean;
  profileLists: MobileProfileListEntry[];
  profiles: MobileProfile[];
  progress: Record<string, StoredProgress>;
  showProfilePicker: boolean;
}): void {
  useEffect(() => {
    if (!connection?.hostDeviceId) return undefined;
    const usesProfiles = profiles.length > 0 || activeProfile !== null;
    const profileCanPersist = !usesProfiles || Boolean(activeProfile && automaticProfileSignIn && !activeProfile.hasPin && !activeProfile.isGuest);
    if (showProfilePicker || !profileCanPersist) {
      void clearMobileOfflineSnapshot(connection.hostDeviceId);
      return undefined;
    }
    if (isServerOffline) return undefined;
    const timer = setTimeout(() => {
      void saveMobileOfflineSnapshot({
        hostDeviceId: connection.hostDeviceId,
        activeProfile,
        automaticProfileSignIn,
        profiles,
        library: connection.library,
        libraryEtag: connection.libraryEtag,
        catalogRevision: connection.catalogRevision,
        catalogTransport: connection.catalogTransport,
        selectionRevision: connection.selectionRevision,
        progress,
        profileLists,
      }).catch((error) => reportNonFatal('offline-cache.save', error));
    }, 500);
    return () => clearTimeout(timer);
  }, [activeProfile, automaticProfileSignIn, connection, isServerOffline, profileLists, profiles, progress, showProfilePicker]);
}

