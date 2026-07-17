import type { MobileThemeSettings } from './mobileDomain';
import type { MobileThemeColors } from './mobileStyles';

export type MobileThemeMode = 'auto' | 'dark' | 'light';
export type ResolvedMobileThemeMode = Exclude<MobileThemeMode, 'auto'>;

const MOBILE_ACCENTS: Record<string, Pick<MobileThemeColors,
  'accent' | 'accentSoft' | 'accentBorder' | 'accentForeground'>> = {
  yellow: { accent: '#fbc500', accentSoft: 'rgba(251,197,0,0.16)', accentBorder: 'rgba(251,197,0,0.45)', accentForeground: '#08101a' },
  red: { accent: '#931116', accentSoft: 'rgba(147,17,22,0.18)', accentBorder: 'rgba(147,17,22,0.48)', accentForeground: '#ffffff' },
  blue: { accent: '#8FB8FF', accentSoft: 'rgba(143,184,255,0.18)', accentBorder: 'rgba(143,184,255,0.48)', accentForeground: '#071322' },
  orange: { accent: '#FF9900', accentSoft: 'rgba(255,153,0,0.18)', accentBorder: 'rgba(255,153,0,0.48)', accentForeground: '#000000' },
};

const MOBILE_DARK_THEMES: Record<string, Pick<MobileThemeColors,
  'bg' | 'panel' | 'panel2' | 'border' | 'muted' | 'faint' | 'themeLabel'>> = {
  black: {
    bg: '#15151b', panel: '#202127', panel2: '#1a1b21', border: '#34363f',
    muted: '#b8b8c0', faint: '#7e808b', themeLabel: 'Cinematic',
  },
  default: {
    bg: '#1a1a1a', panel: '#232323', panel2: '#1d1d1d', border: '#2d2d2d',
    muted: '#a8a8a8', faint: '#777777', themeLabel: 'Default',
  },
  justwatch: {
    bg: '#060d17', panel: '#101a28', panel2: '#0b1420', border: '#243348',
    muted: '#9aa7b8', faint: '#647287', themeLabel: 'Navy Black',
  },
};

const MOBILE_LIGHT_THEME: Pick<MobileThemeColors,
  'bg' | 'panel' | 'panel2' | 'border' | 'muted' | 'faint' | 'themeLabel'> = {
  bg: '#f4f6f8', panel: '#ffffff', panel2: '#eef2f5', border: '#dce3e9',
  muted: '#525252', faint: '#737373', themeLabel: 'Light',
};

export const DEFAULT_MOBILE_THEME: MobileThemeColors = {
  ...MOBILE_ACCENTS.yellow,
  ...MOBILE_DARK_THEMES.black,
  text: '#ffffff',
};

export function mobileThemeFromSettings(
  settings?: MobileThemeSettings,
  mode: ResolvedMobileThemeMode = 'dark',
): MobileThemeColors {
  const accentTheme = MOBILE_ACCENTS[settings?.appThemeColor || ''] || MOBILE_ACCENTS.yellow;
  const light = mode === 'light';
  return {
    ...accentTheme,
    ...(light ? MOBILE_LIGHT_THEME : MOBILE_DARK_THEMES[settings?.appDarkTheme || ''] || MOBILE_DARK_THEMES.black),
    accentForeground: light && settings?.appThemeColor === 'yellow' ? '#000000' : accentTheme.accentForeground,
    text: light ? '#000000' : '#ffffff',
  };
}
