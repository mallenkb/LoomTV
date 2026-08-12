import type { AudioTrack, SubtitleTrack, useVideoPlayer } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { mobileAbsoluteMediaSeconds, mobilePlayerSecondsForAbsolute } from './playbackClock';

type MobileVideoPlayer = ReturnType<typeof useVideoPlayer>;

type MobilePlayerSessionInput = {
  menuOpen: boolean;
  playbackUrl: string | null;
  player: MobileVideoPlayer;
};

export function useMobilePlayerSession({ menuOpen, playbackUrl, player }: MobilePlayerSessionInput) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isPlaying, setIsPlaying] = useState(() => Boolean(player.playing));
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [nativeAudioTracks, setNativeAudioTracks] = useState<AudioTrack[]>([]);
  const [nativeSubtitleTracks, setNativeSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [interactionRevision, setInteractionRevision] = useState(0);
  const controlsOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!playbackUrl) return;

    const refreshTracks = (payload?: {
      availableAudioTracks?: AudioTrack[];
      availableSubtitleTracks?: SubtitleTrack[];
      duration?: number;
    }) => {
      try {
        setNativeAudioTracks(payload?.availableAudioTracks || player.availableAudioTracks || []);
        setNativeSubtitleTracks(payload?.availableSubtitleTracks || player.availableSubtitleTracks || []);
        const nextDuration = Number(payload?.duration || player.duration || 0);
        if (Number.isFinite(nextDuration) && nextDuration > 0) setDuration(nextDuration);
      } catch {
        // Track APIs can reject while the native player is still loading.
      }
    };

    const timeSubscription = player.addListener?.('timeUpdate', (event: { currentTime: number }) => {
      setPosition(mobileAbsoluteMediaSeconds(Number(event.currentTime) || 0));
      const nextDuration = Number(player.duration || 0);
      if (Number.isFinite(nextDuration) && nextDuration > 0) setDuration(nextDuration);
    });
    const playingSubscription = player.addListener?.('playingChange', (event: { isPlaying: boolean }) => {
      setIsPlaying(event.isPlaying);
    });
    const statusSubscription = player.addListener?.('statusChange', (payload: { status: string }) => {
      if (payload.status === 'readyToPlay') refreshTracks();
    });
    const sourceLoadSubscription = player.addListener?.('sourceLoad', refreshTracks);
    const trackSubscriptions = [
      player.addListener?.('availableAudioTracksChange', (payload: { availableAudioTracks: AudioTrack[] }) => refreshTracks(payload)),
      player.addListener?.('availableSubtitleTracksChange', (payload: { availableSubtitleTracks: SubtitleTrack[] }) => refreshTracks(payload)),
      player.addListener?.('audioTrackChange', () => refreshTracks()),
      player.addListener?.('subtitleTrackChange', () => refreshTracks()),
    ];
    refreshTracks();
    return () => {
      timeSubscription?.remove?.();
      playingSubscription?.remove?.();
      statusSubscription?.remove?.();
      sourceLoadSubscription?.remove?.();
      trackSubscriptions.forEach((subscription) => subscription?.remove?.());
    };
  }, [playbackUrl, player]);

  useEffect(() => {
    if (!controlsVisible || !isPlaying || menuOpen) return;
    const timer = setTimeout(() => setControlsVisible(false), 4000);
    return () => clearTimeout(timer);
  }, [controlsVisible, interactionRevision, isPlaying, menuOpen]);

  useEffect(() => {
    Animated.timing(controlsOpacity, {
      toValue: controlsVisible ? 1 : 0,
      duration: controlsVisible ? 150 : 220,
      useNativeDriver: true,
    }).start();
  }, [controlsOpacity, controlsVisible]);

  const markInteraction = useCallback(() => {
    setInteractionRevision((revision) => revision + 1);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    markInteraction();
  }, [markInteraction]);

  const toggleControls = useCallback(() => {
    setControlsVisible((visible) => !visible);
    markInteraction();
  }, [markInteraction]);

  const togglePlay = useCallback(() => {
    showControls();
    try {
      if (isPlaying) player.pause();
      else player.play();
    } catch {
      // The native player can briefly reject commands during teardown.
    }
  }, [isPlaying, player, showControls]);

  const seekToSeconds = useCallback((seconds: number) => {
    showControls();
    const absoluteTime = Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds);
    const nextTime = mobilePlayerSecondsForAbsolute(absoluteTime);
    setPosition(nextTime);
    try {
      player.currentTime = nextTime;
    } catch {
      // Seeking before the stream is ready is a no-op.
    }
  }, [duration, player, showControls]);

  const skipBy = useCallback((delta: number) => {
    const currentTime = Number(player.currentTime || position || 0);
    seekToSeconds(currentTime + delta);
  }, [player, position, seekToSeconds]);

  const seekToFraction = useCallback((fraction: number) => {
    if (duration <= 0) return;
    seekToSeconds(Math.min(duration, Math.max(0, fraction * duration)));
  }, [duration, seekToSeconds]);

  return {
    controlsOpacity,
    controlsVisible,
    duration,
    isPlaying,
    markInteraction,
    nativeAudioTracks,
    nativeSubtitleTracks,
    position,
    seekToFraction,
    seekToSeconds,
    setControlsVisible,
    showControls,
    skipBy,
    toggleControls,
    togglePlay,
  };
}
