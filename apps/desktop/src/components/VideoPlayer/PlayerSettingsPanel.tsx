import { X } from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { clampSidePanelWidth, trackLabel } from './helpers';
import type { AspectMode, ControlTab, MediaTrack, SubtitleStyleSettings } from './types';

interface PlayerSettingsPanelProps {
  mediaPanelWidth: number;
  setMediaPanelWidth: React.Dispatch<React.SetStateAction<number>>;
  startSidePanelResize: (
    event: React.MouseEvent<HTMLDivElement>,
    currentWidth: number,
    setWidth: React.Dispatch<React.SetStateAction<number>>,
  ) => void;
  onClose: () => void;
  mediaPanelTab: ControlTab;
  setMediaPanelTab: (tab: ControlTab) => void;
  hasEpisodes: boolean;
  autoplayNextEnabled: boolean;
  toggleAutoplayNext: () => void;
  videoTracks: MediaTrack[];
  selectedVideoTrackIndex: number;
  selectVideoTrack: (trackIndex: number) => void;
  aspectMode: AspectMode;
  setAspectMode: (mode: AspectMode) => void;
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  audioTracks: MediaTrack[];
  selectedAudioTrackIndex: number;
  selectAudioTrack: (trackIndex: number) => void;
  subtitlesDefaultEnabled: boolean;
  subtitleTracks: MediaTrack[];
  selectedSubtitleTrackIndex: number;
  selectSubtitleTrack: (trackIndex: number) => void;
  subtitleStyle: SubtitleStyleSettings;
  subtitleCueFontSize: number;
  updateSubtitleStyle: (key: keyof SubtitleStyleSettings, value: number | string) => void;
  applySubtitleStyleToStream: () => void;
}

export default function PlayerSettingsPanel({
  mediaPanelWidth,
  setMediaPanelWidth,
  startSidePanelResize,
  onClose,
  mediaPanelTab,
  setMediaPanelTab,
  hasEpisodes,
  autoplayNextEnabled,
  toggleAutoplayNext,
  videoTracks,
  selectedVideoTrackIndex,
  selectVideoTrack,
  aspectMode,
  setAspectMode,
  playbackRate,
  setPlaybackRate,
  audioTracks,
  selectedAudioTrackIndex,
  selectAudioTrack,
  subtitlesDefaultEnabled,
  subtitleTracks,
  selectedSubtitleTrackIndex,
  selectSubtitleTrack,
  subtitleStyle,
  subtitleCueFontSize,
  updateSubtitleStyle,
  applySubtitleStyleToStream,
}: PlayerSettingsPanelProps) {
  return (
    <aside
      className="loom-no-drag player-side-panel absolute inset-y-0 right-0 z-50 flex flex-col border-l border-white/10 bg-[#111] shadow-2xl"
      style={{ width: clampSidePanelWidth(mediaPanelWidth), maxWidth: '40vw' }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div
        className="absolute left-0 top-0 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize items-center justify-center group"
        onMouseDown={(event) => startSidePanelResize(event, mediaPanelWidth, setMediaPanelWidth)}
        title="Drag to resize"
      >
        <span className="h-12 w-1 rounded-full bg-white/10 transition-colors group-hover:bg-[var(--loom-accent)]/70" />
      </div>

      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">Playback Settings</p>
          <p className="text-[10px] uppercase tracking-widest text-[var(--loom-accent)]/75">Subtitles, Audio, Video</p>
        </div>
        <button
          onClick={onClose}
          className="text-[var(--loom-muted)] hover:text-white ml-2 shrink-0"
          aria-label="Close playback settings"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-3 border-b border-white/10 text-xs font-bold uppercase tracking-wide text-white/55">
        {(['subtitles', 'audio', 'video'] as ControlTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setMediaPanelTab(tab)}
            className={`px-3 py-4 transition-colors ${mediaPanelTab === tab ? 'bg-white/5 text-white' : 'hover:bg-white/5 hover:text-white/80'}`}
          >
            {tab}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-5 text-sm text-white/85">
          {mediaPanelTab === 'video' && (
            <div className="space-y-5">
              {hasEpisodes && (
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg bg-white/10 px-3 py-2.5 text-xs transition-colors hover:bg-white/15">
                  <span>
                    <span className="block font-semibold text-white">Autoplay next episode</span>
                    <span className="mt-0.5 block text-white/50">Follow season order after a 3 second countdown.</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={autoplayNextEnabled}
                    onChange={toggleAutoplayNext}
                    className="h-4 w-4 shrink-0 accent-[var(--loom-accent)]"
                  />
                </label>
              )}

              <div>
                <p className="mb-2 text-xs font-semibold text-white">Video track</p>
                <div className="overflow-hidden rounded-lg bg-white/10">
                  {videoTracks.length === 0 && <p className="px-3 py-2 text-white/50">No video tracks found</p>}
                  {videoTracks.map((track, index) => (
                    <button
                      key={track.index}
                      onClick={() => selectVideoTrack(track.index)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedVideoTrackIndex === track.index ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                    >
                      <span className={`h-2.5 w-2.5 rounded-full ${selectedVideoTrackIndex === track.index ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                      <span className="truncate">{trackLabel(track, index)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-white">Aspect ratio</p>
                <div className="flex flex-wrap gap-1">
                  {(['default', 'contain', 'fill', '4 / 3', '16 / 9', '21 / 9'] as AspectMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setAspectMode(mode)}
                      className={`rounded-md px-3 py-1.5 text-xs transition-colors ${aspectMode === mode ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'bg-white/10 text-white/75 hover:bg-white/15'}`}
                    >
                      {mode === 'fill' ? 'Crop' : mode}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs font-semibold text-white">
                  <span>Speed</span>
                  <span className="text-[var(--loom-accent)]">{playbackRate.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min={0.25}
                  max={4}
                  step={0.05}
                  value={playbackRate}
                  onChange={(event) => setPlaybackRate(Number(event.target.value))}
                  className="w-full accent-[var(--loom-accent)]"
                />
                <div className="mt-1 flex justify-between text-[10px] text-white/45">
                  <span>0.25x</span>
                  <span>1x</span>
                  <span>4x</span>
                </div>
              </div>
            </div>
          )}

          {mediaPanelTab === 'audio' && (
            <div className="space-y-5">
              <div>
                <p className="mb-2 text-xs font-semibold text-white">Audio track</p>
                <div className="overflow-hidden rounded-lg bg-white/10">
                  <button
                    onClick={() => selectAudioTrack(-1)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedAudioTrackIndex === -1 ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                  >
                    <span className={`h-2.5 w-2.5 rounded-full ${selectedAudioTrackIndex === -1 ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                    <span>&lt;None&gt;</span>
                  </button>
                  {audioTracks.map((track, index) => (
                    <button
                      key={track.index}
                      onClick={() => selectAudioTrack(track.index)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedAudioTrackIndex === track.index ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                    >
                      <span className={`h-2.5 w-2.5 rounded-full ${selectedAudioTrackIndex === track.index ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                      <span className="truncate">{trackLabel(track, index)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-white">Audio delay</p>
                <p className="rounded-lg bg-white/10 px-3 py-2 text-xs text-white/55">
                  Delay controls are not available for in-app playback yet; track switching is available here.
                </p>
              </div>
            </div>
          )}

          {mediaPanelTab === 'subtitles' && (
            <div className="space-y-5">
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold text-white">Subtitle</p>
                  <p className="text-[10px] uppercase tracking-wide text-white/45">
                    Default {subtitlesDefaultEnabled ? 'on' : 'off'}
                  </p>
                </div>
                <div className="overflow-hidden rounded-lg bg-white/10">
                  <button
                    onClick={() => selectSubtitleTrack(-1)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedSubtitleTrackIndex === -1 ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                  >
                    <span className={`h-2.5 w-2.5 rounded-full ${selectedSubtitleTrackIndex === -1 ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                    <span>Off</span>
                  </button>
                  {subtitleTracks.length === 0 && <p className="px-3 py-2 text-xs text-white/50">No subtitle tracks found</p>}
                  {subtitleTracks.map((track, index) => (
                    <button
                      key={track.index}
                      onClick={() => selectSubtitleTrack(track.index)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedSubtitleTrackIndex === track.index ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                    >
                      <span className={`h-2.5 w-2.5 rounded-full ${selectedSubtitleTrackIndex === track.index ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                      <span className="truncate">{trackLabel(track, index)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-5 rounded-xl bg-white/[0.06] p-4">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold text-white">Position</p>
                    <span className="text-xs text-[var(--loom-accent)]">{Math.round(subtitleStyle.position)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={subtitleStyle.position}
                    onChange={(event) => updateSubtitleStyle('position', Number(event.target.value))}
                    className="w-full accent-[var(--loom-accent)]"
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold text-white">Size</p>
                    <span className="text-xs text-[var(--loom-accent)]">{subtitleCueFontSize}px</span>
                  </div>
                  <input
                    type="range"
                    min={24}
                    max={96}
                    step={1}
                    value={subtitleStyle.fontSize}
                    onChange={(event) => updateSubtitleStyle('fontSize', Number(event.target.value))}
                    className="w-full accent-[var(--loom-accent)]"
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold text-white">Outline</p>
                    <span className="text-xs text-[var(--loom-accent)]">{subtitleStyle.borderWidth}px</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={subtitleStyle.borderWidth}
                    onChange={(event) => updateSubtitleStyle('borderWidth', Number(event.target.value))}
                    className="w-full accent-[var(--loom-accent)]"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {([
                    ['fontColor', 'Text'],
                    ['borderColor', 'Outline'],
                    ['backgroundColor', 'Background'],
                  ] as Array<[keyof SubtitleStyleSettings, string]>).map(([key, label]) => (
                    <label key={key} className="space-y-2">
                      <span className="block text-xs font-semibold text-white">{label}</span>
                      <input
                        type="color"
                        value={String(subtitleStyle[key])}
                        onChange={(event) => updateSubtitleStyle(key, event.target.value)}
                        className="h-9 w-full cursor-pointer rounded-md border border-white/10 bg-white/10 p-1"
                      />
                    </label>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={applySubtitleStyleToStream}
                  className="w-full rounded-md bg-white/10 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/15"
                >
                  Apply subtitle style
                </button>
              </div>

            </div>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
