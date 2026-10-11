import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import ProviderRatingLogo from '@/components/ProviderRatingLogo';
import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsPageHeader, SettingsRow, SettingsSegmented, SettingsSelect, SettingsSwitch } from '@/components/settings/SettingsLayout';
import { THEME_COLORS, type AppThemeColor } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { LOADER_OPTIONS } from './Settings.helpers';
import type { SettingsController } from './useSettingsController';
import AnimeCastCardPreview from './AnimeCastCardPreview';

export type AppearanceController = Pick<SettingsController,
  | 'theme'
  | 'setTheme'
  | 'showProviderRatingBadges'
  | 'setShowProviderRatingBadges'
  | 'sidebarOrderItems'
  | 'moveSidebarItem'
>;

export default function ThemeSettingsSection({ controller }: { controller: AppearanceController }) {
  const { theme, sidebarOrderItems: order } = controller;
  const modern = theme.homeStyle === 'modern';

  return (
    <div>
      <SettingsPageHeader title="Appearance" description="Theme, accent color, Home layout, and what posters show. Changes apply right away." />

      <SettingsGroup title="Theme">
        <SettingsRow title="Appearance" description={modern ? 'The Modern Home layout is always dark.' : 'Dark or light surfaces across the app.'}>
          <SettingsSegmented
            label="Appearance mode"
            value={modern ? 'dark' : theme.mode}
            disabled={modern}
            options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
            onChange={(mode) => void controller.setTheme({ mode })}
          />
        </SettingsRow>
        <SettingsRow title="Accent color" description="Used for buttons, progress, and selection." stacked>
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Accent color">
            {(Object.keys(THEME_COLORS) as AppThemeColor[]).map((color) => {
              const palette = THEME_COLORS[color];
              const selected = theme.color === color;
              return (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => void controller.setTheme({ color })}
                  className={cn(
                    'loom-control-button inline-flex h-9 items-center gap-2 rounded-[var(--loom-control-radius)] border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]',
                    selected
                      ? 'border-[var(--loom-accent)] bg-[var(--loom-active-bg)] text-[var(--loom-text)]'
                      : 'border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]',
                  )}
                >
                  <span className="grid h-4 w-4 place-items-center rounded-full" style={{ backgroundColor: palette.hex }}>
                    {selected ? <Check className="h-2.5 w-2.5" aria-hidden="true" style={{ color: palette.foreground }} /> : null}
                  </span>
                  {palette.label}
                </button>
              );
            })}
          </div>
        </SettingsRow>
        <SettingsRow title="Loading animation" description="Shown while pages load.">
          <SettingsSelect
            label="Loading animation"
            value={theme.loaderStyle}
            options={LOADER_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
            onChange={(loaderStyle) => void controller.setTheme({ loaderStyle })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Home">
        <SettingsRow title="Home layout" description="Modern has a full-bleed hero. Classic is a denser grid.">
          <SettingsSegmented
            label="Home layout style"
            value={theme.homeStyle}
            options={[{ value: 'modern', label: 'Modern' }, { value: 'default', label: 'Classic' }]}
            onChange={(homeStyle) => void controller.setTheme({ homeStyle })}
          />
        </SettingsRow>
        {modern ? (
          <SettingsRow title="Show the last watched title at the top" description="Replaces the featured title in the hero.">
            <SettingsSwitch
              label="Show the last watched title at the top"
              checked={theme.modernHeroMode === 'continue-watching'}
              onChange={(on) => void controller.setTheme({ modernHeroMode: on ? 'continue-watching' : 'featured' })}
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          title="Show ratings"
          description={(
            <span className="flex flex-wrap items-center gap-2">
              Provider logos and scores on posters and detail pages.
              <span role="img" className="inline-flex items-center gap-1 rounded-md border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--loom-text)]" aria-label="IMDb rating example, 8.1 out of 10">
                <ProviderRatingLogo provider="imdb" className="h-3.5 w-7 object-contain" />
                <span aria-hidden="true">8.1</span>
              </span>
            </span>
          )}
        >
          <SettingsSwitch label="Show ratings" checked={controller.showProviderRatingBadges} onChange={(show) => void controller.setShowProviderRatingBadges(show)} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Anime">
        <SettingsRow
          title="Cast card style"
          description={(
            <span className="grid min-w-0 gap-2">
              <span>How character and voice actor credits appear.</span>
              <AnimeCastCardPreview layout={theme.castCardStyle} />
            </span>
          )}
        >
          <SettingsSegmented
            label="Anime cast card style"
            value={theme.castCardStyle}
            options={[{ value: 'standard', label: 'Standard' }, { value: 'compact', label: 'Compact' }]}
            onChange={(castCardStyle) => void controller.setTheme({ castCardStyle })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Sidebar order" description="Move pages up or down in the sidebar." collapsible storageKey="theme-sidebar-order">
        {order.map((item, index) => (
          <SettingsRow key={item.id} title={item.label}>
            <span className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={index === 0} aria-label={`Move ${item.label} up`} title="Move up" onClick={() => controller.moveSidebarItem(item.id, -1)}>
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={index === order.length - 1} aria-label={`Move ${item.label} down`} title="Move down" onClick={() => controller.moveSidebarItem(item.id, 1)}>
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </Button>
            </span>
          </SettingsRow>
        ))}
      </SettingsGroup>
    </div>
  );
}
