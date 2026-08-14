import { Moon, Palette, Sun } from 'lucide-react';
import LoomBrandLockup from '@/components/LoomBrandLockup';
import LoomLoader from '@/components/LoomLoader';
import LoomLogo from '@/components/LoomLogo';
import LoomPlayMark from '@/components/LoomPlayMark';
import ProviderRatingLogo from '@/components/ProviderRatingLogo';
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
  showProviderRatingBadges: boolean;
  setShowProviderRatingBadges: (show: boolean) => Promise<void>;
};

export default function ThemeSettingsSection({
  theme,
  setTheme,
  showProviderRatingBadges,
  setShowProviderRatingBadges,
}: ThemeSettingsSectionProps) {
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
                { id: 'modern', label: 'Modern', description: 'A cinematic hero, category pill, and floating controls.' },
                { id: 'default', label: 'Classic', description: 'The familiar LoomTV library layout.' },
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

          {theme.homeStyle === 'modern' && (
            <div>
              <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Home hero</p>
              <button
                type="button"
                role="switch"
                aria-checked={theme.modernHeroMode === 'continue-watching'}
                onClick={() => void setTheme({
                  modernHeroMode: theme.modernHeroMode === 'continue-watching' ? 'featured' : 'continue-watching',
                })}
                className="flex w-full items-center justify-between gap-4 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-bg)] p-4 text-left outline-none transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] focus-visible:ring-2 focus-visible:ring-[var(--loom-focus-ring)]"
              >
                <span>
                  <span className="block text-sm font-semibold text-[var(--loom-text)]">Show last watched title</span>
                  <span className="mt-1 block text-xs leading-5 text-[var(--loom-muted)]">
                    {theme.modernHeroMode === 'continue-watching'
                      ? 'The hero stays on your most recently watched title.'
                      : 'The hero rotates through the featured library carousel.'}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
                    theme.modernHeroMode === 'continue-watching'
                      ? 'bg-[var(--loom-accent)]'
                      : 'bg-[var(--loom-surface-3)]'
                  }`}
                >
                  <span
                    className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                      theme.modernHeroMode === 'continue-watching' ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </span>
              </button>
            </div>
          )}

          <div>
            <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Ratings</p>
            <button
              type="button"
              role="switch"
              aria-checked={showProviderRatingBadges}
              onClick={() => void setShowProviderRatingBadges(!showProviderRatingBadges)}
              className="flex w-full items-center justify-between gap-4 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-bg)] p-4 text-left outline-none transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] focus-visible:ring-2 focus-visible:ring-[var(--loom-focus-ring)]"
            >
              <span>
                <span className="flex items-center gap-2 text-sm font-semibold text-[var(--loom-text)]">
                  Show provider rating badges
                  <span className="inline-flex items-center gap-1 rounded-md bg-black/20 px-1.5 py-1 text-xs font-medium text-[var(--loom-text)]">
                    <ProviderRatingLogo provider="imdb" className="h-3.5 w-7 object-contain" />
                    <span>8.1</span>
                  </span>
                </span>
                <span className="mt-1 block text-xs leading-5 text-[var(--loom-muted)]">
                  Use IMDb, Tomatometer, Popcornmeter, and Metacritic logos with their scores. Turn this off to use the normal star rating.
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
                  showProviderRatingBadges ? 'bg-[var(--loom-accent)]' : 'bg-[var(--loom-surface-3)]'
                }`}
              >
                <span
                  className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                    showProviderRatingBadges ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </span>
            </button>
          </div>

          <div>
            <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Anime cast cards</p>
            <div
              className="grid w-full grid-cols-2 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-bg)] p-1 sm:w-fit sm:min-w-80"
              role="group"
              aria-label="Anime cast card style"
            >
              {([
                { id: 'standard', label: 'Standard' },
                { id: 'compact', label: 'Compact' },
              ] as const).map((option) => {
                const isSelected = theme.castCardStyle === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => void setTheme({ castCardStyle: option.id })}
                    aria-pressed={isSelected}
                    className={`min-h-10 rounded-lg px-4 py-2 text-center text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-focus-ring)] ${
                      isSelected
                        ? 'bg-[var(--loom-active-bg)] text-[var(--loom-active-text)] shadow-sm'
                        : 'text-[var(--loom-muted)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)]'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>


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
