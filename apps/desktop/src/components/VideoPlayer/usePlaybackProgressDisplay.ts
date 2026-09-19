import { useCallback, useRef, useState, type RefObject } from 'react';
import { clampSeconds, formatTime, seekAccessibilityText } from './helpers';

const POSITION_UI_UPDATE_INTERVAL_MS = 1000;

function updateText(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

function updateAttribute(element: HTMLElement, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

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
  const [clockEvents] = useState(() => new EventTarget());

  const syncPlaybackUi = useCallback((nextPosition: number, nextDuration: number) => {
    const safeDuration = Number.isFinite(nextDuration) ? Math.max(0, nextDuration) : 0;
    const safePosition = clampSeconds(nextPosition, safeDuration || undefined);
    const livePlayback = isLiveStreamRef.current;
    const progressRatio = livePlayback
      ? 1
      : safeDuration > 0 ? Math.min(1, Math.max(0, safePosition / safeDuration)) : 0;
    const progressPercent = progressRatio * 100;

    if (progressFillRef.current) {
      const transform = `scaleX(${progressRatio})`;
      if (progressFillRef.current.style.transform !== transform) progressFillRef.current.style.transform = transform;
    }
    if (progressThumbRef.current) {
      const left = `${progressPercent}%`;
      if (progressThumbRef.current.style.left !== left) progressThumbRef.current.style.left = left;
    }
    if (scrubTimeHudRef.current) {
      const left = `${progressPercent}%`;
      if (scrubTimeHudRef.current.style.left !== left) scrubTimeHudRef.current.style.left = left;
      updateText(scrubTimeHudRef.current, `${formatTime(safePosition)} / ${formatTime(safeDuration)}`);
    }
    if (currentTimeTextRef.current) {
      const displayTime = showRemainingTimeRef.current
        ? `-${formatTime(Math.max(0, safeDuration - safePosition))}`
        : formatTime(safePosition);
      updateText(currentTimeTextRef.current, displayTime);
    }
    if (durationTimeTextRef.current) {
      updateText(durationTimeTextRef.current, formatTime(safeDuration));
    }
    if (seekSliderRef.current) {
      updateAttribute(seekSliderRef.current, 'aria-disabled', livePlayback || safeDuration <= 0 ? 'true' : 'false');
      updateAttribute(seekSliderRef.current, 'aria-valuemax', livePlayback ? '100' : String(safeDuration || 0));
      updateAttribute(seekSliderRef.current, 'aria-valuenow', livePlayback ? '100' : String(Math.min(safePosition, safeDuration || 0)));
      updateAttribute(seekSliderRef.current, 'aria-valuetext', livePlayback ? 'Live' : seekAccessibilityText(safePosition, safeDuration));
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
    const changed = playbackPositionRef.current !== safePosition || playbackDurationRef.current !== safeDuration;
    if (!changed && !options.forceReact) return;
    playbackPositionRef.current = safePosition;
    playbackDurationRef.current = safeDuration;
    syncPlaybackUi(safePosition, safeDuration);
    if (changed) clockEvents.dispatchEvent(new Event('change'));

    const now = performance.now();
    if (options.forceReact || now - lastPositionUiUpdateRef.current >= POSITION_UI_UPDATE_INTERVAL_MS) {
      lastPositionUiUpdateRef.current = now;
      setPosition(safePosition);
      setDuration(safeDuration);
    }
  }, [syncPlaybackUi, playbackPositionRef, playbackDurationRef, clockEvents]);

  return { clockEvents, position, duration, showRemainingTime, syncPlaybackUi, toggleTimeDisplay, updatePlaybackSnapshot, seekSliderRef, progressFillRef, progressThumbRef, scrubTimeHudRef, currentTimeTextRef, durationTimeTextRef, playbackPositionRef, playbackDurationRef };
}
