import { globalShortcut, type WebContents } from 'electron';

type SystemMediaKeyAction =
  | 'play-pause'
  | 'previous-track'
  | 'next-track';

const mediaKeys: ReadonlyArray<
  readonly [accelerator: string, action: SystemMediaKeyAction]
> = [
  ['MediaPlayPause', 'play-pause'],
  ['MediaPreviousTrack', 'previous-track'],
  ['MediaNextTrack', 'next-track'],
];

const registeredAccelerators = new Set<string>();
const activePlaybackKeys = new Set<string>();
let lastPlaybackOwner: WebContents | null = null;

const sendAction = (action: SystemMediaKeyAction) => {
  if (!lastPlaybackOwner || lastPlaybackOwner.isDestroyed()) {
    unregisterSystemMediaKeys();
    return;
  }
  lastPlaybackOwner.send('playback:system-media-key', action);
};

const registerSystemMediaKeys = () => {
  for (const [accelerator, action] of mediaKeys) {
    if (registeredAccelerators.has(accelerator)) continue;
    try {
      if (globalShortcut.register(accelerator, () => sendAction(action))) {
        registeredAccelerators.add(accelerator);
      } else {
        console.warn(`[system-media-keys] ${accelerator} registration was refused by the operating system.`);
      }
    } catch (error) {
      console.warn(`[system-media-keys] ${accelerator} registration failed.`, error);
    }
  }
};

export const setSystemMediaKeyActivity = (
  webContents: WebContents,
  key: string,
  active: boolean,
) => {
  if (active) {
    if (!lastPlaybackOwner || lastPlaybackOwner.id !== webContents.id) {
      unregisterSystemMediaKeys();
      lastPlaybackOwner = webContents;
      const ownerId = webContents.id;
      webContents.once('destroyed', () => {
        if (lastPlaybackOwner?.id === ownerId) unregisterSystemMediaKeys();
      });
    }
    activePlaybackKeys.add(key);
    registerSystemMediaKeys();
    return;
  }

  if (lastPlaybackOwner?.id !== webContents.id) return;
  activePlaybackKeys.delete(key);
  // Keep both the OS registration and this living renderer as LoomTV's last
  // playback target. A system play command can then resume the last player
  // after focus moves elsewhere or after playback is paused. A newer active
  // player replaces it, and renderer destruction or app shutdown releases it.
};

export const unregisterSystemMediaKeys = () => {
  for (const accelerator of registeredAccelerators) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // Electron may already have released shortcuts during shutdown.
    }
  }
  registeredAccelerators.clear();
  activePlaybackKeys.clear();
  lastPlaybackOwner = null;
};
