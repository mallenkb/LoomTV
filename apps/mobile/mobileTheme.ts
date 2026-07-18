import type { MobileThemeSettings } from './mobileDomain';
import type { MobileThemeColors } from './mobileStyles';

export type MobileThemeMode = 'auto' | 'dark' | 'light';
export type ResolvedMobileThemeMode = Exclude<MobileThemeMode, 'auto'>;
export type MobileThemeColor = 'yellow' | 'red' | 'blue' | 'orange' | 'twitch';

export const MOBILE_THEME_COLOR_OPTIONS: ReadonlyArray<{ value: MobileThemeColor; label: string; color: string }> = [
  { value: 'yellow', label: 'Orange', color: '#FF9900' },
  { value: 'red', label: 'Netflix', color: '#E50914' },
  { value: 'blue', label: 'Paramount', color: '#0064FF' },
  { value: 'orange', label: 'Disney', color: '#02D6E8' },
  { value: 'twitch', label: 'Twitch', color: '#9146FF' },
];

const MOBILE_ACCENTS: Record<string, Pick<MobileThemeColors,
  'accent' | 'accentSoft' | 'accentBorder' | 'accentForeground'>> = {
  yellow: { accent: '#FC9C03', accentSoft: 'rgba(252,156,3,0.18)', accentBorder: 'rgba(252,156,3,0.48)', accentForeground: '#000000' },
  red: { accent: '#E20C17', accentSoft: 'rgba(226,12,23,0.18)', accentBorder: 'rgba(226,12,23,0.48)', accentForeground: '#ffffff' },
  blue: { accent: '#0367FC', accentSoft: 'rgba(3,103,252,0.18)', accentBorder: 'rgba(3,103,252,0.48)', accentForeground: '#ffffff' },
  orange: { accent: '#05D3EB', accentSoft: 'rgba(5,211,235,0.18)', accentBorder: 'rgba(5,211,235,0.48)', accentForeground: '#001719' },
  twitch: { accent: '#9449FC', accentSoft: 'rgba(148,73,252,0.18)', accentBorder: 'rgba(148,73,252,0.48)', accentForeground: '#ffffff' },
};

const MOBILE_DARK_THEME: Pick<MobileThemeColors,
  'bg' | 'panel' | 'panel2' | 'border' | 'muted' | 'faint' | 'themeLabel'> = {
  bg: '#121212', panel: '#171717', panel2: '#0f0f0f', border: '#262626',
  muted: '#a3a3a3', faint: '#737373', themeLabel: 'Black',
};

const MOBILE_LIGHT_THEME: Pick<MobileThemeColors,
  'bg' | 'panel' | 'panel2' | 'border' | 'muted' | 'faint' | 'themeLabel'> = {
  bg: '#f5f5f5', panel: '#ffffff', panel2: '#eef2f5', border: '#dce3e9',
  muted: '#525252', faint: '#737373', themeLabel: 'Light',
};

export const DEFAULT_MOBILE_THEME: MobileThemeColors = {
  ...MOBILE_ACCENTS.yellow,
  ...MOBILE_DARK_THEME,
  text: '#fafafa',
};

export function mobileThemeFromSettings(
  settings?: MobileThemeSettings,
  mode: ResolvedMobileThemeMode = 'dark',
): MobileThemeColors {
  const accentTheme = MOBILE_ACCENTS[settings?.appThemeColor || ''] || MOBILE_ACCENTS.yellow;
  const light = mode === 'light';
  return {
    ...accentTheme,
    ...(light ? MOBILE_LIGHT_THEME : MOBILE_DARK_THEME),
    accentForeground: accentTheme.accentForeground,
    text: light ? '#000000' : '#fafafa',
  };
}
