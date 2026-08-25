import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_STYLE_KEY,
} from './constants.ts';
import type { SubtitleStyleSettings } from './types.ts';

function clampStyleNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function styleColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^(transparent|#[0-9a-f]{6})$/i.test(value) ? value : fallback;
}

function normalizeSubtitleStyle(value: unknown): SubtitleStyleSettings {
  const style = value && typeof value === 'object' ? value as Partial<SubtitleStyleSettings> : {};
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
