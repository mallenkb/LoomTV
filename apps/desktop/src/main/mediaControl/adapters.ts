import type { MediaSessionAdapterCandidate } from './service.ts';
import type { MediaSessionAdapterKind } from '../../shared/mediaControlProtocol.ts';
import { createMacOsMediaSessionAdapter } from './macosMediaPlayerAdapter.ts';
import { createWindowsSmtcAdapter } from './windowsSmtcAdapter.ts';
import { createLinuxMprisAdapter } from './linuxMprisAdapter.ts';

/**
 * Which system media session to use on this platform.
 *
 * All three run in LoomTV's own process, which is not a stylistic choice:
 * `MPNowPlayingInfoCenter` is attributed per process, SMTC is bound to the
 * application's own `HWND`, and an MPRIS service owns a bus name held by the
 * connection that created it. A separate helper could not own any of them on
 * LoomTV's behalf.
 *
 * Each adapter module is import-safe everywhere; koffi and the platform library
 * are only touched inside `start`. A platform with no adapter, or an adapter
 * that fails to start, leaves system media controls off and playback untouched.
 */

export function platformMediaSessionKind(platform: string): MediaSessionAdapterKind {
  if (platform === 'darwin') return 'macos-mediaplayer';
  if (platform === 'win32') return 'windows-smtc';
  if (platform === 'linux') return 'linux-mpris';
  return 'unsupported';
}

export type MediaSessionAdapterEnvironment = {
  platform: string;
  /**
   * LoomTV's top-level window handle. Windows needs it to bind the session;
   * the other platforms ignore it.
   */
  getWindowHandle?: () => Buffer | null;
  logWarning?: (message: string, error?: unknown) => void;
};

export function mediaSessionAdapterCandidates(
  environment: MediaSessionAdapterEnvironment,
): MediaSessionAdapterCandidate[] {
  const { platform, getWindowHandle, logWarning } = environment;

  if (platform === 'darwin') {
    return [{
      kind: 'macos-mediaplayer',
      create: () => createMacOsMediaSessionAdapter({ logWarning }),
    }];
  }

  if (platform === 'win32') {
    return [{
      kind: 'windows-smtc',
      create: () => createWindowsSmtcAdapter({
        getWindowHandle: getWindowHandle ?? (() => null),
        logWarning,
      }),
    }];
  }

  if (platform === 'linux') {
    return [{
      kind: 'linux-mpris',
      create: () => createLinuxMprisAdapter({ logWarning }),
    }];
  }

  return [];
}
