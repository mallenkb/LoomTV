import { z } from 'zod';
import { parseStoredValue } from './desktopDecoders.ts';

export type AppThemeMode = 'dark' | 'light';
// The original color ids remain stable because they are persisted in settings.
export type AppThemeColor = 'red' | 'blue' | 'orange' | 'yellow' | 'twitch';
export type AppDarkTheme = 'black';
export type AppLoaderStyle = 'play-mark' | 'logo-mark' | 'horizontal-logo';
export type AppHomeStyle = 'default' | 'modern';
export type AppModernHeroMode = 'continue-watching' | 'featured';

export type AppThemeSettings = {
  mode: AppThemeMode;
  color: AppThemeColor;
  darkTheme: AppDarkTheme;
  loaderStyle: AppLoaderStyle;
  homeStyle: AppHomeStyle;
  modernHeroMode: AppModernHeroMode;
};

export const DEFAULT_THEME_SETTINGS: AppThemeSettings = {
  mode: 'dark',
  color: 'yellow',
  darkTheme: 'black',
  loaderStyle: 'play-mark',
  homeStyle: 'default',
  modernHeroMode: 'continue-watching',
};

export const THEME_CACHE_KEY = 'loomtv:theme-settings';
const cachedThemeSchema = z.object({
  mode: z.enum(['dark', 'light']).optional(),
  color: z.enum(['red', 'blue', 'orange', 'yellow', 'twitch']).optional(),
  darkTheme: z.literal('black').optional(),
  loaderStyle: z.enum(['play-mark', 'logo-mark', 'horizontal-logo']).optional(),
  homeStyle: z.enum(['default', 'modern']).optional(),
  modernHeroMode: z.enum(['continue-watching', 'featured']).optional(),
});

export const THEME_COLORS: Record<AppThemeColor, { label: string; hex: string; hover: string; foreground: string; foregroundMuted: string }> = {
  yellow: { label: 'Sunbeam', hex: '#FC9C03', hover: '#FCB303', foreground: '#0a0a0a', foregroundMuted: '#404040' },
  red: { label: 'Ember', hex: '#E20C17', hover: '#F31520', foreground: '#ffffff', foregroundMuted: '#ffffff' },
  blue: { label: 'Cobalt', hex: '#0367FC', hover: '#1D78FC', foreground: '#ffffff', foregroundMuted: '#ffffff' },
  orange: { label: 'Tide', hex: '#05D3EB', hover: '#27E0F5', foreground: '#001719', foregroundMuted: '#123C40' },
  twitch: { label: 'Aurora', hex: '#9449FC', hover: '#AC73FC', foreground: '#ffffff', foregroundMuted: '#ffffff' },
};

export const DARK_THEMES: Record<AppDarkTheme, {
  label: string;
  description: string;
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  sidebar: string;
  muted: string;
  faint: string;
  border: string;
  panel: string;
  panelBorder: string;
  bodyStart: string;
  bodyEnd: string;
}> = {
  // Dark surfaces sit on Tailwind's Neutral scale (pure grays, no color cast):
  // 950 #0a0a0a · 900 #171717 · 800 #262626 · 700 #404040 · 500 #737373 · 400 #a3a3a3.
  black: {
    label: 'Black',
    description: 'True black-style dark mode built on neutral-950.',
    bg: '#0a0a0a',
    surface: '#171717',
    surface2: '#0f0f0f',
    surface3: '#262626',
    sidebar: '#0a0a0a',
    muted: '#a3a3a3',
    faint: '#737373',
    border: '#262626',
    panel: 'rgba(23, 23, 23, 0.88)',
    panelBorder: 'rgba(255, 255, 255, 0.10)',
    bodyStart: '#0a0a0a',
    bodyEnd: '#0a0a0a',
  },
};

const MODERN_DARK_PALETTE = {
  bg: '#000000',
  surface: '#111111',
  surface2: '#0b0b0c',
  surface3: '#202022',
  sidebar: '#000000',
  muted: 'rgba(255, 255, 255, 0.62)',
  faint: 'rgba(255, 255, 255, 0.38)',
  border: 'rgba(255, 255, 255, 0.08)',
  panel: 'rgba(12, 12, 14, 0.72)',
  panelBorder: 'rgba(255, 255, 255, 0.10)',
  bodyStart: '#000000',
  bodyEnd: '#000000',
} satisfies Omit<(typeof DARK_THEMES)[AppDarkTheme], 'label' | 'description'>;

export function normalizeThemeMode(value?: string): AppThemeMode {
  return value === 'light' ? 'light' : 'dark';
}

export function normalizeThemeColor(value?: string): AppThemeColor {
  return value === 'yellow' || value === 'red' || value === 'blue' || value === 'orange' || value === 'twitch'
    ? value
    : DEFAULT_THEME_SETTINGS.color;
}

export function normalizeDarkTheme(value?: string): AppDarkTheme {
  return value === 'black' ? value : DEFAULT_THEME_SETTINGS.darkTheme;
}

export function normalizeLoaderStyle(value?: string): AppLoaderStyle {
  return value === 'logo-mark' || value === 'horizontal-logo' || value === 'play-mark'
    ? value
    : DEFAULT_THEME_SETTINGS.loaderStyle;
}

export function normalizeHomeStyle(value?: string): AppHomeStyle {
  return value === 'modern' ? 'modern' : 'default';
}

export function normalizeModernHeroMode(value?: string): AppModernHeroMode {
  return value === 'featured' ? 'featured' : 'continue-watching';
}

export function normalizeThemeSettings(settings: Partial<AppThemeSettings> = {}): AppThemeSettings {
  const homeStyle = normalizeHomeStyle(settings.homeStyle);
  return {
    // Modern is a single cinematic dark experience. Keeping this invariant here
    // also migrates older saved Light + Modern combinations safely.
    mode: homeStyle === 'modern' ? 'dark' : normalizeThemeMode(settings.mode),
    color: normalizeThemeColor(settings.color),
    darkTheme: normalizeDarkTheme(settings.darkTheme),
    loaderStyle: normalizeLoaderStyle(settings.loaderStyle),
    homeStyle,
    modernHeroMode: normalizeModernHeroMode(settings.modernHeroMode),
  };
}

export function readCachedTheme(): AppThemeSettings | null {
  if (typeof window === 'undefined') return null;
  try {
    const cachedTheme = parseStoredValue(
      window.localStorage.getItem(THEME_CACHE_KEY),
      cachedThemeSchema.nullable(),
      null,
    );
    return cachedTheme ? normalizeThemeSettings(cachedTheme) : null;
  } catch {
    return null;
  }
}

export function writeCachedTheme(theme: AppThemeSettings) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(normalizeThemeSettings(theme)));
  } catch {}
}

export function applyTheme(settings: Partial<AppThemeSettings> = {}) {
  const requestedMode = normalizeThemeMode(settings.mode);
  const color = normalizeThemeColor(settings.color);
  const darkTheme = normalizeDarkTheme(settings.darkTheme);
  const homeStyle = normalizeHomeStyle(settings.homeStyle);
  const mode = homeStyle === 'modern' ? 'dark' : requestedMode;
  const palette = THEME_COLORS[color];
  const darkPalette = DARK_THEMES[darkTheme];
  // Light surfaces mirror the dark ramp on Tailwind Neutral:
  // 100 #f5f5f5 · 200 #e5e5e5 · 500 #737373 · 600 #525252 · 900 #171717.
  // The canvas sits at neutral-100 so white cards read as elevated surfaces;
  // a white-on-#fafafa scheme has no visible hierarchy.
  const lightPalette = {
    bg: '#f5f5f5',
    surface: '#ffffff',
    surface2: '#f5f5f5',
    surface3: '#e5e5e5',
    sidebar: '#f5f5f5',
    muted: '#525252',
    faint: '#737373',
    border: '#e5e5e5',
    panel: 'rgba(255, 255, 255, 0.94)',
    panelBorder: 'rgba(10, 10, 10, 0.08)',
    bodyStart: '#f5f5f5',
    bodyEnd: '#f5f5f5',
  };
  // Modern's stylesheet declares its own cinematic palette, but applyTheme()
  // writes these tokens inline on the root and therefore wins the cascade.
  // Select that palette here too so Home, its artwork fades/search overlay,
  // and the other Modern pages all resolve against the same canvas colour.
  const themePalette = homeStyle === 'modern'
    ? MODERN_DARK_PALETTE
    : mode === 'light'
      ? lightPalette
      : darkPalette;
  const foreground = homeStyle === 'modern' ? '#ffffff' : mode === 'light' ? '#171717' : '#fafafa';
  const accentForeground = palette.foreground;
  const accentForegroundMuted = palette.foregroundMuted;
  const root = document.documentElement;

  root.dataset.theme = mode;
  root.dataset.themeColor = color;
  root.dataset.darkTheme = darkTheme;
  root.dataset.homeStyle = homeStyle;
  root.style.setProperty('--loom-accent', palette.hex);
  root.style.setProperty('--loom-accent-hover', palette.hover);
  root.style.setProperty('--loom-accent-foreground', accentForeground);
  root.style.setProperty('--loom-accent-foreground-muted', accentForegroundMuted);
  root.style.setProperty('--color-primary', palette.hex);
  root.style.setProperty('--color-ring', palette.hex);
  root.style.setProperty('--color-primary-foreground', accentForeground);

  root.style.setProperty('--loom-bg', themePalette.bg);
  root.style.setProperty('--loom-surface', themePalette.surface);
  root.style.setProperty('--loom-surface-2', themePalette.surface2);
  root.style.setProperty('--loom-surface-3', themePalette.surface3);
  root.style.setProperty('--loom-text', foreground);
  root.style.setProperty('--loom-muted', themePalette.muted);
  root.style.setProperty('--loom-faint', themePalette.faint);
  root.style.setProperty('--loom-border', themePalette.border);
  // The sidebar is part of the page canvas, not a separate elevated panel.
  root.style.setProperty('--loom-sidebar', themePalette.bg);
  root.style.setProperty('--loom-logo-word', foreground);
  root.style.setProperty('--loom-panel', themePalette.panel);
  root.style.setProperty('--loom-panel-border', themePalette.panelBorder);
  // Active navigation, selections, and focus use Tailwind's Stone scale.
  // The chosen accent remains reserved for branding and primary actions.
  root.style.setProperty('--loom-active-bg', mode === 'light' ? '#e7e5e4' : 'rgb(68 64 60 / 0.40)'); // stone-200 / stone-700 at 40%
  root.style.setProperty('--loom-active-bg-strong', mode === 'light' ? '#d6d3d1' : '#44403c'); // stone-300 / stone-700
  root.style.setProperty('--loom-active-text', mode === 'light' ? '#1c1917' : '#fafaf9'); // stone-900 / stone-50
  root.style.setProperty('--loom-active-muted', mode === 'light' ? '#57534e' : '#d6d3d1'); // stone-600 / stone-300
  root.style.setProperty('--loom-active-border', mode === 'light' ? '#d6d3d1' : '#44403c'); // stone-300 / stone-700
  root.style.setProperty('--loom-focus-ring', mode === 'light' ? '#a8a29e' : '#78716c'); // stone-400 / stone-500
  root.style.setProperty('--loom-focus-glow', mode === 'light' ? 'rgba(10, 10, 10, 0.10)' : 'rgba(255, 255, 255, 0.14)');
  root.style.setProperty('--loom-body-start', themePalette.bodyStart);
  root.style.setProperty('--loom-body-end', themePalette.bodyEnd);

  // Keep shadcn/Tailwind primitives in sync with the runtime theme.
  root.style.setProperty('--color-background', themePalette.bg);
  root.style.setProperty('--color-foreground', foreground);
  root.style.setProperty('--color-card', themePalette.surface);
  root.style.setProperty('--color-card-foreground', foreground);
  root.style.setProperty('--color-popover', themePalette.surface);
  root.style.setProperty('--color-popover-foreground', foreground);
  root.style.setProperty('--color-secondary', themePalette.surface3);
  root.style.setProperty('--color-secondary-foreground', foreground);
  root.style.setProperty('--color-muted', themePalette.surface3);
  root.style.setProperty('--color-muted-foreground', themePalette.muted);
  root.style.setProperty('--color-accent', themePalette.surface3);
  root.style.setProperty('--color-accent-foreground', foreground);
  root.style.setProperty('--color-border', themePalette.border);
  root.style.setProperty('--color-input', themePalette.surface2);
  root.style.setProperty('color-scheme', mode);
}
