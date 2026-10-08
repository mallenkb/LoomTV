import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { MAX_SUBTITLE_OUTLINE_WIDTH } from './constants';
import type { SubtitleStyleSettings } from './types';
import { selectedSubtitleStylePreset } from './subtitleStylePresets';
import type { SubtitleBlurRegion } from '../../shared/playbackProtocol';
import { subtitleBackgroundBlurPx, subtitleBackgroundColor } from '../../shared/subtitleBackground.ts';

interface LineBounds { left: number; right: number; top: number; bottom: number }
type Point = [number, number];

/** One continuous outline prevents seams and repeated opacity between lines. */
function roundedLineOutline(lines: LineBounds[]): string {
  if (!lines.length) return '';
  const points: Point[] = [[lines[0].left, lines[0].top], [lines[0].right, lines[0].top]];
  lines.forEach((line, index) => {
    points.push([line.right, line.bottom]);
    if (index + 1 < lines.length) points.push([lines[index + 1].right, line.bottom]);
  });
  const last = lines[lines.length - 1];
  points.push([last.left, last.bottom]);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    points.push([lines[index].left, lines[index].top]);
    if (index > 0) points.push([lines[index - 1].left, lines[index].top]);
  }
  let outline = points.filter((point, index) => index === 0
    || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]);
  if (outline.at(-1)?.[0] === outline[0][0] && outline.at(-1)?.[1] === outline[0][1]) outline.pop();
  outline = outline.filter((point, index, all) => {
    const previous = all[(index - 1 + all.length) % all.length];
    const next = all[(index + 1) % all.length];
    return !((previous[0] === point[0] && point[0] === next[0])
      || (previous[1] === point[1] && point[1] === next[1]));
  });
  const corners = outline.map((point, index) => {
    const previous = outline[(index - 1 + outline.length) % outline.length];
    const next = outline[(index + 1) % outline.length];
    const before = Math.hypot(previous[0] - point[0], previous[1] - point[1]);
    const after = Math.hypot(next[0] - point[0], next[1] - point[1]);
    const radius = Math.min(12, before / 2, after / 2);
    return {
      point,
      start: [point[0] + (previous[0] - point[0]) * radius / before,
        point[1] + (previous[1] - point[1]) * radius / before],
      end: [point[0] + (next[0] - point[0]) * radius / after,
        point[1] + (next[1] - point[1]) * radius / after],
    };
  });
  return `M ${corners[0].start.join(' ')} ${corners.map(corner => (
    `L ${corner.start.join(' ')} Q ${corner.point.join(' ')} ${corner.end.join(' ')}`
  )).join(' ')} Z`;
}

function textOutline(width: number, color: string): string {
  const radius = Math.ceil(width);
  if (radius <= 0) return 'none';
  const shadows = new Set<string>();
  for (let ring = 1; ring <= radius; ring += 1) {
    const points = Math.max(12, ring * 8);
    for (let index = 0; index < points; index += 1) {
      const angle = index / points * Math.PI * 2;
      shadows.add(`${(Math.cos(angle) * ring).toFixed(2)}px ${(Math.sin(angle) * ring).toFixed(2)}px 0 ${color}`);
    }
  }
  return Array.from(shadows).join(', ');
}

export default function StyledSubtitleText({ text, style, fontSize, onBlurLayout }: {
  text: string;
  style: SubtitleStyleSettings;
  fontSize: number;
  onBlurLayout?: (region: SubtitleBlurRegion | null) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [outline, setOutline] = useState('');
  // With 0.28em of vertical padding, extra spacing drops from 0.70em to 0.49em.
  const lineHeight = style.backgroundEnabled ? 1.21 : 1.3;
  const borderWidth = style.borderEnabled && !style.backgroundEnabled
    ? Math.max(0, Math.min(MAX_SUBTITLE_OUTLINE_WIDTH, style.borderWidth)) : 0;
  const shadow = useMemo(() => textOutline(Math.min(borderWidth, 4), style.borderColor), [borderWidth, style.borderColor]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !style.backgroundEnabled) return;
    const measure = () => {
      if (!node.offsetWidth) return;
      const lines = Array.from(node.querySelectorAll<HTMLSpanElement>('[data-subtitle-line]')).map(line => ({
        left: line.offsetLeft,
        right: line.offsetLeft + line.offsetWidth,
        top: line.offsetTop,
        bottom: line.offsetTop + line.offsetHeight,
      }));
      const next = roundedLineOutline(lines);
      setOutline(current => current === next ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, fontSize, lineHeight, style.backgroundEnabled]);

  const softBox = selectedSubtitleStylePreset(style) === 'soft';
  useLayoutEffect(() => {
    if (!onBlurLayout) return;
    const node = ref.current;
    if (!node || !softBox || style.backgroundOpacity >= 1) {
      onBlurLayout(null);
      return;
    }
    const measure = () => {
      const lines = Array.from(node.querySelectorAll<HTMLSpanElement>('[data-subtitle-line]')).slice(0, 32)
        .map(line => {
          const rect = line.getBoundingClientRect();
          return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        }).filter(line => line.width > 0 && line.height > 0);
      onBlurLayout(lines.length ? { lines, radius: subtitleBackgroundBlurPx(style.backgroundBlurPercent), cornerRadius: 12 } : null);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.parentElement?.parentElement) observer.observe(node.parentElement.parentElement);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    // The controls animate the subtitle position. Measure that movement without
    // polling during steady playback. Native IPC deduplicates unchanged bounds.
    let frame = 0;
    let until = 0;
    const animate = (now: number) => {
      measure();
      if (now < until) frame = requestAnimationFrame(animate);
    };
    const trackMovement = () => {
      cancelAnimationFrame(frame);
      until = performance.now() + 400;
      frame = requestAnimationFrame(animate);
    };
    node.parentElement?.addEventListener('transitionrun', trackMovement);
    measure();
    trackMovement();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      node.parentElement?.removeEventListener('transitionrun', trackMovement);
      onBlurLayout(null);
    };
  }, [text, fontSize, lineHeight, softBox, style.backgroundOpacity, style.backgroundBlurPercent, onBlurLayout]);

  const textStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'center',
    maxWidth: '100%',
    verticalAlign: 'bottom',
    fontSize,
    lineHeight,
    color: style.fontColor,
    fontWeight: style.backgroundEnabled ? 700 : 600,
    textShadow: shadow,
    WebkitTextStroke: borderWidth > 0 ? `${borderWidth}px ${style.borderColor}` : undefined,
    paintOrder: 'stroke fill',
  };
  const blur = softBox
    ? `blur(${subtitleBackgroundBlurPx(style.backgroundBlurPercent)}px)` : 'none';
  return (
    <span ref={ref} style={textStyle}>
      {style.backgroundEnabled && (
        <span aria-hidden="true" style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: subtitleBackgroundColor(style),
          backdropFilter: blur,
          WebkitBackdropFilter: blur,
          borderRadius: 12,
          clipPath: outline ? `path("${outline}")` : undefined,
        }} />
      )}
      {text.split(/\r?\n/).map((line, index) => (
        <span key={index} data-subtitle-line style={{
          position: 'relative',
          display: 'inline-block',
          maxWidth: '100%',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          padding: style.backgroundEnabled ? '0.14em 0.5em' : '0 0.04em',
        }}>{line || '\u00a0'}</span>
      ))}
    </span>
  );
}
