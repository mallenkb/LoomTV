import * as ScreenOrientation from 'expo-screen-orientation';
import { useVideoPlayer } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import type { AppStateStatus } from 'react-native';

import type { MediaItem, PlayTarget, StreamOptions } from './mobileDomain';
import { reportNonFatal } from './mobileDiagnostics';
import type { PlaybackFailure } from './playbackRecovery';

export function useMobilePlaybackController({ appState, height, width }: {
  appState: AppStateStatus;
  height: number;
  width: number;
}) {
  const [playTarget, setPlayTarget] = useState<PlayTarget | null>(null);
  const [miniPlayerTarget, setMiniPlayerTarget] = useState<PlayTarget | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [streamOptions, setStreamOptions] = useState<StreamOptions>({});
  const [isPreparingStream, setIsPreparingStream] = useState(false);
  const [playbackFailure, setPlaybackFailure] = useState<PlaybackFailure | null>(null);
  const [streamRetryNonce, setStreamRetryNonce] = useState(0);

  const orientationLockQueueRef = useRef<Promise<void>>(Promise.resolve());
  const desiredOrientationLockRef = useRef<ScreenOrientation.OrientationLock | null>(null);
  const appliedOrientationLockRef = useRef<ScreenOrientation.OrientationLock | null>(null);
  const playerReturnItemRef = useRef<MediaItem | null>(null);
  const closingPlayerRef = useRef(false);
  const windowSizeRef = useRef({ height, width });
  const mandatoryPlayerTeardownRef = useRef<() => void>(() => undefined);
  const shouldAutoplayRef = useRef(false);
  const userPausedRef = useRef(false);
  const pendingSeekRef = useRef(0);
  const autoAdvancedEpisodeRef = useRef<string | null>(null);
  windowSizeRef.current = { height, width };

  const player = useVideoPlayer(null, (nextPlayer) => {
    nextPlayer.loop = false;
    nextPlayer.timeUpdateEventInterval = 0.5;
  });

  useEffect(() => {
    if (appState === 'active' || !player.playing) return;
    player.pause();
  }, [appState, player]);

  useEffect(() => {
    const lock = playTarget ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP;
    if (desiredOrientationLockRef.current === lock && appliedOrientationLockRef.current === lock) return;
    desiredOrientationLockRef.current = lock;
    orientationLockQueueRef.current = orientationLockQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (desiredOrientationLockRef.current !== lock || appliedOrientationLockRef.current === lock) return;
        await ScreenOrientation.lockAsync(lock);
        appliedOrientationLockRef.current = lock;
      })
      .catch(() => undefined);
  }, [playTarget]);

  mandatoryPlayerTeardownRef.current = () => {
    try {
      player.pause();
    } catch (error) {
      reportNonFatal('player.pause-before-source-change', error);
    }
    void player.replaceAsync(null).catch(() => undefined);
  };

  return {
    appliedOrientationLockRef,
    autoAdvancedEpisodeRef,
    closingPlayerRef,
    desiredOrientationLockRef,
    isPreparingStream,
    mandatoryPlayerTeardownRef,
    miniPlayerTarget,
    orientationLockQueueRef,
    pendingSeekRef,
    playbackFailure,
    playbackUrl,
    player,
    playerReturnItemRef,
    playTarget,
    setIsPreparingStream,
    setMiniPlayerTarget,
    setPlaybackFailure,
    setPlaybackUrl,
    setPlayTarget,
    setStreamOptions,
    setStreamRetryNonce,
    shouldAutoplayRef,
    streamOptions,
    streamRetryNonce,
    userPausedRef,
    windowSizeRef,
  };
}
