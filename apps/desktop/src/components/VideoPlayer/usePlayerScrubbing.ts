import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaybackEngine } from './engines/PlaybackEngine';

type PlaybackSnapshotUpdater = (
  position: number,
  duration: number,
  options: { forceReact: boolean },
) => void;

type PlayerScrubbingInput = {
  duration: number;
  isScrubbingRef: React.RefObject<boolean>;
  playbackEngineRef: React.RefObject<PlaybackEngine | null>;
  playbackPositionRef: React.RefObject<number>;
  scopeKey: string;
  scrubTimeHudRef: React.RefObject<HTMLDivElement | null>;
  seekTo: (targetSeconds: number) => void;
  updatePlaybackSnapshot: PlaybackSnapshotUpdater;
};

export function usePlayerScrubbing({
  duration,
  isScrubbingRef,
  playbackEngineRef,
  playbackPositionRef,
  scopeKey,
  scrubTimeHudRef,
  seekTo,
  updatePlaybackSnapshot,
}: PlayerScrubbingInput) {
  const [isScrubbing, setIsScrubbing] = useState(false);
  const listenerCleanupRef = useRef<(() => void) | null>(null);
  const hudHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nativeSeekRafRef = useRef<number | null>(null);
  const pendingNativeSeekRef = useRef<number | null>(null);
  const nativePreviewStartedRef = useRef(false);

  const cancelNativePreview = useCallback(() => {
    if (nativeSeekRafRef.current !== null) {
      cancelAnimationFrame(nativeSeekRafRef.current);
      nativeSeekRafRef.current = null;
    }
    pendingNativeSeekRef.current = null;
    nativePreviewStartedRef.current = false;
  }, []);

  const flushNativePreview = useCallback(() => {
    nativeSeekRafRef.current = null;
    const target = pendingNativeSeekRef.current;
    pendingNativeSeekRef.current = null;
    const engine = playbackEngineRef.current;
    if (!isScrubbingRef.current || target === null || !engine) return;
    void engine.seek(target).catch((error) => {
      console.warn('[player] Native scrub preview seek failed:', error);
    });
  }, [isScrubbingRef, playbackEngineRef]);

  const requestNativePreview = useCallback((target: number) => {
    const engine = playbackEngineRef.current;
    if (!engine) return;

    // Pointer down gets one immediate native seek. Continuous drag updates are
    // then collapsed to the newest target and sent at most once per display
    // frame. The final pointer-up seek bypasses this scheduler entirely.
    if (!nativePreviewStartedRef.current) {
      nativePreviewStartedRef.current = true;
      void engine.seek(target).catch((error) => {
        console.warn('[player] Initial native scrub seek failed:', error);
      });
      return;
    }

    pendingNativeSeekRef.current = target;
    if (nativeSeekRafRef.current !== null) return;
    nativeSeekRafRef.current = requestAnimationFrame(flushNativePreview);
  }, [flushNativePreview, playbackEngineRef]);

  const resetScrubbing = useCallback(() => {
    isScrubbingRef.current = false;
    setIsScrubbing(false);
    cancelNativePreview();
    if (hudHideTimerRef.current) {
      clearTimeout(hudHideTimerRef.current);
      hudHideTimerRef.current = null;
    }
    listenerCleanupRef.current?.();
    listenerCleanupRef.current = null;
  }, [cancelNativePreview, isScrubbingRef]);

  useEffect(() => {
    resetScrubbing();
  }, [resetScrubbing, scopeKey]);

  useEffect(() => resetScrubbing, [resetScrubbing]);

  const handleProgressPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!duration || event.button !== 0) return;
    event.preventDefault();
    const bar = event.currentTarget;
    const pointerId = event.pointerId;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    bar.setPointerCapture(pointerId);
    let pendingPosition = playbackPositionRef.current;
    isScrubbingRef.current = true;
    setIsScrubbing(true);
    bar.dataset.scrubbing = 'true';
    cancelNativePreview();
    if (hudHideTimerRef.current) {
      clearTimeout(hudHideTimerRef.current);
      hudHideTimerRef.current = null;
    }
    if (scrubTimeHudRef.current) scrubTimeHudRef.current.style.opacity = '1';

    const positionFromClientX = (clientX: number) => {
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * duration;
    };

    const previewFromClientX = (clientX: number) => {
      pendingPosition = positionFromClientX(clientX);
      // syncPlaybackUi writes the scrubber/thumb/HUD directly, so pointer
      // feedback is immediate and does not wait for React or an animation frame.
      updatePlaybackSnapshot(pendingPosition, duration, { forceReact: false });
      requestNativePreview(pendingPosition);
    };

    // First visual update and first native seek both happen in this pointer-down
    // task. No debounce, timeout, or animation-frame delay is inserted here.
    previewFromClientX(event.clientX);
    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === pointerId) previewFromClientX(moveEvent.clientX);
    };
    let removeListeners = () => undefined;
    const finish = (finishEvent: PointerEvent, updateFromPointer: boolean) => {
      if (finishEvent.pointerId !== pointerId) return;
      if (updateFromPointer) pendingPosition = positionFromClientX(finishEvent.clientX);

      // Never let a queued drag preview land after the exact final target.
      cancelNativePreview();
      updatePlaybackSnapshot(pendingPosition, duration, { forceReact: true });
      seekTo(pendingPosition);
      isScrubbingRef.current = false;
      setIsScrubbing(false);
      delete bar.dataset.scrubbing;
      hudHideTimerRef.current = setTimeout(() => {
        hudHideTimerRef.current = null;
        if (scrubTimeHudRef.current) scrubTimeHudRef.current.style.opacity = '0';
      }, 180);
      if (bar.hasPointerCapture(pointerId)) bar.releasePointerCapture(pointerId);
      removeListeners();
    };
    const handleUp = (upEvent: PointerEvent) => finish(upEvent, true);
    const handleCancel = (cancelEvent: PointerEvent) => finish(cancelEvent, false);
    removeListeners = () => {
      bar.removeEventListener('pointermove', handleMove);
      bar.removeEventListener('pointerup', handleUp);
      bar.removeEventListener('pointercancel', handleCancel);
      if (listenerCleanupRef.current === removeListeners) listenerCleanupRef.current = null;
    };
    listenerCleanupRef.current?.();
    listenerCleanupRef.current = removeListeners;
    bar.addEventListener('pointermove', handleMove);
    bar.addEventListener('pointerup', handleUp);
    bar.addEventListener('pointercancel', handleCancel);
  }, [
    cancelNativePreview,
    duration,
    isScrubbingRef,
    playbackPositionRef,
    requestNativePreview,
    scrubTimeHudRef,
    seekTo,
    updatePlaybackSnapshot,
  ]);

  const handleProgressKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    // Arrow keys are handled once by the player's window capture listener.
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    if (event.key === 'PageDown') {
      event.preventDefault();
      seekTo(playbackPositionRef.current - duration * 0.1);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      seekTo(playbackPositionRef.current + duration * 0.1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      seekTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      seekTo(duration);
    }
  }, [duration, playbackPositionRef, seekTo]);

  return { handleProgressKeyDown, handleProgressPointerDown, isScrubbing };
}
