import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaybackEngine } from './engines/PlaybackEngine';

const NATIVE_SCRUB_PREVIEW_INTERVAL_MS = 80;
// A trackpad swipe ends with momentum events; commit once they stop.
const WHEEL_SCRUB_COMMIT_MS = 220;
const WHEEL_LINE_PIXELS = 16;

/**
 * Seconds of media per pixel of horizontal trackpad travel. Finer on short
 * episodes, capped so a swipe across a two-hour film still moves minutes,
 * not the whole film.
 */
export function wheelScrubSecondsPerPixel(duration: number): number {
  return Math.min(1, Math.max(0.1, duration / 2400));
}

// Leave two-finger swipes alone over panels that scroll themselves, such as
// the episode list or the subtitle settings.
function startsInScrollableRegion(target: EventTarget | null, root: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== root; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth) return true;
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return true;
  }
  return false;
}

type PlaybackSnapshotUpdater = (
  position: number,
  duration: number,
  options: { forceReact: boolean },
) => void;

type PlayerScrubbingInput = {
  containerRef: React.RefObject<HTMLElement | null>;
  duration: number;
  /** False for live streams, which have no timeline to scrub. */
  wheelScrubEnabled: boolean;
  onWheelScrubActivity: () => void;
  isScrubbingRef: React.RefObject<boolean>;
  playbackEngineRef: React.RefObject<PlaybackEngine | null>;
  playbackPositionRef: React.RefObject<number>;
  scopeKey: string;
  scrubTimeHudRef: React.RefObject<HTMLDivElement | null>;
  seekTo: (targetSeconds: number) => void;
  updatePlaybackSnapshot: PlaybackSnapshotUpdater;
};

export function usePlayerScrubbing({
  containerRef,
  duration,
  wheelScrubEnabled,
  onWheelScrubActivity,
  isScrubbingRef,
  playbackEngineRef,
  playbackPositionRef,
  scopeKey,
  scrubTimeHudRef,
  seekTo,
  updatePlaybackSnapshot,
}: PlayerScrubbingInput) {
  const [isScrubbing, setIsScrubbing] = useState(false);
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
    setIsScrubbing(false);
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
    let pendingPosition = playbackPositionRef.current;
    isScrubbingRef.current = true;
    setIsScrubbing(true);
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

  // Two-finger horizontal swipe scrubs the timeline, as in VLC; a vertical
  // swipe does nothing. With macOS
  // natural scrolling, fingers moving right report a negative deltaX, which
  // moves forward. Frames preview through the same throttled native seeks as
  // dragging the bar, and the final position is committed once the swipe and
  // its momentum have stopped.
  // seekTo and duration change while a video plays. Read them through a ref
  // so a change mid-swipe doesn't re-register the listener and drop the swipe.
  const wheelScrubLatestRef = useRef({ duration, seekTo, updatePlaybackSnapshot, onWheelScrubActivity });
  wheelScrubLatestRef.current = { duration, seekTo, updatePlaybackSnapshot, onWheelScrubActivity };

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !wheelScrubEnabled) return;
    const latest = wheelScrubLatestRef;
    let pendingPosition: number | null = null;
    let commitTimer: ReturnType<typeof setTimeout> | null = null;

    const endGesture = (commit: boolean) => {
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = null;
      const target = pendingPosition;
      pendingPosition = null;
      if (target === null) return;
      cancelNativePreview();
      if (previewRafRef.current !== null) {
        cancelAnimationFrame(previewRafRef.current);
        previewRafRef.current = null;
      }
      if (commit) {
        latest.current.updatePlaybackSnapshot(target, latest.current.duration, { forceReact: true });
        latest.current.seekTo(target);
      }
      isScrubbingRef.current = false;
      setIsScrubbing(false);
    };

    const handleWheel = (event: WheelEvent) => {
      const { duration } = latest.current;
      // Ctrl+wheel is a pinch gesture, not a swipe.
      if (event.ctrlKey || !duration) return;
      if (pendingPosition === null) {
        if (startsInScrollableRegion(event.target, container)) return;
        // Vertical swipes over the video deliberately do nothing.
        if (event.deltaX === 0 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
          event.preventDefault();
          return;
        }
        // A drag on the progress bar owns scrubbing until it ends.
        if (listenerCleanupRef.current) return;
        pendingPosition = playbackPositionRef.current;
        isScrubbingRef.current = true;
        setIsScrubbing(true);
      }
      event.preventDefault();
      const deltaPixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaX * WHEEL_LINE_PIXELS : event.deltaX;
      pendingPosition = Math.min(duration, Math.max(0, pendingPosition - deltaPixels * wheelScrubSecondsPerPixel(duration)));
      requestNativePreview(pendingPosition);
      if (previewRafRef.current === null) {
        previewRafRef.current = requestAnimationFrame(() => {
          previewRafRef.current = null;
          if (pendingPosition !== null) latest.current.updatePlaybackSnapshot(pendingPosition, duration, { forceReact: false });
        });
      }
      latest.current.onWheelScrubActivity();
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(() => endGesture(true), WHEEL_SCRUB_COMMIT_MS);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
      endGesture(false);
    };
  }, [
    cancelNativePreview,
    containerRef,
    isScrubbingRef,
    playbackPositionRef,
    requestNativePreview,
    scopeKey,
    wheelScrubEnabled,
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
