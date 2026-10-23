import { Captions, Check, Maximize, Play, RotateCcw, RotateCw, SlidersHorizontal, Volume2 } from 'lucide-react';
import ProviderRatingLogo from '@/components/ProviderRatingLogo';
import { SettingsGroup, SettingsPageHeader, SettingsRow, SettingsSegmented, SettingsSelect, SettingsSwitch } from '@/components/settings/SettingsLayout';
import { THEME_COLORS, type AppPlayerControlStyle, type AppThemeColor } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { LOADER_OPTIONS } from './Settings.helpers';
import type { SettingsController } from './useSettingsController';
import AnimeCastCardPreview from './AnimeCastCardPreview';
import SafeArtwork from '@/components/SafeArtwork';
import { useLibrary } from '@/contexts/LibraryContext';
import { backdropSources } from '@/lib/artwork';

export type AppearanceController = Pick<SettingsController,
  | 'theme'
  | 'setTheme'
  | 'showProviderRatingBadges'
  | 'setShowProviderRatingBadges'
>;

function PlayerControlPreview({ style }: { style: AppPlayerControlStyle }) {
  const { state } = useLibrary();
  const hasBackdrop = (item: (typeof state.movies)[number]) => Boolean(item.backdrop || item.backdropCandidates?.length);
  const previewItem = state.movies.find(hasBackdrop)
    || state.tvShows.find(hasBackdrop)
    || state.animeShows.find(hasBackdrop)
    || state.movies[0] || state.tvShows[0] || state.animeShows[0];
  const pill = style === 'pill';
  const time = <span className={cn('whitespace-nowrap text-[10px] tabular-nums text-white/85', pill && 'inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-black/55 backdrop-blur-xl px-2 py-0')}>23:51 <span className="text-white/50">/ 53:27</span></span>;
  const group = pill ? 'h-7 rounded-full bg-black/55 backdrop-blur-xl px-2 py-0' : '';
  return (
    <figure className="min-w-0 w-full md:w-[70%]">
      <div role="img" aria-label={pill ? 'Pill controls with rounded backgrounds, time after Play, and a full-width timeline.' : 'Default controls with time beside the timeline and buttons on a plain background.'}
        className="relative h-64 overflow-hidden rounded-xl bg-black text-white sm:h-80">
        {previewItem && (
          <SafeArtwork
            src={backdropSources(previewItem)}
            alt=""
            className="absolute inset-0 h-full w-full"
            imgClassName="h-full w-full object-cover"
          />
        )}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent" />
        <div aria-hidden="true" className="absolute inset-x-3 bottom-3 space-y-2">
          <div className="flex items-center gap-2">
            {!pill && time}
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/20"><div className="h-full w-[45%] rounded-full bg-[var(--loom-accent)]" /></div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2" style={pill ? { zoom: 1.3 } : undefined}>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn('grid shrink-0 place-items-center', pill && 'h-7 w-7 rounded-full bg-black/55 backdrop-blur-xl')}><Play className={cn('h-4 w-4', !pill && 'fill-current')} /></span>
              {pill && time}
              <span className={cn('flex shrink-0 items-center gap-2', group)}><RotateCcw className="h-3 w-3" /><RotateCw className="h-3 w-3" /></span>
              <span className={cn('flex shrink-0 items-center gap-1.5', group)}><Volume2 className="h-3 w-3" />{!pill && <span className="h-1 w-6 rounded-full bg-[var(--loom-accent)]" />}</span>
            </div>
            <span className={cn('flex shrink-0 items-center gap-2', group)}><Captions className="h-3 w-3" /><SlidersHorizontal className="h-3 w-3" /><Maximize className="h-3 w-3" /></span>
          </div>
        </div>
      </div>
    </figure>
  );
}

export default function ThemeSettingsSection({ controller }: { controller: AppearanceController }) {
  const { theme } = controller;
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

      <SettingsGroup title="Player">
        <SettingsRow title="Player control style" description="Pill uses frosted rounded backgrounds, a full-width timeline, and volume that expands on hover.">
          <SettingsSegmented
            label="Player control style"
            value={theme.playerControlStyle}
            options={[{ value: 'default', label: 'Default' }, { value: 'pill', label: 'Pill' }]}
            onChange={(playerControlStyle) => void controller.setTheme({ playerControlStyle })}
          />
        </SettingsRow>
        <SettingsRow title="Preview" stacked>
          <div className="w-full">
            <PlayerControlPreview style={theme.playerControlStyle} />
          </div>
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


    </div>
  );
}
