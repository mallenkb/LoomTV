import {
  Download,
  LoaderCircle,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  ListOrdered,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Subtitles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { isPlayerControlTarget } from './playerControls';
import { formatTime, seekAccessibilityText } from './helpers';
import type { ControlTab } from './types';
import SeekHoverPreview from './SeekHoverPreview';
import { RulerSlider } from '@/components/ui/ruler-slider';
import { skipPromptLabel, type TimelineSegmentBand } from './skipPrompt';
import { DEFAULT_THEME_SETTINGS, type AppPlayerControlStyle } from '@/lib/theme';

const clampVolume = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));

interface PlayerControlBarProps {
  /** Settings uses the real controls without requesting video thumbnails. */
  preview?: boolean;
  controlStyle?: AppPlayerControlStyle;
  filePath: string;
  showControls: boolean;
  seekSliderRef: React.RefObject<HTMLDivElement | null>;
  progressFillRef: React.RefObject<HTMLDivElement | null>;
  progressThumbRef: React.RefObject<HTMLDivElement | null>;
  scrubTimeHudRef: React.RefObject<HTMLDivElement | null>;
  currentTimeTextRef: React.RefObject<HTMLSpanElement | null>;
  durationTimeTextRef: React.RefObject<HTMLSpanElement | null>;
  playbackPositionRef: React.RefObject<number>;
  duration: number;
  position: number;
  isLiveStream: boolean;
  showRemainingTime: boolean;
  progressPct: number;
  bufferedRanges?: Array<{ start: number; end: number }>;
  /** Intro, recap, outro, credits and preview ranges drawn on the seek bar. */
  timelineSegments?: TimelineSegmentBand[];
  paused: boolean;
  muted: boolean;
  volume: number;
  skipBackSeconds: number;
  skipForwardSeconds: number;
  hasEpisodes: boolean;
  showSidebar: boolean;
  showMediaPanel: boolean;
  mediaPanelTab: ControlTab;
  fullscreen: boolean;
  handleProgressPointerDown: React.PointerEventHandler<HTMLDivElement>;
  handleProgressKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  togglePlay: () => void;
  toggleTimeDisplay: () => void;
  seekTo: (seconds: number) => void;
  toggleMute: () => void;
  handleVolume: (volume: number) => void;
  handlePrevEpisode: () => void;
  handleNextEpisode: () => void;
  handlePreviousLiveChannel?: () => void;
  handleNextLiveChannel?: () => void;
  openEpisodePanel: () => void;
  /** Live only: what's on now, shown beside "LIVE". */
  liveNowPlaying?: React.ReactNode;
  /** Live only: opens the channel list beside the player. */
  openChannelList?: () => void;
  showChannelList?: boolean;
  /** Live only: opens the guide over the lower part of the player. */
  openGuide?: () => void;
  showGuide?: boolean;
  openSubtitlesPanel: () => void;
  openMediaPanel: () => void;
  toggleFullscreen: () => void;
  downloadVideo?: () => void;
  downloadBusy?: boolean;
}

export default function PlayerControlBar({
  preview = false,
  controlStyle = DEFAULT_THEME_SETTINGS.playerControlStyle,
  filePath,
  showControls,
  seekSliderRef,
  progressFillRef,
  progressThumbRef,
  scrubTimeHudRef,
  currentTimeTextRef,
  durationTimeTextRef,
  playbackPositionRef,
  duration,
  position,
  isLiveStream,
  showRemainingTime,
  progressPct,
  timelineSegments = [],
  bufferedRanges = [],
  paused,
  muted,
  volume,
  skipBackSeconds,
  skipForwardSeconds,
  hasEpisodes,
  showSidebar,
  showMediaPanel,
  mediaPanelTab,
  fullscreen,
  handleProgressPointerDown,
  handleProgressKeyDown,
  togglePlay,
  toggleTimeDisplay,
  seekTo,
  toggleMute,
  handleVolume,
  handlePrevEpisode,
  handleNextEpisode,
  handlePreviousLiveChannel,
  handleNextLiveChannel,
  openEpisodePanel,
  liveNowPlaying,
  openChannelList,
  showChannelList = false,
  openGuide,
  showGuide = false,
  openSubtitlesPanel,
  openMediaPanel,
  toggleFullscreen,
  downloadVideo,
  downloadBusy = false,
}: PlayerControlBarProps) {
  const engineVolume = clampVolume(volume);
  const volumeIsMuted = muted || engineVolume === 0;
  const visibleVolume = volumeIsMuted ? 0 : engineVolume;
  const pillControls = controlStyle === 'pill';
  const downloadButton = (
    downloadVideo ? <button type="button" onClick={downloadVideo} disabled={downloadBusy}
          aria-label={downloadBusy ? 'Starting download' : 'Download video'} title="Download video"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] disabled:opacity-50">
          {downloadBusy ? <LoaderCircle aria-hidden="true" className="h-5 w-5 motion-safe:animate-spin" /> : <Download aria-hidden="true" className="h-5 w-5" strokeWidth={2.25} />}
        </button> : null
  );
  const timeDisplay = (
    <button
      type="button"
      onClick={toggleTimeDisplay}
      className="loom-player-time min-w-[6.75rem] shrink-0 select-none rounded px-1 text-left text-sm font-medium tabular-nums text-white/90 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] sm:text-base"
      title={showRemainingTime ? 'Show elapsed time' : 'Show remaining time'}
      aria-label={showRemainingTime ? 'Show elapsed time' : 'Show remaining time'}
      aria-pressed={showRemainingTime}
      aria-live="off"
    >
      <span ref={currentTimeTextRef} className="text-white">{showRemainingTime ? `-${formatTime(Math.max(0, duration - position))}` : formatTime(position)}</span>
      <span className="mx-1.5 text-white/45">/</span>
      <span ref={durationTimeTextRef} className="text-white/60">{formatTime(duration)}</span>
    </button>
  );

  return (
    <div
      className={`loom-player-controls absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/55 to-transparent px-6 pb-3 pt-10 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      aria-hidden={!showControls}
      inert={!showControls}
      onClick={(e) => { if (isPlayerControlTarget(e.target)) e.stopPropagation(); }}
      onDoubleClick={(e) => { if (isPlayerControlTarget(e.target)) e.stopPropagation(); }}
    >
      <div className="loom-player-timeline-row mb-2 flex items-center gap-3">
        {isLiveStream ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {liveNowPlaying}
          </div>
        ) : (
          !pillControls && timeDisplay
        )}

        {/* Progress bar. A live stream has no timeline to show or seek. */}
        {!isLiveStream && (
        <div
          ref={seekSliderRef}
          role={isLiveStream ? 'progressbar' : 'slider'}
          tabIndex={isLiveStream ? -1 : 0}
          aria-label={isLiveStream ? 'Live playback at live edge' : 'Seek'}
          aria-orientation="horizontal"
          aria-disabled={isLiveStream || duration <= 0}
          aria-valuemin={0}
          aria-valuemax={isLiveStream ? 100 : duration || 0}
          aria-valuenow={isLiveStream ? 100 : Math.min(position, duration || 0)}
          aria-valuetext={isLiveStream ? 'Live' : seekAccessibilityText(position, duration)}
          aria-keyshortcuts={isLiveStream ? undefined : 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight PageUp PageDown Home End'}
          onPointerDown={isLiveStream ? undefined : handleProgressPointerDown}
          onKeyDown={isLiveStream ? undefined : handleProgressKeyDown}
          style={{ '--loom-progress': `${progressPct}%` } as React.CSSProperties}
          className={`group relative h-6 min-w-0 flex-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${isLiveStream ? 'cursor-default' : 'cursor-pointer'}`}
        >
          {!preview && !isLiveStream && duration > 0 && (
            <SeekHoverPreview key={filePath} filePath={filePath} duration={duration} sliderRef={seekSliderRef} visible={showControls} playbackPositionRef={playbackPositionRef} />
          )}
          {!isLiveStream && (
            <div
              ref={scrubTimeHudRef}
              aria-hidden="true"
              className="sr-only"
              style={{ left: `${progressPct}%` }}
            >
              {formatTime(position)} / {formatTime(duration)}
            </div>
          )}
          <div className="loom-player-timeline-track absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/15 shadow-[0_1px_2px_rgba(0,0,0,0.6)] ring-1 ring-black/30 transition-[height] duration-150 group-hover:h-2.5 group-focus-visible:h-2.5">
            {!isLiveStream && duration > 0 && bufferedRanges.map((range, index) => {
              const start = Math.max(0, Math.min(duration, range.start));
              const end = Math.max(start, Math.min(duration, range.end));
              return <div key={index} aria-hidden="true" className="pointer-events-none absolute inset-y-0 rounded-full bg-white/70"
                style={{ left: `${start / duration * 100}%`, width: `${(end - start) / duration * 100}%` }} />;
            })}
            <div
              ref={progressFillRef}
              className="loom-player-timeline-fill relative h-full rounded-full bg-[var(--loom-accent)] shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
              style={{ transform: `scaleX(${isLiveStream ? 1 : progressPct / 100})`, transformOrigin: 'left center' }}
            />
            {timelineSegments.length > 0 && (
              <>
                {/* Marker ranges in one pastel: soft where unplayed, solid where played. */}
                {timelineSegments.map((band) => (
                  <div
                    key={band.key}
                    title={skipPromptLabel(band.type, hasEpisodes)}
                    className="absolute inset-y-0 bg-[var(--loom-segment-marker)] opacity-60"
                    style={{ left: `${band.leftPct}%`, width: `${band.widthPct}%` }}
                  />
                ))}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  style={{ clipPath: 'inset(0 calc(100% - var(--loom-progress, 0%)) 0 0)' }}
                >
                  {timelineSegments.map((band) => (
                    <div
                      key={band.key}
                      className="absolute inset-y-0 bg-[var(--loom-segment-marker)]"
                      style={{ left: `${band.leftPct}%`, width: `${band.widthPct}%` }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
          <div
            ref={progressThumbRef}
            className={`loom-player-timeline-thumb pointer-events-none absolute top-1/2 h-4 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--loom-accent)] shadow-[0_1px_3px_rgba(0,0,0,0.5)] transition-opacity duration-150 ${isLiveStream ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}
            style={{ left: `${isLiveStream ? 100 : progressPct}%` }}
          />
        </div>
        )}
      </div>

      <div className="loom-player-button-row flex items-center gap-2">
        <div className="loom-player-primary-controls">
        <button
          type="button"
          onClick={togglePlay}
          className="loom-player-play grid h-14 w-14 shrink-0 place-items-center rounded-full text-white outline-none transition-colors hover:bg-white/10 hover:text-[var(--loom-accent)] focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
          title={paused ? 'Play (Space)' : 'Pause (Space)'}
          aria-label={paused ? 'Play' : 'Pause'}
          aria-keyshortcuts="Space"
        >
          {paused ? <Play className="h-8 w-8 fill-current" /> : <Pause className="h-8 w-8 fill-current" />}
        </button>

        {pillControls && !isLiveStream ? timeDisplay : null}

        {!isLiveStream && (
          <div className="loom-player-skip-controls">
            <button
              type="button"
              onClick={() => seekTo(playbackPositionRef.current - skipBackSeconds)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              title={`Back ${skipBackSeconds}s`}
              aria-label={`Back ${skipBackSeconds} seconds`}
            >
              <RotateCcw className="h-5 w-5" strokeWidth={2.25} />
            </button>

            <button
              type="button"
              onClick={() => seekTo(playbackPositionRef.current + skipForwardSeconds)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              title={`Forward ${skipForwardSeconds}s`}
              aria-label={`Forward ${skipForwardSeconds} seconds`}
            >
              <RotateCw className="h-5 w-5" strokeWidth={2.25} />
            </button>
          </div>
        )}

        <div className="loom-player-volume flex items-center gap-2">
          <button
            type="button"
            onClick={toggleMute}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
            title={volumeIsMuted ? 'Unmute (M)' : 'Mute (M)'}
            aria-label={volumeIsMuted ? 'Unmute' : 'Mute'}
            aria-pressed={volumeIsMuted}
          >
            {volumeIsMuted ? <VolumeX className="h-5 w-5" strokeWidth={2.25} /> : <Volume2 className="h-5 w-5" strokeWidth={2.25} />}
          </button>
          <RulerSlider
            showHeader={false}
            label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={visibleVolume}
            format={(level) => `${Math.round(level * 100)}%${volumeIsMuted ? ' (muted)' : ''}`}
            onValueChange={handleVolume}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            title={`Volume ${Math.round(visibleVolume * 100)}%`}
            className="loom-player-volume-slider w-28"
          />
        </div>
        </div>
        <div className="loom-player-controls-spacer flex-1" />
        <div className="loom-player-secondary-controls">

        {(hasEpisodes || (pillControls && downloadVideo) || (isLiveStream && handlePreviousLiveChannel && handleNextLiveChannel)) && (
          <div className="loom-player-navigation mr-1 flex items-center gap-1">
            {(hasEpisodes || (isLiveStream && handlePreviousLiveChannel && handleNextLiveChannel)) && <>
            <button
              type="button"
              onClick={isLiveStream ? handlePreviousLiveChannel : handlePrevEpisode}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              title={isLiveStream ? 'Previous channel (Page Up)' : 'Previous episode'}
              aria-label={isLiveStream ? 'Previous channel' : 'Previous episode'}
            >
              <ChevronLeft className="h-5 w-5" strokeWidth={2.5} />
            </button>
            <button
              type="button"
              onClick={isLiveStream ? handleNextLiveChannel : handleNextEpisode}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              title={isLiveStream ? 'Next channel (Page Down)' : 'Next episode'}
              aria-label={isLiveStream ? 'Next channel' : 'Next episode'}
            >
              <ChevronRight className="h-5 w-5" strokeWidth={2.5} />
            </button>
            </>}
            {pillControls ? downloadButton : null}
          </div>
        )}


        {!pillControls ? downloadButton : null}

        <div className="loom-player-controls-divider mx-1 hidden h-7 w-px bg-white/20 sm:block" aria-hidden="true" />

        <div className="loom-player-options">
        {isLiveStream && openChannelList && (
          <button
            type="button"
            onClick={openChannelList}
            data-player-panel-toggle="true"
            className={`flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${showChannelList ? 'border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
            title="Channel list"
            aria-label="Channel list"
            aria-pressed={showChannelList}
            aria-expanded={showChannelList}
          >
            <ListOrdered className="h-5 w-5" strokeWidth={2.25} />
            <span className="text-sm font-medium">Channels</span>
          </button>
        )}

        {isLiveStream && openGuide && (
          <button
            type="button"
            onClick={openGuide}
            data-player-panel-toggle="true"
            data-player-guide-toggle="true"
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${showGuide ? 'border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
            title="Guide (G)"
            aria-label="Guide"
            aria-pressed={showGuide}
            aria-expanded={showGuide}
            aria-keyshortcuts="G"
          >
            <LayoutGrid className="h-5 w-5" strokeWidth={2.25} />
          </button>
        )}

        {hasEpisodes && (
          <button
            type="button"
            onClick={openEpisodePanel}
            data-player-panel-toggle="true"
            className={`flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${showSidebar ? 'border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
            title="Episode list"
            aria-label="Episode list"
            aria-pressed={showSidebar}
            aria-expanded={showSidebar}
          >
            <ListOrdered className="h-5 w-5" strokeWidth={2.25} />
            <span className="text-sm font-medium">Episodes</span>
          </button>
        )}



        {!isLiveStream && <button
          type="button"
          onClick={openSubtitlesPanel}
          data-player-panel-toggle="true"
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${showMediaPanel && mediaPanelTab === 'subtitles' ? 'border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
          title="Subtitles"
          aria-label="Subtitles"
          aria-pressed={showMediaPanel && mediaPanelTab === 'subtitles'}
          aria-expanded={showMediaPanel && mediaPanelTab === 'subtitles'}
        >
          <Subtitles className="h-5 w-5" strokeWidth={2.25} />
        </button>}

        <button
          type="button"
          onClick={openMediaPanel}
          data-player-panel-toggle="true"
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${showMediaPanel && mediaPanelTab !== 'subtitles' ? 'border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
          title="Playback settings"
          aria-label="Playback settings"
          aria-pressed={showMediaPanel && mediaPanelTab !== 'subtitles'}
          aria-expanded={showMediaPanel && mediaPanelTab !== 'subtitles'}
        >
          <SlidersHorizontal className="h-5 w-5" strokeWidth={2.25} />
        </button>

        <button
          type="button"
          onClick={toggleFullscreen}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
          title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
          aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-pressed={fullscreen}
          aria-keyshortcuts="F"
        >
          {fullscreen ? <Minimize className="h-5 w-5" strokeWidth={2.25} /> : <Maximize className="h-5 w-5" strokeWidth={2.25} />}
        </button>
        </div>
        </div>
      </div>
    </div>
  );
}
