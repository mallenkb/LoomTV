import * as Brightness from 'expo-brightness';
import type { useVideoPlayer } from 'expo-video';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder } from 'react-native';

type MobileVideoPlayer = ReturnType<typeof useVideoPlayer>;
type PlayerVerticalGesture = 'brightness' | 'volume';

type MobilePlayerGesturesInput = {
  closeMenu: () => void;
  markInteraction: () => void;
  player: MobileVideoPlayer;
  playerWidth: number;
  setControlsVisible: Dispatch<SetStateAction<boolean>>;
};

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function useMobilePlayerGestures({
  closeMenu,
  markInteraction,
  player,
  playerWidth,
  setControlsVisible,
}: MobilePlayerGesturesInput) {
  const [gestureLevel, setGestureLevel] = useState<{ kind: PlayerVerticalGesture; value: number } | null>(null);
  const gestureStateRef = useRef<{ kind: PlayerVerticalGesture | null; startValue: number; started: boolean }>({
    kind: null,
    startValue: 0,
    started: false,
  });
  const brightnessRef = useRef(0.5);
  const volumeRef = useRef(1);
  const restoreBrightnessRef = useRef<number | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    Brightness.getBrightnessAsync()
      .then((value) => {
        if (cancelled) return;
        const nextValue = clampLevel(value);
        brightnessRef.current = nextValue;
        restoreBrightnessRef.current = nextValue;
      })
      .catch(() => {});

    const volumeSubscription = player.addListener?.('volumeChange', (event: { volume: number }) => {
      volumeRef.current = clampLevel(event.volume);
    });

    return () => {
      cancelled = true;
      volumeSubscription?.remove?.();
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      const restoreValue = restoreBrightnessRef.current;
      if (restoreValue !== null) void Brightness.setBrightnessAsync(restoreValue).catch(() => {});
    };
  }, [player]);

  const showGestureLevel = useCallback((kind: PlayerVerticalGesture, value: number) => {
    setGestureLevel({ kind, value });
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setGestureLevel(null), 700);
  }, []);

  const setPlayerVolume = useCallback((value: number) => {
    const nextValue = clampLevel(value);
    volumeRef.current = nextValue;
    try {
      player.volume = nextValue;
      player.muted = nextValue === 0;
    } catch {
      // Volume changes can be rejected while the native player is loading.
    }
    showGestureLevel('volume', nextValue);
  }, [player, showGestureLevel]);

  const setPlayerBrightness = useCallback((value: number) => {
    const nextValue = clampLevel(value);
    brightnessRef.current = nextValue;
    void Brightness.setBrightnessAsync(nextValue).catch(() => {});
    showGestureLevel('brightness', nextValue);
  }, [showGestureLevel]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => (
      Math.abs(gesture.dy) > 12
      && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.35
    ),
    onPanResponderGrant: (event) => {
      const kind: PlayerVerticalGesture = event.nativeEvent.locationX < playerWidth / 2 ? 'brightness' : 'volume';
      gestureStateRef.current = {
        kind,
        startValue: kind === 'brightness' ? brightnessRef.current : volumeRef.current,
        started: true,
      };
      setControlsVisible(true);
      closeMenu();
    },
    onPanResponderMove: (_, gesture) => {
      const state = gestureStateRef.current;
      if (!state.started || !state.kind) return;
      const nextValue = state.startValue - (gesture.dy / 220);
      if (state.kind === 'brightness') setPlayerBrightness(nextValue);
      else setPlayerVolume(nextValue);
    },
    onPanResponderRelease: () => {
      gestureStateRef.current = { kind: null, startValue: 0, started: false };
      markInteraction();
    },
    onPanResponderTerminate: () => {
      gestureStateRef.current = { kind: null, startValue: 0, started: false };
    },
  }), [closeMenu, markInteraction, playerWidth, setControlsVisible, setPlayerBrightness, setPlayerVolume]);

  return { gestureLevel, panHandlers: panResponder.panHandlers };
}
