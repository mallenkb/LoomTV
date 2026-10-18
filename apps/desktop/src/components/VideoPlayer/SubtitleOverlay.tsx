import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeSubtitleText, type SubtitleCue } from './helpers';
import type { SubtitleStyleSettings } from './types';
import { subtitleCueSeconds, subtitleMediaSeconds } from './playbackClock';
import StyledSubtitleText from './StyledSubtitleText';
import { DEFAULT_SUBTITLE_STYLE } from './constants';
import type { SubtitleBlurRegion } from '../../shared/playbackProtocol';

/** Seek row (24px + 8px gap) plus the 56px button row, with a small margin. */
const CONTROL_BAR_CLEARANCE_PX = 100;

interface SubtitleOverlayProps {
  controlsVisible: boolean;
  cues: SubtitleCue[];
  delaySeconds?: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTimeRef?: React.RefObject<number>;
  timelineOffsetRef?: React.RefObject<number>;
  seekableTimelineRef?: React.RefObject<boolean>;
  style: SubtitleStyleSettings;
  visible: boolean;
  paused: boolean;
  clockEvents: EventTarget;
  onBlurLayout?: (region: SubtitleBlurRegion | null) => void;
}

function SubtitleOverlay({
  controlsVisible,
  cues,
  delaySeconds = 0,
  videoRef,
  currentTimeRef,
  timelineOffsetRef,
  seekableTimelineRef,
  style,
  visible,
  paused,
  clockEvents,
  onBlurLayout,
}: SubtitleOverlayProps) {
  const [text, setText] = useState('');
  const [bounds, setBounds] = useState({ blockHeight: 0, viewportHeight: 0 });
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef('');
  const sortedCues = useMemo(
    () => cues.slice().sort((a, b) => a.start - b.start || a.end - b.end),
    [cues],
  );
  const prefixEndTimes = useMemo(() => {
    let latestEnd = -Infinity;
    return sortedCues.map(cue => {
      latestEnd = Math.max(latestEnd, cue.end);
      return latestEnd;
    });
  }, [sortedCues]);

  useEffect(() => {
    if (!visible || sortedCues.length === 0) {
      textRef.current = '';
      setText('');
      return;
    }

    let frame: number | null = null;
    const video = videoRef.current;
    const refresh = () => {
      if (document.hidden) return;
      const video = videoRef.current;
      const nativeTime = currentTimeRef?.current;
      if (video || (typeof nativeTime === 'number' && Number.isFinite(nativeTime))) {
        // Cues use absolute media time, even when a restarted stream starts at zero.
        const time = subtitleMediaSeconds(
          video?.currentTime ?? 0,
          nativeTime,
          timelineOffsetRef?.current,
          seekableTimelineRef?.current,
        );
        const next = activeSubtitleText(sortedCues, subtitleCueSeconds(time, delaySeconds), prefixEndTimes);
        if (next !== textRef.current) {
          textRef.current = next;
          setText(next);
        }
      }
    };
    const update = () => {
      refresh();
      const playing = currentTimeRef ? !paused : video && !video.paused && !video.ended;
      if (!document.hidden && playing) {
        if (frame === null) {
          frame = requestAnimationFrame(() => {
            frame = null;
            update();
          });
        }
      } else if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };
    const events = ['play', 'pause', 'seeking', 'seeked', 'timeupdate', 'loadedmetadata', 'emptied'];
    events.forEach(event => video?.addEventListener(event, update));
    clockEvents.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      events.forEach(event => video?.removeEventListener(event, update));
      clockEvents.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [sortedCues, prefixEndTimes, videoRef, currentTimeRef, timelineOffsetRef, seekableTimelineRef, visible, paused, clockEvents, delaySeconds]);

  const fontSize = Math.round(style.fontSize * style.scale);
  const verticalPosition = Math.max(0, Math.min(100, style.position));
  const lineHeight = style.backgroundEnabled ? 1.21 : 1.3;

  useLayoutEffect(() => {
    const node = overlayRef.current;
    const viewport = node?.parentElement;
    if (!node || !viewport || !visible || !text) return undefined;

    const measure = () => {
      const nextBounds = {
        blockHeight: node.offsetHeight,
        viewportHeight: viewport.clientHeight,
      };
      setBounds((current) => (
        current.blockHeight === nextBounds.blockHeight
        && current.viewportHeight === nextBounds.viewportHeight
          ? current
          : nextBounds
      ));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fontSize, lineHeight, style.backgroundEnabled, text, visible]);

  if (!visible || !text) return null;

  const baseBottomPx = bounds.viewportHeight * ((100 - verticalPosition) / 100);
  // While the controls show, every position lifts by what the Bottom preset
  // needs to clear the seek bar, then drops back by the same amount.
  const bottomPresetPx = bounds.viewportHeight * ((100 - DEFAULT_SUBTITLE_STYLE.position) / 100);
  const controlsLiftPx = controlsVisible ? Math.max(0, CONTROL_BAR_CLEARANCE_PX - bottomPresetPx) : 0;
  const maxBottomPx = Math.max(0, bounds.viewportHeight - bounds.blockHeight - 16);
  const bottom = bounds.viewportHeight > 0
    ? `${Math.min(baseBottomPx + controlsLiftPx, maxBottomPx)}px`
    : controlsVisible
      ? `calc(${100 - verticalPosition}% + max(0px, ${CONTROL_BAR_CLEARANCE_PX}px - ${100 - DEFAULT_SUBTITLE_STYLE.position}%))`
      : `${100 - verticalPosition}%`;

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-x-0 z-[1] px-[5%] text-center"
      style={{
        bottom,
        fontSize: `${fontSize}px`,
        lineHeight,
        transition: 'bottom 300ms ease-out',
      }}
    >
      <StyledSubtitleText text={text} style={style} fontSize={fontSize} onBlurLayout={onBlurLayout} />
    </div>
  );
}

export default memo(SubtitleOverlay);
