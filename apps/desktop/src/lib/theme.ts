export type AppThemeMode = 'dark' | 'light';
export type AppThemeColor = 'red' | 'blue' | 'orange' | 'yellow';
export type AppDarkTheme = 'default' | 'justwatch' | 'black';
export type AppLoaderStyle = 'play-mark' | 'logo-mark' | 'horizontal-logo';

export type AppThemeSettings = {
  mode: AppThemeMode;
  color: AppThemeColor;
  darkTheme: AppDarkTheme;
  loaderStyle: AppLoaderStyle;
};

export const DEFAULT_THEME_SETTINGS: AppThemeSettings = {
  mode: 'dark',
  color: 'yellow',
  darkTheme: 'black',
  loaderStyle: 'play-mark',
};

export const THEME_COLORS: Record<AppThemeColor, { label: string; hex: string; hover: string; foreground: string; foregroundMuted: string }> = {
  yellow: { label: 'Yellow', hex: '#fbc500', hover: '#ffd43b', foreground: '#08101a', foregroundMuted: '#1d2a39' },
  red: { label: 'Red', hex: '#931116', hover: '#820D11', foreground: '#ffffff', foregroundMuted: '#ffffff' },
  blue: { label: 'Pastel Blue', hex: '#8FB8FF', hover: '#A9C9FF', foreground: '#071322', foregroundMuted: '#071322' },
  orange: { label: 'Orange', hex: '#FF9900', hover: '#FFB000', foreground: '#000000', foregroundMuted: '#000000' },
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
  black: {
    label: 'Black',
    description: 'True black-style dark mode using #0a0a0a everywhere.',
    bg: '#0a0a0a',
    surface: '#141414',
    surface2: '#101010',
    surface3: '#1f1f1f',
    sidebar: '#0a0a0a',
    muted: '#a3a3a3',
    faint: '#737373',
    border: '#262626',
    panel: 'rgba(20, 20, 20, 0.88)',
    panelBorder: 'rgba(255, 255, 255, 0.13)',
    bodyStart: '#0a0a0a',
    bodyEnd: '#0a0a0a',
  },
  default: {
    label: 'Default',
    description: 'The original Loom Media Server charcoal surfaces.',
    bg: '#1a1a1a',
    surface: '#232323',
    surface2: '#1d1d1d',
    surface3: '#2d2d2d',
    sidebar: '#111111',
    muted: '#a8a8a8',
    faint: '#777777',
    border: '#2d2d2d',
    panel: 'rgba(35, 35, 35, 0.88)',
    panelBorder: 'rgba(255, 255, 255, 0.14)',
    bodyStart: '#1a1a1a',
    bodyEnd: '#111111',
  },
  justwatch: {
    label: 'Navy Black',
    description: 'Deep navy-black with media-card contrast.',
    bg: '#060d17',
    surface: '#101a28',
    surface2: '#0b1420',
    surface3: '#172235',
    sidebar: '#080f19',
    muted: '#9aa7b8',
    faint: '#647287',
    border: '#243348',
    panel: 'rgba(16, 26, 40, 0.82)',
    panelBorder: 'rgba(148, 163, 184, 0.18)',
    bodyStart: '#08111d',
    bodyEnd: '#050a12',
  },
};

export function normalizeThemeMode(value?: string): AppThemeMode {
  return value === 'light' ? 'light' : 'dark';
}

export function normalizeThemeColor(value?: string): AppThemeColor {
  return value === 'yellow' || value === 'red' || value === 'blue' || value === 'orange'
    ? value
    : DEFAULT_THEME_SETTINGS.color;
}

export function normalizeDarkTheme(value?: string): AppDarkTheme {
  return value === 'default' || value === 'justwatch' || value === 'black'
    ? value
    : DEFAULT_THEME_SETTINGS.darkTheme;
}

export function normalizeLoaderStyle(value?: string): AppLoaderStyle {
  return value === 'logo-mark' || value === 'horizontal-logo' || value === 'play-mark'
    ? value
    : DEFAULT_THEME_SETTINGS.loaderStyle;
}

export function applyTheme(settings: Partial<AppThemeSettings> = {}) {
  const mode = normalizeThemeMode(settings.mode);
  const color = normalizeThemeColor(settings.color);
  const darkTheme = normalizeDarkTheme(settings.darkTheme);
  const palette = THEME_COLORS[color];
  const darkPalette = DARK_THEMES[darkTheme];
  const lightPalette = {
    bg: '#f4f6f8',
    surface: '#ffffff',
    surface2: '#f8fafc',
    surface3: '#eef2f5',
    sidebar: '#ffffff',
    muted: '#52606d',
    faint: '#7b8794',
    border: '#dce3e9',
    panel: 'rgba(255, 255, 255, 0.94)',
    panelBorder: 'rgba(15, 23, 42, 0.12)',
    bodyStart: '#f7f9fb',
    bodyEnd: '#eef2f5',
  };
  const themePalette = mode === 'light' ? lightPalette : darkPalette;
  const foreground = mode === 'light' ? '#17212b' : '#ffffff';
  const accentForeground = mode === 'light' && color === 'yellow' ? '#17212b' : palette.foreground;
  const accentForegroundMuted = mode === 'light' && color === 'yellow' ? '#344454' : palette.foregroundMuted;
  const root = document.documentElement;

  root.dataset.theme = mode;
  root.dataset.themeColor = color;
  root.dataset.darkTheme = darkTheme;
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
  root.style.setProperty('--loom-sidebar', themePalette.sidebar);
  root.style.setProperty('--loom-logo-word', foreground);
  root.style.setProperty('--loom-panel', themePalette.panel);
  root.style.setProperty('--loom-panel-border', themePalette.panelBorder);
  root.style.setProperty('--loom-focus-ring', palette.hex);
  root.style.setProperty('--loom-focus-glow', mode === 'light' ? 'rgba(34, 92, 255, 0.18)' : 'rgba(251, 197, 0, 0.28)');
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
