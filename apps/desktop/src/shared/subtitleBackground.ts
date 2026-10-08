export const DEFAULT_SUBTITLE_BACKGROUND_OPACITY = 0.75;
export const MIN_SUBTITLE_BACKGROUND_BLUR_PERCENT = 55;
export const DEFAULT_SUBTITLE_BACKGROUND_BLUR_PERCENT = 55;

export function subtitleBackgroundBlurPx(percent: number): number {
  const amount = Number.isFinite(percent) ? percent : DEFAULT_SUBTITLE_BACKGROUND_BLUR_PERCENT;
  return Math.max(MIN_SUBTITLE_BACKGROUND_BLUR_PERCENT, Math.min(100, amount)) * 0.24;
}

type SubtitleBackground = {
  backgroundEnabled?: boolean;
  backgroundColor?: string;
  backgroundOpacity?: number;
};

/** CSS uses RGBA hex; native renderers convert this at their boundary. */
export function subtitleBackgroundColor(style: SubtitleBackground): string {
  if (!style.backgroundEnabled) return '#00000000';
  const color = typeof style.backgroundColor === 'string' && /^#[0-9a-f]{6}$/i.test(style.backgroundColor)
    ? style.backgroundColor : '#000000';
  const opacity = typeof style.backgroundOpacity === 'number' && Number.isFinite(style.backgroundOpacity)
    ? Math.max(0, Math.min(1, style.backgroundOpacity)) : DEFAULT_SUBTITLE_BACKGROUND_OPACITY;
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, '0');
  return `${color}${alpha}`;
}
