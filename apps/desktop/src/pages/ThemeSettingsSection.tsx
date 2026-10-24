import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import PlayerControlBar from '@/components/VideoPlayer/PlayerControlBar';
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

const ignorePreviewAction = () => undefined;

function PlayerControlPreview({ style, modern }: { style: AppPlayerControlStyle; modern: boolean }) {
  const { state } = useLibrary();
  const hasBackdrop = (item: (typeof state.movies)[number]) => Boolean(item.backdrop || item.backdropCandidates?.length);
  const previewItem = state.animeShows.find(hasBackdrop)
    || state.tvShows.find(hasBackdrop)
    || state.movies.find(hasBackdrop)
    || state.animeShows[0] || state.tvShows[0] || state.movies[0];
  const pill = style === 'pill';
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.75);
  const [position, setPosition] = useState(603);
  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const seekSliderRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const progressThumbRef = useRef<HTMLDivElement>(null);
  const scrubTimeHudRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const durationTimeTextRef = useRef<HTMLSpanElement>(null);
  const playbackPositionRef = useRef(603);
  const duration = 1470;
  const seekTo = (seconds: number) => {
    const next = Math.max(0, Math.min(duration, seconds));
    playbackPositionRef.current = next;
    setPosition(next);
  };
  return (
    <figure className="min-w-0 w-full">
      <div role="group" aria-label={`${pill ? 'Pill' : 'Classic'} episode controls preview`}
        className={cn('loom-player-root relative h-64 overflow-hidden rounded-xl bg-black text-white sm:h-80', pill && 'loom-player-pill', modern && 'loom-player-modern')}>
        {previewItem && (
          <SafeArtwork
            src={backdropSources(previewItem)}
            alt=""
            className="absolute inset-0 h-full w-full"
            imgClassName="h-full w-full object-cover"
          />
        )}
        <PlayerControlBar
          preview
          controlStyle={style}
          filePath="settings-episode-preview"
          showControls
          seekSliderRef={seekSliderRef}
          progressFillRef={progressFillRef}
          progressThumbRef={progressThumbRef}
          scrubTimeHudRef={scrubTimeHudRef}
          currentTimeTextRef={currentTimeTextRef}
          durationTimeTextRef={durationTimeTextRef}
          playbackPositionRef={playbackPositionRef}
          duration={duration}
          position={position}
          isLiveStream={false}
          showRemainingTime={showRemainingTime}
          progressPct={position / duration * 100}
          bufferedRanges={[{ start: position, end: Math.min(duration, position + 140) }]}
          paused={paused}
          muted={muted}
          volume={volume}
          skipBackSeconds={10}
          skipForwardSeconds={10}
          hasEpisodes
          showSidebar={false}
          showMediaPanel={false}
          mediaPanelTab="video"
          fullscreen={false}
          handleProgressPointerDown={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width > 0) seekTo((event.clientX - rect.left) / rect.width * duration);
          }}
          handleProgressKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            seekTo(playbackPositionRef.current + (event.key === 'ArrowRight' ? 10 : -10));
          }}
          togglePlay={() => setPaused(value => !value)}
          toggleTimeDisplay={() => setShowRemainingTime(value => !value)}
          seekTo={seekTo}
          toggleMute={() => setMuted(value => !value)}
          handleVolume={setVolume}
          handlePrevEpisode={() => seekTo(0)}
          handleNextEpisode={() => seekTo(0)}
          openEpisodePanel={ignorePreviewAction}
          openSubtitlesPanel={ignorePreviewAction}
          openMediaPanel={ignorePreviewAction}
          toggleFullscreen={ignorePreviewAction}
        />
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
            options={[{ value: 'pill', label: 'Pill' }, { value: 'default', label: 'Classic' }]}
            onChange={(playerControlStyle) => void controller.setTheme({ playerControlStyle })}
          />
        </SettingsRow>
        <SettingsRow title="Preview" stacked>
          <div className="w-full">
            <PlayerControlPreview style={theme.playerControlStyle} modern={modern} />
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
