import { useCallback, useRef, useState, type RefObject } from 'react';
import { clampSeconds, formatTime, seekAccessibilityText } from './helpers';

const POSITION_UI_UPDATE_INTERVAL_MS = 1000;

export function usePlaybackProgressDisplay(
  isLiveStreamRef: RefObject<boolean>,
  playbackPositionRef: RefObject<number>,
  playbackDurationRef: RefObject<number>,
) {
  const seekSliderRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const progressThumbRef = useRef<HTMLDivElement>(null);
  const scrubTimeHudRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const durationTimeTextRef = useRef<HTMLSpanElement>(null);
  const showRemainingTimeRef = useRef(false);
  const lastPositionUiUpdateRef = useRef(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showRemainingTime, setShowRemainingTime] = useState(false);

  const syncPlaybackUi = useCallback((nextPosition: number, nextDuration: number) => {
    const safeDuration = Number.isFinite(nextDuration) ? Math.max(0, nextDuration) : 0;
    const safePosition = clampSeconds(nextPosition, safeDuration || undefined);
    const livePlayback = isLiveStreamRef.current;
    const progressRatio = livePlayback
      ? 1
      : safeDuration > 0 ? Math.min(1, Math.max(0, safePosition / safeDuration)) : 0;
    const progressPercent = progressRatio * 100;

    if (progressFillRef.current) {
      progressFillRef.current.style.transform = `scaleX(${progressRatio})`;
    }
    if (progressThumbRef.current) {
      progressThumbRef.current.style.left = `${progressPercent}%`;
    }
    if (scrubTimeHudRef.current) {
      scrubTimeHudRef.current.style.left = `${progressPercent}%`;
      scrubTimeHudRef.current.textContent = `${formatTime(safePosition)} / ${formatTime(safeDuration)}`;
    }
    if (currentTimeTextRef.current) {
      const displayTime = showRemainingTimeRef.current
        ? `-${formatTime(Math.max(0, safeDuration - safePosition))}`
        : formatTime(safePosition);
      currentTimeTextRef.current.textContent = displayTime;
    }
    if (durationTimeTextRef.current) {
      durationTimeTextRef.current.textContent = formatTime(safeDuration);
    }
    if (seekSliderRef.current) {
      seekSliderRef.current.setAttribute('aria-disabled', livePlayback || safeDuration <= 0 ? 'true' : 'false');
      seekSliderRef.current.setAttribute('aria-valuemax', livePlayback ? '100' : String(safeDuration || 0));
      seekSliderRef.current.setAttribute('aria-valuenow', livePlayback ? '100' : String(Math.min(safePosition, safeDuration || 0)));
      seekSliderRef.current.setAttribute('aria-valuetext', livePlayback ? 'Live' : seekAccessibilityText(safePosition, safeDuration));
    }
  }, [isLiveStreamRef]);

  const toggleTimeDisplay = useCallback(() => {
    const nextShowRemainingTime = !showRemainingTimeRef.current;
    showRemainingTimeRef.current = nextShowRemainingTime;
    setShowRemainingTime(nextShowRemainingTime);
    syncPlaybackUi(playbackPositionRef.current, playbackDurationRef.current);
  }, [syncPlaybackUi, playbackPositionRef, playbackDurationRef]);

  const updatePlaybackSnapshot = useCallback((
    nextPosition: number,
    nextDuration = playbackDurationRef.current,
    options: { forceReact?: boolean } = {},
  ) => {
    const safeDuration = Number.isFinite(nextDuration) ? Math.max(0, nextDuration) : 0;
    const safePosition = clampSeconds(nextPosition, safeDuration || undefined);
    playbackPositionRef.current = safePosition;
    playbackDurationRef.current = safeDuration;
    syncPlaybackUi(safePosition, safeDuration);

    const now = performance.now();
    if (options.forceReact || now - lastPositionUiUpdateRef.current >= POSITION_UI_UPDATE_INTERVAL_MS) {
      lastPositionUiUpdateRef.current = now;
      setPosition(safePosition);
      setDuration(safeDuration);
    }
  }, [syncPlaybackUi, playbackPositionRef, playbackDurationRef]);

  return { position, duration, showRemainingTime, syncPlaybackUi, toggleTimeDisplay, updatePlaybackSnapshot, seekSliderRef, progressFillRef, progressThumbRef, scrubTimeHudRef, currentTimeTextRef, durationTimeTextRef, playbackPositionRef, playbackDurationRef };
}
