import { Palette } from 'lucide-react';
import LoomBrandLockup from '@/components/LoomBrandLockup';
import LoomLoader from '@/components/LoomLoader';
import LoomLogo from '@/components/LoomLogo';
import LoomPlayMark from '@/components/LoomPlayMark';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type AppDarkTheme,
  type AppThemeColor,
  type AppThemeSettings,
  DARK_THEMES,
  THEME_COLORS,
} from '@/lib/theme';
import { LOADER_OPTIONS } from './Settings.helpers';

type ThemeSettingsSectionProps = {
  theme: AppThemeSettings;
  setTheme: (settings: Partial<AppThemeSettings>) => Promise<void>;
};

export default function ThemeSettingsSection({ theme, setTheme }: ThemeSettingsSectionProps) {
  return (
    <div className="space-y-6">
      <Card className="settings-panel">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-[var(--loom-text)]">
            <Palette className="h-4 w-4 text-[var(--loom-accent)]" />
            Theme
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          <div className="space-y-7">
            <div>
              <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Dark Theme</p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(DARK_THEMES) as AppDarkTheme[]).map((darkTheme) => {
                  const palette = DARK_THEMES[darkTheme];
                  const isSelected = theme.darkTheme === darkTheme;
                  return (
                    <button
                      key={darkTheme}
                      type="button"
                      onClick={() => void setTheme({ darkTheme })}
                      className={`inline-flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        isSelected
                          ? 'bg-[var(--loom-accent)]/10 ring-1 ring-[var(--loom-accent)]/80'
                          : 'bg-[var(--loom-bg)] hover:bg-[var(--loom-surface-3)]/55'
                      }`}
                    >
                      <span className="text-sm font-semibold text-[var(--loom-text)]">{palette.label}</span>
                      <span
                        className="block h-6 w-14 rounded-md ring-1 ring-white/10"
                        style={{ backgroundColor: palette.bg }}
                      >
                        <span className="sr-only">{palette.bg}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Logo Colour</p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(THEME_COLORS) as AppThemeColor[]).map((color) => {
                  const palette = THEME_COLORS[color];
                  const isSelected = theme.color === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => void setTheme({ color })}
                      className={`inline-flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        isSelected
                          ? 'bg-[var(--loom-accent)]/10 ring-1 ring-[var(--loom-accent)]/80'
                          : 'bg-[var(--loom-bg)] hover:bg-[var(--loom-surface-3)]/55'
                      }`}
                    >
                      <span
                        className="text-sm font-semibold"
                        style={{ color: color === 'yellow' ? '#fbc500' : 'var(--loom-text)' }}
                      >
                        {color === 'yellow' ? 'Yellow' : palette.label}
                      </span>
                      <span
                        className="block h-6 w-14 rounded-md ring-1 ring-black/10"
                        style={{ backgroundColor: palette.hex }}
                      >
                        <span className="sr-only">{palette.hex}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="space-y-7">
            <div>
              <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Preview</p>
              <div className="grid gap-4 rounded-lg bg-[var(--loom-bg)] p-4 ring-1 ring-white/10 lg:grid-cols-[minmax(0,1fr)_13rem]">
                <div className="flex min-h-52 items-center justify-center rounded-lg bg-[var(--loom-surface-2)] p-8">
                  <LoomBrandLockup className="h-32 w-auto" />
                </div>
                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--loom-surface-2)] px-3 py-3">
                    <span className="text-xs font-medium text-[var(--loom-muted)]">Icon</span>
                    <LoomPlayMark className="h-7 w-7 text-[var(--loom-accent)]" />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--loom-surface-2)] px-3 py-3">
                    <span className="text-xs font-medium text-[var(--loom-muted)]">Horizontal</span>
                    <LoomLogo className="h-7 w-auto" />
                  </div>
                  <Button className="h-12 gap-2">
                    <Palette className="h-4 w-4" />
                    Accent Action
                  </Button>
                </div>
              </div>
            </div>

            <div>
              <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Loader</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {LOADER_OPTIONS.map((option) => {
                  const isSelected = theme.loaderStyle === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => void setTheme({ loaderStyle: option.id })}
                      className={`flex min-h-28 flex-col items-center justify-center gap-3 rounded-lg p-3 text-center transition-colors ${
                        isSelected
                          ? 'bg-[var(--loom-accent)]/10 ring-1 ring-[var(--loom-accent)]/80'
                          : 'bg-[var(--loom-bg)] hover:bg-[var(--loom-surface-3)]/55'
                      }`}
                    >
                      <LoomLoader
                        style={option.id}
                        className="h-12 w-12 rounded-full bg-white/10 text-white ring-1 ring-white/10"
                        markClassName={option.id === 'horizontal-logo' ? 'h-4 w-auto' : 'h-7 w-7'}
                        color="currentColor"
                      />
                      <span className="block text-sm font-semibold text-[var(--loom-text)]">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
