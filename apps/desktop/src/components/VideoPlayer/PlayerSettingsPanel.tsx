import { X } from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { clampSidePanelWidth, trackLabel } from './helpers';
import type {
  AspectMode,
  ControlTab,
  CropMode,
  MediaTrack,
  RotationMode,
  SubtitleStyleSettings,
} from './types';

const ASPECT_OPTIONS: { value: AspectMode; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: '4 / 3', label: '4:3' },
  { value: '16 / 9', label: '16:9' },
  { value: '16 / 10', label: '16:10' },
  { value: '21 / 9', label: '21:9' },
  { value: '5 / 4', label: '5:4' },
];

const CROP_OPTIONS: { value: CropMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: '4 / 3', label: '4:3' },
  { value: '16 / 9', label: '16:9' },
  { value: '16 / 10', label: '16:10' },
  { value: '21 / 9', label: '21:9' },
  { value: '5 / 4', label: '5:4' },
  { value: 'custom', label: 'Custom…' },
];

const ROTATION_OPTIONS: { value: RotationMode; label: string }[] = [
  { value: 0, label: '0°' },
  { value: 90, label: '90°' },
  { value: 180, label: '180°' },
  { value: 270, label: '270°' },
];

const DISPLAY_SLEEP_OPTIONS = [
  { value: 0, label: 'Never while playing' },
  { value: 15, label: 'After 15 minutes' },
  { value: 30, label: 'After 30 minutes' },
  { value: 45, label: 'After 45 minutes' },
  { value: 60, label: 'After 1 hour' },
  { value: 90, label: 'After 1.5 hours' },
  { value: 120, label: 'After 2 hours' },
] as const;

function colorInputValue(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
}

const SUBTITLE_REFERENCE_FONT_SIZE_PX = 32;
const SUBTITLE_MAX_OUTLINE_WIDTH_PX = 10;

function subtitleSizePercent(fontSize: number): number {
  return Math.round((fontSize / SUBTITLE_REFERENCE_FONT_SIZE_PX) * 100);
}

function subtitleOutlinePercent(borderWidth: number): number {
  return Math.round((borderWidth / SUBTITLE_MAX_OUTLINE_WIDTH_PX) * 100);
}

function SegmentedSetting<T extends string | number>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-xl bg-white/10">
      <div className="flex min-w-max">
        {options.map((option, index) => (
          <div key={String(option.value)} className="flex items-center">
            {index > 0 && <span className="h-6 w-px shrink-0 bg-white/20" aria-hidden="true" />}
            <button
              type="button"
              onClick={() => onChange(option.value)}
              disabled={disabled}
              className={`min-h-10 whitespace-nowrap px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${value === option.value ? 'rounded-xl bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'text-white/75 hover:text-white'}`}
              aria-pressed={value === option.value}
            >
              {option.label}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

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
  videoTracks: MediaTrack[];
  selectedVideoTrackIndex: number;
  selectVideoTrack: (trackIndex: number) => void;
  aspectMode: AspectMode;
  setAspectMode: (mode: AspectMode) => void;
  cropMode: CropMode;
  setCropMode: (mode: CropMode) => void;
  rotation: RotationMode;
  setRotation: (rotation: RotationMode) => void;
  rotationAvailable: boolean;
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  displaySleepSettingsAvailable: boolean;
  displaySleepTimeoutMinutes: number;
  displaySleepTimerRemainingSeconds: number | null;
  playbackPaused: boolean;
  displaySleepTimeoutError?: string;
  setDisplaySleepTimeoutMinutes: (minutes: number) => void;
  playbackInformation: {
    engine: string;
    mode: string;
    hardwareDecode: string;
    encodeBackend: string;
    note?: string;
  };
  audioTracks: MediaTrack[];
  selectedAudioTrackIndex: number;
  selectAudioTrack: (trackIndex: number) => void;
  audioDelay: number;
  updateAudioDelay: (seconds: number) => void;
  audioDelayAvailable: boolean;
  subtitlesDefaultEnabled: boolean;
  subtitleTracks: MediaTrack[];
  selectedSubtitleTrackIndex: number;
  selectSubtitleTrack: (trackIndex: number) => void;
  secondarySubtitlesAvailable: boolean;
  selectedSecondarySubtitleTrackIndex: number;
  selectSecondarySubtitleTrack: (trackIndex: number) => void;
  subtitleStyle: SubtitleStyleSettings;
  subtitleCueFontSize: number;
  subtitleStyleCompatibilityMessage?: string;
  updateSubtitleStyle: (key: keyof SubtitleStyleSettings, value: number | string) => void;
  applySubtitleStyleToStream: () => void;
  onCorrectSkipTiming: () => void;
}

export default function PlayerSettingsPanel({
  mediaPanelWidth,
  setMediaPanelWidth,
  startSidePanelResize,
  onClose,
  mediaPanelTab,
  setMediaPanelTab,
  videoTracks,
  selectedVideoTrackIndex,
  selectVideoTrack,
  aspectMode,
  setAspectMode,
  cropMode,
  setCropMode,
  rotation,
  setRotation,
  rotationAvailable,
  playbackRate,
  setPlaybackRate,
  displaySleepSettingsAvailable,
  displaySleepTimeoutMinutes,
  displaySleepTimerRemainingSeconds,
  playbackPaused,
  displaySleepTimeoutError,
  setDisplaySleepTimeoutMinutes,
  playbackInformation,
  audioTracks,
  selectedAudioTrackIndex,
  selectAudioTrack,
  audioDelay,
  updateAudioDelay,
  audioDelayAvailable,
  subtitlesDefaultEnabled,
  subtitleTracks,
  selectedSubtitleTrackIndex,
  selectSubtitleTrack,
  secondarySubtitlesAvailable,
  selectedSecondarySubtitleTrackIndex,
  selectSecondarySubtitleTrack,
  subtitleStyle,
  subtitleCueFontSize,
  subtitleStyleCompatibilityMessage,
  updateSubtitleStyle,
  applySubtitleStyleToStream,
  onCorrectSkipTiming,
}: PlayerSettingsPanelProps) {
  const subtitleGroups = [
    {
      key: 'embedded',
      label: 'Embedded in video',
      tracks: subtitleTracks.filter((track) => !track.source || track.source === 'embedded'),
    },
    {
      key: 'sidecar',
      label: 'Added subtitle files',
      tracks: subtitleTracks.filter((track) => track.source === 'sidecar'),
    },
    {
      key: 'opensubtitles',
      label: 'OpenSubtitles',
      tracks: subtitleTracks.filter((track) => track.source === 'opensubtitles'),
    },
  ].filter((group) => group.tracks.length > 0);

  const selectedTrackLabel = (tracks: MediaTrack[], selectedIndex: number, emptyLabel: string) => {
    const selectedTrack = tracks.find((track) => track.index === selectedIndex);
    return selectedTrack ? trackLabel(selectedTrack, tracks.indexOf(selectedTrack)) : emptyLabel;
  };

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
          type="button"
          onClick={onClose}
          className="text-[var(--loom-muted)] hover:text-white ml-2 shrink-0"
          aria-label="Close playback settings"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-3 border-b border-white/10 text-xs font-bold uppercase tracking-wide text-white/75" role="tablist" aria-label="Playback settings sections">
        {(['subtitles', 'audio', 'video'] as ControlTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setMediaPanelTab(tab)}
            role="tab"
            aria-selected={mediaPanelTab === tab}
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
              <div>
                <p className="mb-2 text-xs font-semibold text-white">Video track</p>
                <div className="overflow-hidden rounded-lg bg-white/10">
                  {videoTracks.length === 0 && <p className="px-3 py-2 text-white/70">No video tracks found</p>}
                  {videoTracks.map((track, index) => (
                    <button
                      key={track.index}
                      type="button"
                      onClick={() => selectVideoTrack(track.index)}
                      aria-pressed={selectedVideoTrackIndex === track.index}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedVideoTrackIndex === track.index ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                    >
                      <span className={`h-2.5 w-2.5 rounded-full ${selectedVideoTrackIndex === track.index ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                      <span className="truncate">{trackLabel(track, index)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <p className="mb-2 text-xs font-semibold text-white">Aspect ratio</p>
                  <SegmentedSetting options={ASPECT_OPTIONS} value={aspectMode} onChange={setAspectMode} />
                </div>

                <div>
                  <p className="mb-2 text-xs font-semibold text-white">Crop</p>
                  <SegmentedSetting options={CROP_OPTIONS} value={cropMode} onChange={setCropMode} />
                </div>

                <div>
                  <p className="mb-2 text-xs font-semibold text-white">Rotation</p>
                  <SegmentedSetting
                    options={ROTATION_OPTIONS}
                    value={rotation}
                    onChange={setRotation}
                    disabled={!rotationAvailable}
                  />
                  {!rotationAvailable && (
                    <p className="mt-2 text-[11px] leading-relaxed text-white/55">
                      Live rotation is unavailable in LibVLC. Playback stays on the current engine.
                    </p>
                  )}
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
                  aria-label="Playback speed"
                  aria-valuemin={0.25}
                  aria-valuemax={4}
                  aria-valuenow={playbackRate}
                  aria-valuetext={`${playbackRate.toFixed(2)} times speed`}
                  className="w-full accent-[var(--loom-accent)]"
                />
                <div className="mt-1 flex justify-between text-[10px] text-white/70">
                  <span>0.25x</span>
                  <span>1x</span>
                  <span>4x</span>
                </div>
              </div>

              {displaySleepSettingsAvailable && <section className="rounded-lg border border-white/10 bg-white/[0.04] p-3" aria-labelledby="display-sleep-heading">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 id="display-sleep-heading" className="text-xs font-semibold text-white">Display sleep timer</h3>
                    <p className="mt-1 text-[10px] text-white/70">Pausing resets the countdown.</p>
                  </div>
                  <span className="shrink-0 rounded-md bg-white/10 px-2 py-1 font-mono text-xs text-[var(--loom-accent)]" aria-live="polite">
                    {displaySleepTimeoutMinutes === 0
                      ? 'Never'
                      : playbackPaused
                        ? 'Paused'
                        : `${String(Math.floor((displaySleepTimerRemainingSeconds || 0) / 60)).padStart(2, '0')}:${String((displaySleepTimerRemainingSeconds || 0) % 60).padStart(2, '0')}`}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {DISPLAY_SLEEP_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setDisplaySleepTimeoutMinutes(option.value)}
                      aria-pressed={displaySleepTimeoutMinutes === option.value}
                      className={`rounded-md border px-2 py-2 text-xs transition-colors ${displaySleepTimeoutMinutes === option.value ? 'border-[var(--loom-accent)]/55 bg-[var(--loom-accent)]/10 text-white ring-1 ring-inset ring-[var(--loom-accent)]/15' : 'border-white/10 bg-white/[0.06] text-white/65 hover:border-white/20 hover:bg-white/10 hover:text-white'}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className={`mt-2 text-[10px] ${displaySleepTimeoutError ? 'text-red-300' : 'text-white/70'}`} role={displaySleepTimeoutError ? 'alert' : undefined}>
                  {displaySleepTimeoutError || (displaySleepTimeoutMinutes === 0 ? 'The display stays awake until playback stops or pauses.' : 'The display may sleep when the countdown reaches zero.')}
                </p>
              </section>}

              <section
                className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2"
                aria-labelledby="advanced-settings-heading"
              >
                <h3 id="advanced-settings-heading" className="text-xs font-semibold text-white/75">Advanced</h3>
                <button
                  type="button"
                  onClick={onCorrectSkipTiming}
                  className="mt-3 w-full rounded-md bg-white/10 px-3 py-2 text-left text-xs text-white/75 transition-colors hover:bg-white/15 hover:text-white"
                >
                  Correct automatic skip timing
                </button>

                <section className="mt-4 border-t border-white/10 pt-4" aria-labelledby="playback-information-heading">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 id="playback-information-heading" className="text-xs font-semibold text-white">Playback Information</h3>
                      <p className="mt-1 text-[10px] text-white/70">Current engine and stream details</p>
                    </div>
                  </div>
                  <dl className="mt-3 space-y-2 text-xs">
                    {[
                      ['Engine', playbackInformation.engine],
                      ['Mode', playbackInformation.mode],
                      ['Video', selectedTrackLabel(videoTracks, selectedVideoTrackIndex, 'Not selected')],
                      ['Audio', selectedTrackLabel(audioTracks, selectedAudioTrackIndex, 'Not selected')],
                      ['Subtitles', selectedTrackLabel(subtitleTracks, selectedSubtitleTrackIndex, 'Off')],
                      ['Hardware decode', playbackInformation.hardwareDecode],
                      ['Encode backend', playbackInformation.encodeBackend],
                    ].map(([label, value]) => (
                      <div key={label} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                        <dt className="text-white/70">{label}</dt>
                        <dd className="min-w-0 break-words text-right text-white/85">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {playbackInformation.note && (
                    <p className="mt-3 border-t border-white/10 pt-3 text-[10px] leading-relaxed text-white/70">
                      {playbackInformation.note}
                    </p>
                  )}
                </section>
              </section>
            </div>
          )}

          {mediaPanelTab === 'audio' && (
            <div className="space-y-5">
              <div>
                <p className="mb-2 text-xs font-semibold text-white">Audio track</p>
                <div className="overflow-hidden rounded-lg bg-white/10">
                  <button
                    type="button"
                    onClick={() => selectAudioTrack(-1)}
                    aria-pressed={selectedAudioTrackIndex === -1}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedAudioTrackIndex === -1 ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                  >
                    <span className={`h-2.5 w-2.5 rounded-full ${selectedAudioTrackIndex === -1 ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                    <span>&lt;None&gt;</span>
                  </button>
                  {audioTracks.map((track, index) => (
                    <button
                      key={track.index}
                      type="button"
                      onClick={() => selectAudioTrack(track.index)}
                      aria-pressed={selectedAudioTrackIndex === track.index}
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
                {audioDelayAvailable ? (
                  <div className="rounded-lg bg-white/10 px-3 py-3">
                    <div className="mb-2 flex items-center justify-between text-xs text-white/75">
                      <span>Sync</span>
                      <span className="text-[var(--loom-accent)]">{audioDelay.toFixed(2)}s</span>
                    </div>
                    <input
                      type="range"
                      min={-5}
                      max={5}
                      step={0.05}
                      value={audioDelay}
                      onChange={(event) => updateAudioDelay(Number(event.target.value))}
                      aria-label="Audio delay"
                      aria-valuemin={-5}
                      aria-valuemax={5}
                      aria-valuenow={audioDelay}
                      aria-valuetext={`${audioDelay.toFixed(2)} seconds`}
                      className="w-full accent-[var(--loom-accent)]"
                    />
                    <button
                      type="button"
                      onClick={() => updateAudioDelay(0)}
                      className="mt-2 text-xs text-white/70 hover:text-white"
                    >
                      Reset delay
                    </button>
                  </div>
                ) : (
                  <p className="rounded-lg bg-white/10 px-3 py-2 text-xs text-white/70">
                    Delay controls are available with native mpv playback.
                  </p>
                )}
              </div>
            </div>
          )}

          {mediaPanelTab === 'subtitles' && (
            <div className="space-y-5">
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold text-white">Subtitle</p>
                  <p className="text-[10px] uppercase tracking-wide text-white/70">
                    Default {subtitlesDefaultEnabled ? 'on' : 'off'}
                  </p>
                </div>
                <div className="overflow-hidden rounded-lg bg-white/10">
                  <button
                    type="button"
                    onClick={() => selectSubtitleTrack(-1)}
                    aria-pressed={selectedSubtitleTrackIndex === -1}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedSubtitleTrackIndex === -1 ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                  >
                    <span className={`h-2.5 w-2.5 rounded-full ${selectedSubtitleTrackIndex === -1 ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                    <span>Off</span>
                  </button>
                  {subtitleTracks.length === 0 && <p className="px-3 py-2 text-xs text-white/70">No subtitle tracks found</p>}
                  {subtitleGroups.map((group) => (
                    <div key={group.key} className="border-t border-white/10 first:border-t-0">
                      <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-white/70">
                        {group.label}
                      </p>
                      {group.tracks.map((track) => {
                        const ordinal = subtitleTracks.findIndex((candidate) => candidate.index === track.index);
                        return (
                          <button
                            key={track.index}
                            type="button"
                            onClick={() => selectSubtitleTrack(track.index)}
                            aria-pressed={selectedSubtitleTrackIndex === track.index}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedSubtitleTrackIndex === track.index ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                          >
                            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${selectedSubtitleTrackIndex === track.index ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                            <span className="truncate">{trackLabel(track, ordinal)}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              {secondarySubtitlesAvailable && subtitleTracks.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold text-white">Secondary subtitle</p>
                    <p className="text-[10px] uppercase tracking-wide text-white/70">mpv</p>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-lg bg-white/10">
                    <button
                      type="button"
                      onClick={() => selectSecondarySubtitleTrack(-1)}
                      aria-pressed={selectedSecondarySubtitleTrackIndex === -1}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedSecondarySubtitleTrackIndex === -1 ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                    >
                      <span className={`h-2.5 w-2.5 rounded-full ${selectedSecondarySubtitleTrackIndex === -1 ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                      <span>Off</span>
                    </button>
                    {subtitleTracks.map((track, index) => (
                      <button
                        key={`secondary-${track.index}`}
                        type="button"
                        onClick={() => selectSecondarySubtitleTrack(track.index)}
                        aria-pressed={selectedSecondarySubtitleTrackIndex === track.index}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedSecondarySubtitleTrackIndex === track.index ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                      >
                        <span className={`h-2.5 w-2.5 rounded-full ${selectedSecondarySubtitleTrackIndex === track.index ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                        <span className="truncate">{trackLabel(track, index)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {subtitleStyleCompatibilityMessage ? (
                <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.08] p-4" role="status">
                  <p className="text-xs font-semibold text-white">Visual styling unavailable for this track</p>
                  <p className="mt-1 text-xs leading-relaxed text-white/75">{subtitleStyleCompatibilityMessage}</p>
                </div>
              ) : (
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
                    aria-label="Subtitle position"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={subtitleStyle.position}
                    aria-valuetext={`${Math.round(subtitleStyle.position)} percent`}
                    className="w-full accent-[var(--loom-accent)]"
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold text-white">Size</p>
                    <span className="text-xs text-[var(--loom-accent)]">{subtitleSizePercent(subtitleCueFontSize)}%</span>
                  </div>
                  <input
                    type="range"
                    min={24}
                    max={96}
                    step={1}
                    value={subtitleStyle.fontSize}
                    onChange={(event) => updateSubtitleStyle('fontSize', Number(event.target.value))}
                    aria-label="Subtitle size"
                    aria-valuemin={24}
                    aria-valuemax={96}
                    aria-valuenow={subtitleStyle.fontSize}
                    aria-valuetext={`${subtitleSizePercent(subtitleStyle.fontSize)} percent`}
                    className="w-full accent-[var(--loom-accent)]"
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold text-white">Outline</p>
                    <span className="text-xs text-[var(--loom-accent)]">{subtitleOutlinePercent(subtitleStyle.borderWidth)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={subtitleStyle.borderWidth}
                    onChange={(event) => updateSubtitleStyle('borderWidth', Number(event.target.value))}
                    aria-label="Subtitle outline"
                    aria-valuemin={0}
                    aria-valuemax={10}
                    aria-valuenow={subtitleStyle.borderWidth}
                    aria-valuetext={`${subtitleOutlinePercent(subtitleStyle.borderWidth)} percent`}
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
                        value={colorInputValue(String(subtitleStyle[key]))}
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
              )}

            </div>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
