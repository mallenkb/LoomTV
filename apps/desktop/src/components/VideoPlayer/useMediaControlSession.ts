import { useEffect, useRef } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import type { MediaSessionCommand } from '@/shared/mediaControlProtocol';
import { isMediaSessionDiscontinuity } from '@/shared/mediaControlProtocol';
import { buildMediaSessionSnapshot, type MediaSessionSnapshotInput } from './mediaControlState';

/**
 * Publish this player to the main process's system media session.
 *
 * The main process owns the session. This hook only reports what the player is
 * doing and hands back commands the main process could not run itself. It
 * releases on unmount, so closing the player, destroying the renderer, or
 * quitting the app all end LoomTV's ownership.
 *
 * Snapshots go out on discontinuity only. Every platform interpolates position
 * from elapsed time and rate, so there is no per-second tick, and MPRIS
 * explicitly excludes `Position` from change notifications.
 */
export function useMediaControlSession(
  input: MediaSessionSnapshotInput,
  onCommand: (command: MediaSessionCommand, handledInMain: boolean) => void,
): void {
  const commandRef = useRef(onCommand);
  commandRef.current = onCommand;

  const publishedRef = useRef<ReturnType<typeof buildMediaSessionSnapshot> | null>(null);

  // Subscribing once keeps a single handler on the wire no matter how often the
  // player's own callbacks are rebuilt.
  useEffect(() => desktopApi.onMediaSessionCommand((command, handledInMain) => {
    commandRef.current(command, handledInMain);
  }), []);

  useEffect(() => () => {
    publishedRef.current = null;
    void desktopApi.releaseMediaSession();
  }, []);

  const snapshot = buildMediaSessionSnapshot(input);

  useEffect(() => {
    if (!isMediaSessionDiscontinuity(publishedRef.current, snapshot)) {
      // Keep the local copy current so the next real transition compares
      // against the position the player actually reached.
      publishedRef.current = snapshot;
      return;
    }
    publishedRef.current = snapshot;
    void desktopApi.publishMediaSession(snapshot).catch(() => undefined);
  }, [snapshot]);
}
