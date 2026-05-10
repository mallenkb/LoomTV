export type AppThemeMode = 'dark';
export type AppThemeColor = 'red' | 'blue' | 'orange' | 'yellow';
export type AppLoaderStyle = 'play-mark' | 'logo-mark' | 'horizontal-logo';

export type AppThemeSettings = {
  mode: AppThemeMode;
  color: AppThemeColor;
  loaderStyle: AppLoaderStyle;
};

export const DEFAULT_THEME_SETTINGS: AppThemeSettings = {
  mode: 'dark',
  color: 'yellow',
  loaderStyle: 'play-mark',
};

export const THEME_COLORS: Record<AppThemeColor, { label: string; hex: string; hover: string; foreground: string; foregroundMuted: string }> = {
  red: { label: 'Red', hex: '#931116', hover: '#820D11', foreground: '#ffffff', foregroundMuted: '#ffffff' },
  blue: { label: 'Pastel Blue', hex: '#8FB8FF', hover: '#A9C9FF', foreground: '#071322', foregroundMuted: '#071322' },
  orange: { label: 'Orange', hex: '#FF9900', hover: '#FFB000', foreground: '#000000', foregroundMuted: '#000000' },
  yellow: { label: 'Yellow', hex: '#FFC53D', hover: '#e6b236', foreground: '#000000', foregroundMuted: '#000000' },
};

export function normalizeThemeMode(_value?: string): AppThemeMode {
  return 'dark';
}

export function normalizeThemeColor(value?: string): AppThemeColor {
  return value === 'yellow' || value === 'red' || value === 'blue' || value === 'orange'
    ? value
    : DEFAULT_THEME_SETTINGS.color;
}

export function normalizeLoaderStyle(value?: string): AppLoaderStyle {
  return value === 'logo-mark' || value === 'horizontal-logo' || value === 'play-mark'
    ? value
    : DEFAULT_THEME_SETTINGS.loaderStyle;
}

export function applyTheme(settings: Partial<AppThemeSettings> = {}) {
  const mode = normalizeThemeMode(settings.mode);
  const color = normalizeThemeColor(settings.color);
  const palette = THEME_COLORS[color];
  const root = document.documentElement;

  root.dataset.theme = mode;
  root.dataset.themeColor = color;
  root.style.setProperty('--loom-accent', palette.hex);
  root.style.setProperty('--loom-accent-hover', palette.hover);
  root.style.setProperty('--loom-accent-foreground', palette.foreground);
  root.style.setProperty('--loom-accent-foreground-muted', palette.foregroundMuted);
  root.style.setProperty('--color-primary', palette.hex);
  root.style.setProperty('--color-ring', palette.hex);
  root.style.setProperty('--color-primary-foreground', palette.foreground);

  root.style.setProperty('--loom-bg', '#1a1a1a');
  root.style.setProperty('--loom-surface', '#232323');
  root.style.setProperty('--loom-surface-2', '#1d1d1d');
  root.style.setProperty('--loom-surface-3', '#2d2d2d');
  root.style.setProperty('--loom-text', '#ffffff');
  root.style.setProperty('--loom-muted', '#a8a8a8');
  root.style.setProperty('--loom-faint', '#777777');
  root.style.setProperty('--loom-border', '#2d2d2d');
  root.style.setProperty('--loom-sidebar', '#232323');
  root.style.setProperty('--loom-logo-word', '#ffffff');
}
