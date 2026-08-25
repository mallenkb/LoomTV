import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MAX_SUBTITLE_OUTLINE_WIDTH } from './constants';
import type { SubtitleCue } from './helpers';
import type { SubtitleStyleSettings } from './types';

interface SubtitleOverlayProps {
  controlsVisible: boolean;
  cues: SubtitleCue[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  transcodeStartSecondsRef: React.RefObject<number>;
  streamIsSeekableRef: React.RefObject<boolean>;
  streamIsTranscoded: boolean;
  currentTimeRef?: React.RefObject<number>;
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

function findActiveCueIndex(cues: SubtitleCue[], time: number, hintIndex: number): number {
  const hintedCue = cues[hintIndex];
  if (hintedCue && time >= hintedCue.start && time < hintedCue.end) return hintIndex;

  if (hintedCue && hintIndex >= 0) {
    if (time >= hintedCue.end) {
      for (let index = hintIndex + 1; index < cues.length; index += 1) {
        const cue = cues[index];
        if (time < cue.start) return -1;
        if (time < cue.end) return index;
      }
      return -1;
    }

    for (let index = hintIndex - 1; index >= 0; index -= 1) {
      const cue = cues[index];
      if (time >= cue.start && time < cue.end) return index;
      if (time >= cue.end) return -1;
    }
  }

  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (cues[middle].start <= time) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (candidate >= 0 && time < cues[candidate].end) return candidate;
  return -1;
}

function SubtitleOverlay({
  controlsVisible,
  cues,
  videoRef,
  transcodeStartSecondsRef,
  streamIsSeekableRef,
  streamIsTranscoded,
  currentTimeRef,
  style,
  visible,
}: SubtitleOverlayProps) {
  const [text, setText] = useState('');
  const [bounds, setBounds] = useState({ blockHeight: 0, viewportHeight: 0 });
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef('');
  const activeCueIndexRef = useRef(-1);
  const sortedCues = useMemo(
    () => cues.slice().sort((a, b) => a.start - b.start || a.end - b.end),
    [cues],
  );

  useEffect(() => {
    if (!visible || sortedCues.length === 0) {
      textRef.current = '';
      activeCueIndexRef.current = -1;
      setText('');
      return;
    }

    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      const nativeTime = currentTimeRef?.current;
      if (video || (typeof nativeTime === 'number' && Number.isFinite(nativeTime))) {
        const offset = video && streamIsTranscoded && !streamIsSeekableRef.current
          ? transcodeStartSecondsRef.current || 0
          : 0;
        // Keep cue timing on the same clock as playback. Resume offsets are
        // applied only for a non-seekable transcoded window; subtitle delay is
        // intentionally not added here.
        const time = (video?.currentTime ?? nativeTime ?? 0) + offset;
        const cueIndex = findActiveCueIndex(sortedCues, time, activeCueIndexRef.current);
        activeCueIndexRef.current = cueIndex;
        const next = cueIndex >= 0 ? sortedCues[cueIndex].text : '';
        if (next !== textRef.current) {
          textRef.current = next;
          setText(next);
        }
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sortedCues, videoRef, transcodeStartSecondsRef, streamIsSeekableRef, streamIsTranscoded, currentTimeRef, visible]);

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
