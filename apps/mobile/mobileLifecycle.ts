import type { AppStateStatus } from 'react-native';

export type MobileConnectionLifecycleAction = 'discover' | 'health-check' | 'idle' | 'retry-saved';

export function mobileConnectionLifecycleAction({
  appState,
  hasConnection,
  hasSavedConnection,
  isPairing,
  isServerOffline,
}: {
  appState: AppStateStatus;
  hasConnection: boolean;
  hasSavedConnection: boolean;
  isPairing: boolean;
  isServerOffline: boolean;
}): MobileConnectionLifecycleAction {
  if (appState !== 'active') return 'idle';
  if (hasSavedConnection && (!hasConnection || isServerOffline) && !isPairing) return 'retry-saved';
  if (hasConnection && !isServerOffline) return 'health-check';
  return 'discover';
}

export type MobilePlayerReplacementResult = 'applied' | 'failed' | 'stale';

export async function replaceMobilePlayerSource<TSource>(
  replaceAsync: (source: TSource | null) => Promise<void>,
  source: TSource | null,
  isCurrent: () => boolean,
): Promise<MobilePlayerReplacementResult> {
  try {
    await replaceAsync(source);
    return isCurrent() ? 'applied' : 'stale';
  } catch {
    return isCurrent() ? 'failed' : 'stale';
  }
}
