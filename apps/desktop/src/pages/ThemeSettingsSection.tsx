import { Moon, Palette, Sun } from 'lucide-react';
import LoomBrandLockup from '@/components/LoomBrandLockup';
import LoomLoader from '@/components/LoomLoader';
import LoomLogo from '@/components/LoomLogo';
import LoomPlayMark from '@/components/LoomPlayMark';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type AppThemeColor,
  type AppHomeStyle,
  type AppThemeSettings,
  THEME_COLORS,
} from '@/lib/theme';
import { LOADER_OPTIONS } from './Settings.helpers';

type ThemeSettingsSectionProps = {
  theme: AppThemeSettings;
  setTheme: (settings: Partial<AppThemeSettings>) => Promise<void>;
};

export default function ThemeSettingsSection({ theme, setTheme }: ThemeSettingsSectionProps) {
  const canChooseAppearance = theme.homeStyle === 'default';

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
          <div>
            <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Style</p>
            <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Home layout style">
              {([
                { id: 'default', label: 'Default', description: 'The familiar LoomTV library layout.' },
                { id: 'modern', label: 'Modern', description: 'A cinematic hero, category pill, and floating controls.' },
              ] as const satisfies readonly { id: AppHomeStyle; label: string; description: string }[]).map((option) => {
                const isSelected = theme.homeStyle === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => void setTheme({ homeStyle: option.id })}
                    aria-pressed={isSelected}
                    className={`rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-focus-ring)] ${
                      isSelected
                        ? 'border-[var(--loom-active-border)] bg-[var(--loom-active-bg)]'
                        : 'border-[var(--loom-border)] bg-[var(--loom-bg)] hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)]'
                    }`}
                  >
                    <span className="block text-sm font-semibold text-[var(--loom-text)]">{option.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--loom-muted)]">{option.description}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {canChooseAppearance && (
            <div>
              <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Appearance</p>
              <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Appearance mode">
                {([
                  { mode: 'dark' as const, label: 'Dark', Icon: Moon },
                  { mode: 'light' as const, label: 'Light', Icon: Sun },
                ]).map(({ mode, label, Icon }) => {
                  const isSelected = theme.mode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => void setTheme({ mode })}
                      aria-pressed={isSelected}
                      className={`theme-appearance-option flex h-14 items-center gap-3 rounded-lg border px-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-focus-ring)] ${
                        isSelected
                          ? 'border-[var(--loom-active-border)] bg-[var(--loom-active-bg)] text-[var(--loom-active-text)]'
                          : 'border-[var(--loom-border)] bg-[var(--loom-bg)] hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)]'
                      }`}
                    >
                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${isSelected ? 'bg-[var(--loom-active-bg-strong)] text-[var(--loom-active-text)]' : 'bg-[var(--loom-surface-3)] text-[var(--loom-muted)]'}`}>
                        <Icon className="h-5 w-5" />
                      </span>
                      <span className={`text-sm font-semibold ${isSelected ? 'text-[var(--loom-active-text)]' : 'text-[var(--loom-text)]'}`}>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-7">
            <div>
              <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Theme</p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(THEME_COLORS) as AppThemeColor[]).map((color) => {
                  const palette = THEME_COLORS[color];
                  const isSelected = theme.color === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => void setTheme({ color })}
                      className={`inline-flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        isSelected
                          ? 'border-[var(--loom-active-border)] bg-[var(--loom-active-bg)]'
                          : 'border-[var(--loom-border)] bg-[var(--loom-bg)] hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)]'
                      }`}
                    >
                      <span
                        className="theme-color-option-label text-sm font-semibold"
                        style={{ color: isSelected ? 'var(--loom-active-text)' : 'var(--loom-text)' }}
                      >
                        {palette.label}
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
              <div className="grid gap-4 rounded-lg border bg-[var(--loom-bg)] p-4 lg:grid-cols-[minmax(0,1fr)_13rem]">
                <div className="flex min-h-52 items-center justify-center rounded-lg border bg-[var(--loom-surface-2)] p-8">
                  <LoomBrandLockup className="h-32 w-auto" />
                </div>
                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-3 rounded-lg border bg-[var(--loom-surface-2)] px-3 py-3">
                    <span className="text-xs font-medium text-[var(--loom-muted)]">Icon</span>
                    <LoomPlayMark className="h-7 w-7 text-[var(--loom-accent)]" />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-lg border bg-[var(--loom-surface-2)] px-3 py-3">
                    <span className="text-xs font-medium text-[var(--loom-muted)]">Horizontal</span>
                    <LoomLogo className="h-7 w-auto" />
                  </div>
                  <Button className="h-12 gap-2 border">
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
                      className={`theme-loader-option flex min-h-28 flex-col items-center justify-center gap-3 rounded-2xl border p-3 text-center transition-colors ${
                        isSelected
                          ? 'border-[var(--loom-active-border)] bg-[var(--loom-active-bg)]'
                          : 'border-[var(--loom-border)] bg-[var(--loom-bg)] hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)]'
                      }`}
                    >
                      <LoomLoader
                        style={option.id}
                        className="h-12 w-12 rounded-full bg-[var(--loom-surface-3)] text-[var(--loom-text)] ring-1 ring-[var(--loom-border)]"
                        markClassName={option.id === 'horizontal-logo' ? 'h-4 w-auto' : 'h-7 w-7'}
                        color="currentColor"
                      />
                      <span className={`block text-sm font-semibold ${isSelected ? 'text-[var(--loom-active-text)]' : 'text-[var(--loom-text)]'}`}>{option.label}</span>
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
