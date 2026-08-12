import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { PlaybackEngine } from './engines/PlaybackEngine';

const NATIVE_SCRUB_PREVIEW_INTERVAL_MS = 80;

type PlaybackSnapshotUpdater = (
  position: number,
  duration: number,
  options: { forceReact: boolean },
) => void;

type PlayerScrubbingInput = {
  clearNextEpisodeCountdown: () => void;
  duration: number;
  isScrubbingRef: React.RefObject<boolean>;
  playbackEngineRef: React.RefObject<PlaybackEngine | null>;
  playbackPositionRef: React.RefObject<number>;
  resetNextEpisodePrompt: () => void;
  scopeKey: string;
  scrubTimeHudRef: React.RefObject<HTMLDivElement | null>;
  seekTo: (targetSeconds: number) => void;
  updatePlaybackSnapshot: PlaybackSnapshotUpdater;
};

export function usePlayerScrubbing({
  clearNextEpisodeCountdown,
  duration,
  isScrubbingRef,
  playbackEngineRef,
  playbackPositionRef,
  resetNextEpisodePrompt,
  scopeKey,
  scrubTimeHudRef,
  seekTo,
  updatePlaybackSnapshot,
}: PlayerScrubbingInput) {
  const previewRafRef = useRef<number | null>(null);
  const listenerCleanupRef = useRef<(() => void) | null>(null);
  const hudHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nativeSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNativeSeekRef = useRef<number | null>(null);
  const lastNativeSeekAtRef = useRef(0);

  const cancelNativePreview = useCallback(() => {
    if (nativeSeekTimerRef.current) {
      clearTimeout(nativeSeekTimerRef.current);
      nativeSeekTimerRef.current = null;
    }
    pendingNativeSeekRef.current = null;
  }, []);

  const flushNativePreview = useCallback(() => {
    nativeSeekTimerRef.current = null;
    const target = pendingNativeSeekRef.current;
    const engine = playbackEngineRef.current;
    if (!isScrubbingRef.current || target === null || !engine) {
      pendingNativeSeekRef.current = null;
      return;
    }
    pendingNativeSeekRef.current = null;
    lastNativeSeekAtRef.current = performance.now();
    void engine.seek(target);
  }, [isScrubbingRef, playbackEngineRef]);

  const requestNativePreview = useCallback((target: number) => {
    if (!playbackEngineRef.current) return;
    pendingNativeSeekRef.current = target;
    if (nativeSeekTimerRef.current) return;
    const elapsed = performance.now() - lastNativeSeekAtRef.current;
    const delay = Math.max(0, NATIVE_SCRUB_PREVIEW_INTERVAL_MS - elapsed);
    if (delay === 0) {
      flushNativePreview();
      return;
    }
    nativeSeekTimerRef.current = setTimeout(flushNativePreview, delay);
  }, [flushNativePreview, playbackEngineRef]);

  const resetScrubbing = useCallback(() => {
    isScrubbingRef.current = false;
    cancelNativePreview();
    if (previewRafRef.current !== null) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
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
    resetNextEpisodePrompt();
    clearNextEpisodeCountdown();
    let pendingPosition = playbackPositionRef.current;
    isScrubbingRef.current = true;
    bar.dataset.scrubbing = 'true';
    if (hudHideTimerRef.current) {
      clearTimeout(hudHideTimerRef.current);
      hudHideTimerRef.current = null;
    }
    if (scrubTimeHudRef.current) scrubTimeHudRef.current.style.opacity = '1';

    const previewFromClientX = (clientX: number) => {
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      pendingPosition = ratio * duration;
      requestNativePreview(pendingPosition);
      if (previewRafRef.current !== null) return;
      previewRafRef.current = requestAnimationFrame(() => {
        previewRafRef.current = null;
        updatePlaybackSnapshot(pendingPosition, duration, { forceReact: false });
      });
    };

    previewFromClientX(event.clientX);
    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === pointerId) previewFromClientX(moveEvent.clientX);
    };
    let removeListeners = () => undefined;
    const finish = (finishEvent: PointerEvent, updateFromPointer: boolean) => {
      if (finishEvent.pointerId !== pointerId) return;
      if (updateFromPointer) previewFromClientX(finishEvent.clientX);
      cancelNativePreview();
      if (previewRafRef.current !== null) {
        cancelAnimationFrame(previewRafRef.current);
        previewRafRef.current = null;
      }
      updatePlaybackSnapshot(pendingPosition, duration, { forceReact: true });
      seekTo(pendingPosition);
      isScrubbingRef.current = false;
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
    clearNextEpisodeCountdown,
    duration,
    isScrubbingRef,
    playbackPositionRef,
    requestNativePreview,
    resetNextEpisodePrompt,
    scrubTimeHudRef,
    seekTo,
    updatePlaybackSnapshot,
  ]);

  const handleProgressKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    const step = event.shiftKey ? 60 : 5;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      seekTo(playbackPositionRef.current - step);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      seekTo(playbackPositionRef.current + step);
    } else if (event.key === 'PageDown') {
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

  return { handleProgressKeyDown, handleProgressPointerDown, isScrubbingRef };
}
