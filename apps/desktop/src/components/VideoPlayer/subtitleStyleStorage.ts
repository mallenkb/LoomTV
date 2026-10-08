import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_STYLE_KEY,
} from './constants.ts';
import type { SubtitleStyleSettings } from './types.ts';
import { MIN_SUBTITLE_BACKGROUND_BLUR_PERCENT } from '../../shared/subtitleBackground.ts';
import { MAX_SOFT_BOX_OPACITY, MIN_SOFT_BOX_OPACITY } from './subtitleStylePresets';

function clampStyleNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function styleColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^(transparent|#[0-9a-f]{6})$/i.test(value) ? value : fallback;
}

function normalizeSubtitleStyle(value: unknown): SubtitleStyleSettings {
  const style = value && typeof value === 'object' ? value as Partial<SubtitleStyleSettings> : {};
  const backgroundMode = style.backgroundMode === 'soft' || style.backgroundMode === 'solid'
    ? style.backgroundMode : style.backgroundOpacity === 1 ? 'solid' : 'soft';
  const softBox = style.backgroundEnabled === true && backgroundMode === 'soft';
  return {
    // Subtitle timing follows the active playback clock. Do not carry an old
    // manual offset into a new playback session.
    delaySeconds: DEFAULT_SUBTITLE_STYLE.delaySeconds,
    position: clampStyleNumber(style.position, DEFAULT_SUBTITLE_STYLE.position, 0, 100),
    scale: clampStyleNumber(style.scale, DEFAULT_SUBTITLE_STYLE.scale, 0.5, 2),
    fontSize: clampStyleNumber(style.fontSize, DEFAULT_SUBTITLE_STYLE.fontSize, 24, 96),
    fontColor: styleColor(style.fontColor, DEFAULT_SUBTITLE_STYLE.fontColor),
    borderColor: styleColor(style.borderColor, DEFAULT_SUBTITLE_STYLE.borderColor),
    borderWidth: clampStyleNumber(style.borderWidth, DEFAULT_SUBTITLE_STYLE.borderWidth, 0, 10),
    borderEnabled: typeof style.borderEnabled === 'boolean' ? style.borderEnabled : DEFAULT_SUBTITLE_STYLE.borderEnabled,
    backgroundColor: styleColor(style.backgroundColor, DEFAULT_SUBTITLE_STYLE.backgroundColor),
    backgroundEnabled: typeof style.backgroundEnabled === 'boolean' ? style.backgroundEnabled : DEFAULT_SUBTITLE_STYLE.backgroundEnabled,
    backgroundOpacity: clampStyleNumber(style.backgroundOpacity, DEFAULT_SUBTITLE_STYLE.backgroundOpacity,
      softBox ? MIN_SOFT_BOX_OPACITY : 0, softBox ? MAX_SOFT_BOX_OPACITY : 1),
    backgroundBlurPercent: clampStyleNumber(style.backgroundBlurPercent, DEFAULT_SUBTITLE_STYLE.backgroundBlurPercent, MIN_SUBTITLE_BACKGROUND_BLUR_PERCENT, 100),
    backgroundMode,
  };
}

export function loadSubtitleStyle(): SubtitleStyleSettings {
  try {
    return normalizeSubtitleStyle(JSON.parse(localStorage.getItem(SUBTITLE_STYLE_KEY) || 'null'));
  } catch {
    return DEFAULT_SUBTITLE_STYLE;
  }
}

export function saveSubtitleStyle(style: SubtitleStyleSettings): void {
  try {
    localStorage.setItem(SUBTITLE_STYLE_KEY, JSON.stringify(normalizeSubtitleStyle(style)));
  } catch {
    // Subtitle style still applies for the current session.
  }
}
