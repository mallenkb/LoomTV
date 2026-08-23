import { useCallback, useEffect, useState } from 'react';
import { desktopApi } from './desktopApi.ts';
import type { UnifiedDesktopServerState } from '../shared/desktopProtocol.ts';

const UNIFIED_SERVER_OFF: UnifiedDesktopServerState = {
  enabled: false,
  ready: false,
  ownerConfigured: false,
};

/**
 * Opt-in canonical server state for the desktop UI. The main process only
 * reports `enabled` when it was launched for the unified test, so every surface
 * that reads this renders exactly as it did before while the test is off.
 */
export function useUnifiedDesktopServer() {
  const [server, setServer] = useState<UnifiedDesktopServerState | null>(null);

  const refresh = useCallback(async () => {
    try {
      setServer(await desktopApi.getUnifiedDesktopServerState());
    } catch {
      setServer(UNIFIED_SERVER_OFF);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    server: server ?? UNIFIED_SERVER_OFF,
    // Guards first-run saves from racing ahead of the first state read and
    // skipping owner setup that the server actually needs.
    loaded: server !== null,
    refresh,
    setServer,
  };
}
