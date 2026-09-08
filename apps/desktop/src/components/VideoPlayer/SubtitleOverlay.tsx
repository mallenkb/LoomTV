import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MAX_SUBTITLE_OUTLINE_WIDTH } from './constants';
import { activeSubtitleText, type SubtitleCue } from './helpers';
import type { SubtitleStyleSettings } from './types';
import { subtitleMediaSeconds } from './playbackClock';

interface SubtitleOverlayProps {
  controlsVisible: boolean;
  cues: SubtitleCue[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTimeRef?: React.RefObject<number>;
  timelineOffsetRef?: React.RefObject<number>;
  seekableTimelineRef?: React.RefObject<boolean>;
  style: SubtitleStyleSettings;
  visible: boolean;
}

function fallbackTextOutline(width: number, color: string): string {
  const radius = Math.ceil(width);
  if (radius <= 0) return 'none';

  const shadows = new Set<string>();
  for (let ring = 1; ring <= radius; ring += 1) {
    const points = Math.max(12, ring * 8);
    for (let index = 0; index < points; index += 1) {
      const angle = (index / points) * Math.PI * 2;
      const x = Math.cos(angle) * ring;
      const y = Math.sin(angle) * ring;
      shadows.add(`${x.toFixed(2)}px ${y.toFixed(2)}px 0 ${color}`);
    }
  }

  return Array.from(shadows).join(', ');
}

function SubtitleOverlay({
  controlsVisible,
  cues,
  videoRef,
  currentTimeRef,
  timelineOffsetRef,
  seekableTimelineRef,
  style,
  visible,
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

    let frame = 0;
    const tick = () => {
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
        const next = activeSubtitleText(sortedCues, time, prefixEndTimes);
        if (next !== textRef.current) {
          textRef.current = next;
          setText(next);
        }
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sortedCues, prefixEndTimes, videoRef, currentTimeRef, timelineOffsetRef, seekableTimelineRef, visible]);

  const textShadow = useMemo(() => {
    const outlineWidth = style.borderEnabled
      ? Math.max(0, Math.min(MAX_SUBTITLE_OUTLINE_WIDTH, style.borderWidth))
      : 0;
    return fallbackTextOutline(Math.min(outlineWidth, 4), style.borderColor);
  }, [style.borderEnabled, style.borderWidth, style.borderColor]);

  const fontSize = Math.round(style.fontSize * style.scale);
  const outlineWidth = style.borderEnabled
    ? Math.max(0, Math.min(MAX_SUBTITLE_OUTLINE_WIDTH, style.borderWidth))
    : 0;
  const verticalPosition = Math.max(0, Math.min(100, style.position));
  const lineHeight = style.backgroundEnabled ? 1.42 : 1.3;

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
  }, [fontSize, lineHeight, text, visible]);

  if (!visible || !text) return null;

  const baseBottomPx = bounds.viewportHeight * ((100 - verticalPosition) / 100);
  const desiredBottomPx = baseBottomPx + (controlsVisible ? 128 : 0);
  const maxBottomPx = Math.max(0, bounds.viewportHeight - bounds.blockHeight - 16);
  const bottom = bounds.viewportHeight > 0
    ? `${Math.min(desiredBottomPx, maxBottomPx)}px`
    : `calc(${100 - verticalPosition}% + ${controlsVisible ? 128 : 0}px)`;
  const subtitleTextStyle = {
    color: style.fontColor,
    whiteSpace: 'pre-wrap',
    fontWeight: 600,
    lineHeight,
    textShadow,
    WebkitTextStroke: outlineWidth > 0 ? `${outlineWidth}px ${style.borderColor}` : undefined,
    paintOrder: 'stroke fill',
    backgroundColor: style.backgroundEnabled ? style.backgroundColor : 'transparent',
    padding: style.backgroundEnabled ? '0.06em 0.38em' : '0 0.04em',
    borderRadius: style.backgroundEnabled ? '8px' : 0,
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  } satisfies React.CSSProperties;

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
      <span style={subtitleTextStyle}>{text}</span>
    </div>
  );
}

export default memo(SubtitleOverlay);
