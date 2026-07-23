import {
  ChevronLeft,
  ChevronRight,
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
import { formatTime } from './helpers';
import type { ControlTab } from './types';

interface PlayerControlBarProps {
  showControls: boolean;
  seekSliderRef: React.RefObject<HTMLDivElement | null>;
  progressFillRef: React.RefObject<HTMLDivElement | null>;
  progressThumbRef: React.RefObject<HTMLDivElement | null>;
  currentTimeTextRef: React.RefObject<HTMLSpanElement | null>;
  durationTimeTextRef: React.RefObject<HTMLSpanElement | null>;
  playbackPositionRef: React.RefObject<number>;
  duration: number;
  position: number;
  showRemainingTime: boolean;
  progressPct: number;
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
  handleVolume: React.ChangeEventHandler<HTMLInputElement>;
  handlePrevEpisode: () => void;
  handleNextEpisode: () => void;
  openEpisodePanel: () => void;
  openSubtitlesPanel: () => void;
  openMediaPanel: () => void;
  toggleFullscreen: () => void;
}

export default function PlayerControlBar({
  showControls,
  seekSliderRef,
  progressFillRef,
  progressThumbRef,
  currentTimeTextRef,
  durationTimeTextRef,
  playbackPositionRef,
  duration,
  position,
  showRemainingTime,
  progressPct,
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
  openEpisodePanel,
  openSubtitlesPanel,
  openMediaPanel,
  toggleFullscreen,
}: PlayerControlBarProps) {
  return (
    <div
      className={`loom-player-controls absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/55 to-transparent px-6 pb-6 pt-14 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="mb-3 flex items-center gap-3">
        <button
          type="button"
          onClick={toggleTimeDisplay}
          className="min-w-[6.75rem] shrink-0 select-none rounded px-1 text-left text-sm font-medium tabular-nums text-white/90 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] sm:text-base"
          title={showRemainingTime ? 'Show elapsed time' : 'Show remaining time'}
          aria-label={showRemainingTime ? 'Show elapsed time' : 'Show remaining time'}
          aria-pressed={showRemainingTime}
          aria-live="off"
        >
          <span ref={currentTimeTextRef} className="text-white">{showRemainingTime ? `-${formatTime(Math.max(0, duration - position))}` : formatTime(position)}</span>
          <span className="mx-1.5 text-white/45">/</span>
          <span ref={durationTimeTextRef} className="text-white/60">{formatTime(duration)}</span>
        </button>

        {/* Progress bar */}
        <div
          ref={seekSliderRef}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={duration || 0}
          aria-valuenow={Math.min(position, duration || position)}
          aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
          aria-keyshortcuts="ArrowLeft ArrowRight Home End"
          onPointerDown={handleProgressPointerDown}
          onKeyDown={handleProgressKeyDown}
          className="group relative h-6 min-w-0 flex-1 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/25 shadow-[0_1px_2px_rgba(0,0,0,0.6)] ring-1 ring-black/30 transition-[height] duration-150 group-hover:h-2.5 group-focus-visible:h-2.5">
            <div
              ref={progressFillRef}
              className="h-full rounded-full bg-[var(--loom-accent)] shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
              style={{ transform: `scaleX(${progressPct / 100})`, transformOrigin: 'left center' }}
            />
          </div>
          <div
            ref={progressThumbRef}
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-[0_2px_6px_rgba(0,0,0,0.55)] ring-2 ring-[var(--loom-accent)] transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
            style={{ left: `${progressPct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          className="grid h-14 w-14 shrink-0 place-items-center rounded-full text-white outline-none transition-colors hover:bg-white/10 hover:text-[var(--loom-accent)] focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
          title={paused ? 'Play (Space)' : 'Pause (Space)'}
          aria-label={paused ? 'Play' : 'Pause'}
          aria-keyshortcuts="Space"
        >
          {paused ? <Play className="h-8 w-8 fill-current" /> : <Pause className="h-8 w-8 fill-current" />}
        </button>

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

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleMute}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
            title={muted || volume === 0 ? 'Unmute (M)' : 'Mute (M)'}
            aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
            aria-pressed={muted || volume === 0}
          >
            {muted || volume === 0 ? <VolumeX className="h-5 w-5" strokeWidth={2.25} /> : <Volume2 className="h-5 w-5" strokeWidth={2.25} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={handleVolume}
            aria-label="Volume"
            aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
            style={{ '--loom-volume-pct': `${Math.round((muted ? 0 : volume) * 100)}%` } as React.CSSProperties}
            className="loom-volume-slider w-24 outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
          />
        </div>

        <div className="flex-1" />

        {hasEpisodes && (
          <div className="mr-1 flex items-center gap-1">
            <button
              type="button"
              onClick={handlePrevEpisode}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              title="Previous episode"
              aria-label="Previous episode"
            >
              <ChevronLeft className="h-5 w-5" strokeWidth={2.5} />
            </button>
            <button
              type="button"
              onClick={handleNextEpisode}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              title="Next episode"
              aria-label="Next episode"
            >
              <ChevronRight className="h-5 w-5" strokeWidth={2.5} />
            </button>
          </div>
        )}

        <div className="mx-1 hidden h-7 w-px bg-white/20 sm:block" aria-hidden="true" />

        {hasEpisodes && (
          <button
            type="button"
            onClick={openEpisodePanel}
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

        <button
          type="button"
          onClick={openSubtitlesPanel}
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${showMediaPanel && mediaPanelTab === 'subtitles' ? 'border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
          title="Subtitles"
          aria-label="Subtitles"
          aria-pressed={showMediaPanel && mediaPanelTab === 'subtitles'}
          aria-expanded={showMediaPanel && mediaPanelTab === 'subtitles'}
        >
          <Subtitles className="h-5 w-5" strokeWidth={2.25} />
        </button>

        <button
          type="button"
          onClick={openMediaPanel}
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${showMediaPanel && mediaPanelTab === 'video' ? 'border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
          title="Playback settings"
          aria-label="Playback settings"
          aria-pressed={showMediaPanel && mediaPanelTab === 'video'}
          aria-expanded={showMediaPanel && mediaPanelTab === 'video'}
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
  );
}
