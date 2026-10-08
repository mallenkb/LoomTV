import type { SubtitleStyleSettings } from './types';
import { DEFAULT_SUBTITLE_BACKGROUND_BLUR_PERCENT } from '../../shared/subtitleBackground.ts';

export type SubtitleStylePreset = 'plain' | 'soft' | 'solid';
export const MIN_SOFT_BOX_OPACITY = 0.3;
export const MAX_SOFT_BOX_OPACITY = 0.7;

export function applySubtitleStylePreset(current: SubtitleStyleSettings, preset: SubtitleStylePreset): SubtitleStyleSettings {
  return {
    ...current,
    fontColor: '#ffffff',
    borderColor: '#000000',
    borderWidth: preset === 'plain' ? 6 : 3,
    borderEnabled: true,
    backgroundColor: '#000000',
    backgroundEnabled: preset !== 'plain',
    backgroundMode: preset === 'solid' ? 'solid' : 'soft',
    backgroundOpacity: preset === 'solid' ? 1 : MAX_SOFT_BOX_OPACITY,
    backgroundBlurPercent: DEFAULT_SUBTITLE_BACKGROUND_BLUR_PERCENT,
  };
}

export function selectedSubtitleStylePreset(style: SubtitleStyleSettings): SubtitleStylePreset {
  if (!style.backgroundEnabled) return 'plain';
  return style.backgroundMode ?? (style.backgroundOpacity === 1 ? 'solid' : 'soft');
}
