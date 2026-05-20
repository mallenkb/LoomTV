import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_SUBTITLE_OUTLINE_WIDTH } from './constants';
import type { SubtitleCue } from './helpers';
import type { SubtitleStyleSettings } from './types';

interface SubtitleOverlayProps {
  cues: SubtitleCue[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  transcodeStartSecondsRef: React.RefObject<number>;
  streamIsTranscoded: boolean;
  style: SubtitleStyleSettings;
  visible: boolean;
}

function roundedTextOutline(width: number, color: string): string {
  const radius = Math.round(width);
  if (radius <= 0) return 'none';

  const shadows = new Set<string>();
  const ringStep = radius > 10 ? 2 : 1;
  for (let ring = 1; ring <= radius; ring += ringStep) {
    const points = Math.max(16, Math.ceil((Math.PI * 2 * ring) / 2));
    for (let index = 0; index < points; index += 1) {
      const angle = (index / points) * Math.PI * 2;
      const x = Math.round(Math.cos(angle) * ring);
      const y = Math.round(Math.sin(angle) * ring);
      if (x !== 0 || y !== 0) shadows.add(`${x}px ${y}px 0 ${color}`);
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

/**
 * Renders the active subtitle cue as a styled DOM overlay instead of relying on
 * burned-in (transcoded) text or ::cue rules. Every style property is applied
 * inline from `style`, so size/color/outline changes take effect immediately.
 */
export default function SubtitleOverlay({
  cues,
  videoRef,
  transcodeStartSecondsRef,
  streamIsTranscoded,
  style,
  visible,
}: SubtitleOverlayProps) {
  const [text, setText] = useState('');
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
      if (video) {
        const offset = streamIsTranscoded ? transcodeStartSecondsRef.current || 0 : 0;
        const time = video.currentTime + offset - style.delaySeconds;
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
  }, [sortedCues, videoRef, transcodeStartSecondsRef, streamIsTranscoded, style.delaySeconds, visible]);

  if (!visible || !text) return null;

  const fontSize = Math.round(style.fontSize * style.scale);
  const outlineWidth = style.borderEnabled
    ? Math.max(0, Math.min(MAX_SUBTITLE_OUTLINE_WIDTH, style.borderWidth))
    : 0;
  const verticalPosition = Math.max(0, Math.min(100, style.position));
  const textShadow = roundedTextOutline(outlineWidth, style.borderColor);
  const lineHeight = style.backgroundEnabled ? 1.42 : 1.3;
  const subtitleTextStyle = {
    color: style.fontColor,
    whiteSpace: 'pre-wrap',
    fontWeight: 600,
    lineHeight,
    textShadow,
    backgroundColor: style.backgroundEnabled ? style.backgroundColor : 'transparent',
    padding: style.backgroundEnabled ? '0.06em 0.38em' : 0,
    borderRadius: style.backgroundEnabled ? '8px' : 0,
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  } satisfies React.CSSProperties;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-30 px-[5%] text-center"
      style={{
        bottom: `${100 - verticalPosition}%`,
        fontSize: `${fontSize}px`,
        lineHeight,
      }}
    >
      <span style={subtitleTextStyle}>
        {text}
      </span>
    </div>
  );
}
