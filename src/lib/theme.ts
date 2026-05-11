export type AppThemeMode = 'dark';
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
    description: 'The original LoomTV charcoal surfaces.',
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

export function normalizeThemeMode(_value?: string): AppThemeMode {
  return 'dark';
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
  const root = document.documentElement;

  root.dataset.theme = mode;
  root.dataset.themeColor = color;
  root.dataset.darkTheme = darkTheme;
  root.style.setProperty('--loom-accent', palette.hex);
  root.style.setProperty('--loom-accent-hover', palette.hover);
  root.style.setProperty('--loom-accent-foreground', palette.foreground);
  root.style.setProperty('--loom-accent-foreground-muted', palette.foregroundMuted);
  root.style.setProperty('--color-primary', palette.hex);
  root.style.setProperty('--color-ring', palette.hex);
  root.style.setProperty('--color-primary-foreground', palette.foreground);

  root.style.setProperty('--loom-bg', darkPalette.bg);
  root.style.setProperty('--loom-surface', darkPalette.surface);
  root.style.setProperty('--loom-surface-2', darkPalette.surface2);
  root.style.setProperty('--loom-surface-3', darkPalette.surface3);
  root.style.setProperty('--loom-text', '#ffffff');
  root.style.setProperty('--loom-muted', darkPalette.muted);
  root.style.setProperty('--loom-faint', darkPalette.faint);
  root.style.setProperty('--loom-border', darkPalette.border);
  root.style.setProperty('--loom-sidebar', darkPalette.sidebar);
  root.style.setProperty('--loom-logo-word', '#ffffff');
  root.style.setProperty('--loom-panel', darkPalette.panel);
  root.style.setProperty('--loom-panel-border', darkPalette.panelBorder);
  root.style.setProperty('--loom-focus-glow', 'rgba(251, 197, 0, 0.28)');
  root.style.setProperty('--loom-body-start', darkPalette.bodyStart);
  root.style.setProperty('--loom-body-end', darkPalette.bodyEnd);
}
