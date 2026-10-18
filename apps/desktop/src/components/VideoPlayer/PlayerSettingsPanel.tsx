import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { compareSubtitleLanguages, subtitleLanguageLabel } from '../../lib/openSubtitlesV3';
import { ScrollArea } from '../ui/scroll-area';
import { clampSidePanelWidth, trackLabel } from './helpers';
import SubtitleAppearancePanel from './SubtitleAppearancePanel';
import type { SubtitleStylePreset } from './subtitleStylePresets';
import type {
  AspectMode,
  ControlTab,
  CropMode,
  MediaTrack,
  RotationMode,
  SubtitleStyleSettings,
} from './types';
import { RulerSlider } from '@/components/ui/ruler-slider';
import { formatSyncOffset, type OnlineSubtitleTiming } from './syncOffset';

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
];

const ROTATION_OPTIONS: { value: RotationMode; label: string }[] = [
  { value: 0, label: '0°' },
  { value: 90, label: '90°' },
  { value: 180, label: '180°' },
  { value: 270, label: '270°' },
];

const SPEED_OPTIONS = [
  { value: 0.5, label: '0.5x' },
  { value: 0.75, label: '0.75x' },
  { value: 1, label: '1x' },
  { value: 1.25, label: '1.25x' },
  { value: 1.5, label: '1.5x' },
  { value: 2, label: '2x' },
] as const;

const DISPLAY_SLEEP_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
  { value: 45, label: '45m' },
  { value: 60, label: '1h' },
  { value: 90, label: '1.5h' },
  { value: 120, label: '2h' },
] as const;

function SegmentedSetting<T extends string | number>({
  options,
  value,
  onChange,
  label,
  columns,
  disabled = false,
}: {
  label: string;
  /** Grid columns; container-query variants keep rows even at narrow widths. */
  columns: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label}
      className={`grid ${columns} gap-0.5 rounded-[8px] bg-white/[0.08] p-0.5`}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          disabled={disabled}
          aria-pressed={value === option.value}
          className={`whitespace-nowrap rounded-[6px] px-1 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${value === option.value ? 'bg-white/20 text-white' : 'text-white/70 enabled:hover:text-white'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type SkipRescanState = { state: 'idle' | 'scanning' | 'done' } | { state: 'error'; message: string };

interface PlayerSettingsPanelProps {
  videoOnly?: boolean;
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
    /** The file's name before LoomTV first renamed it. */
    originalFile?: string;
    engine: string;
    mode: string;
    hardwareDecode: string;
    encodeBackend: string;
    /** Label and value pairs describing the file's video stream. */
    videoSpecs: [string, string][];
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
  /** Rendered inside the Online tab; `active` is true while that tab is showing. */
  onlineSubtitles?: (active: boolean) => React.ReactNode;
  /** Delay for the online subtitle that is showing, if any; shown under More options. */
  onlineSubtitleTiming?: OnlineSubtitleTiming;
  selectedSubtitleTrackIndex: number;
  selectSubtitleTrack: (trackIndex: number) => void;
  secondarySubtitlesAvailable: boolean;
  selectedSecondarySubtitleTrackIndex: number;
  selectSecondarySubtitleTrack: (trackIndex: number) => void;
  subtitleStyle: SubtitleStyleSettings;
  /** Episode still or title backdrop shown behind the subtitle preview. */
  subtitlePreviewImage?: string;
  subtitleStyleCompatibilityMessage?: string;
  updateSubtitleStyle: (key: keyof SubtitleStyleSettings, value: number | string | boolean) => void;
  applySubtitlePreset: (preset: SubtitleStylePreset) => void;
  onCorrectSkipTiming: () => void;
  /** Present when a rescan is possible for what's playing. */
  skipRescan?: SkipRescanState;
  onRescanSkipMarkers?: () => void;
}

export default function PlayerSettingsPanel({
  videoOnly = false,
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
  onlineSubtitles,
  onlineSubtitleTiming,
  selectedSubtitleTrackIndex,
  selectSubtitleTrack,
  secondarySubtitlesAvailable,
  selectedSecondarySubtitleTrackIndex,
  selectSecondarySubtitleTrack,
  subtitleStyle,
  subtitlePreviewImage,
  subtitleStyleCompatibilityMessage,
  updateSubtitleStyle,
  applySubtitlePreset,
  onCorrectSkipTiming,
  skipRescan,
  onRescanSkipMarkers,
}: PlayerSettingsPanelProps) {
  const activeTab: ControlTab = videoOnly ? 'video' : mediaPanelTab;
  // Subtitles open as their own tray; Audio and Video share the other one.
  const subtitlesTray = activeTab === 'subtitles';
  const trayTitle = videoOnly ? 'Video settings' : subtitlesTray ? 'Subtitles' : 'Playback settings';
  // The subtitles tray splits local tracks and styling from the online search.
  const [subtitleSection, setSubtitleSection] = useState<'tracks' | 'online'>('tracks');
  const showOnlineTab = subtitlesTray && Boolean(onlineSubtitles);
  const trayTabs: { id: string; label: string; selected: boolean; select: () => void }[] = videoOnly ? []
    : subtitlesTray
      ? showOnlineTab
        ? [
          { id: 'tracks', label: 'Subtitles', selected: subtitleSection === 'tracks', select: () => setSubtitleSection('tracks') },
          { id: 'online', label: 'Open Subtitles', selected: subtitleSection === 'online', select: () => setSubtitleSection('online') },
        ]
        : []
      : (['audio', 'video'] as ControlTab[]).map((tab) => ({
        id: tab, label: tab === 'audio' ? 'Audio' : 'Video', selected: activeTab === tab, select: () => setMediaPanelTab(tab),
      }));
  const trackSource = (track: MediaTrack) => track.source === 'opensubtitles' ? 'OpenSubtitles download'
    : track.source === 'sidecar' ? 'Added subtitle file' : 'Embedded in video';
  const subtitleGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; tracks: MediaTrack[] }>();
    subtitleTracks.forEach((track) => {
      const label = subtitleLanguageLabel(track.language);
      const group = groups.get(label) || { key: label, label, tracks: [] };
      group.tracks.push(track);
      groups.set(label, group);
    });
    return [...groups.values()].sort((a, b) => compareSubtitleLanguages(a.label, b.label));
  }, [subtitleTracks]);

  // Shown under both subtitle tabs, so a downloaded subtitle can be styled in place.
  const subtitleAppearance = subtitleStyleCompatibilityMessage ? (
    <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.08] p-4" role="status">
      <p className="text-xs font-semibold text-white">Visual styling unavailable for this track</p>
      <p className="mt-1 text-xs leading-relaxed text-white/75">{subtitleStyleCompatibilityMessage}</p>
    </div>
  ) : (
    <SubtitleAppearancePanel
      style={subtitleStyle}
      updateStyle={updateSubtitleStyle}
      applyPreset={applySubtitlePreset}
      previewImage={subtitlePreviewImage}
      timing={onlineSubtitleTiming}
    />
  );

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
        <span className="h-12 w-1 rounded-full bg-[var(--loom-accent)]/70 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      <div className="space-y-3 border-b border-white/10 px-5 pb-4 pt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-base font-semibold tracking-tight text-white">{trayTitle}</p>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--loom-muted)] transition-colors hover:bg-white/10 hover:text-white"
            aria-label={`Close ${trayTitle.toLowerCase()}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {trayTabs.length > 0 && (
          <div className="grid grid-cols-2 gap-0.5 rounded-[8px] bg-white/[0.08] p-0.5" role="tablist" aria-label={`${trayTitle} sections`}>
            {trayTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={tab.select}
                role="tab"
                aria-selected={tab.selected}
                className={`rounded-[6px] py-1.5 text-[13px] font-medium transition-colors ${tab.selected ? 'bg-white text-neutral-950' : 'text-white/70 hover:text-white'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="@container p-5 text-sm text-white/85">
          {activeTab === 'video' && (
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

              <section aria-labelledby="picture-heading">
                <p id="picture-heading" className="mb-2 text-xs font-semibold text-white">Picture</p>
                <div className="space-y-3 rounded-lg bg-white/10 p-3">
                  <div className="space-y-1.5">
                    <p className="text-xs text-white/80">Aspect ratio</p>
                    <SegmentedSetting label="Aspect ratio" columns="grid-cols-3 @[19rem]:grid-cols-6" options={ASPECT_OPTIONS} value={aspectMode} onChange={setAspectMode} />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs text-white/80">Crop</p>
                    {/* 'custom' was never implemented and crops nothing, so it shows as None. */}
                    <SegmentedSetting label="Crop" columns="grid-cols-3 @[19rem]:grid-cols-6" options={CROP_OPTIONS} value={cropMode === 'custom' ? 'none' : cropMode} onChange={setCropMode} />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-xs text-white/80">Rotation</p>
                      {!rotationAvailable && <p className="text-[10px] text-white/55">Not available with LibVLC</p>}
                    </div>
                    <SegmentedSetting
                      label="Rotation"
                      columns="grid-cols-4"
                      options={ROTATION_OPTIONS}
                      value={rotation}
                      onChange={setRotation}
                      disabled={!rotationAvailable}
                    />
                  </div>
                </div>
              </section>

              <section aria-labelledby="speed-heading">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p id="speed-heading" className="text-xs font-semibold text-white">Speed</p>
                  <div className="flex items-center gap-3">
                    {!SPEED_OPTIONS.some((option) => option.value === playbackRate) && (
                      <p className="text-[10px] tabular-nums text-white/70">{playbackRate.toFixed(2)}x</p>
                    )}
                    {playbackRate !== 1 && (
                      <button type="button" onClick={() => setPlaybackRate(1)}
                        className="rounded-[6px] bg-white/10 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-white/[0.16]">Reset</button>
                    )}
                  </div>
                </div>
                <div className="rounded-lg bg-white/10 p-3">
                  <SegmentedSetting label="Playback speed" columns="grid-cols-3 @[19rem]:grid-cols-6" options={SPEED_OPTIONS} value={playbackRate} onChange={setPlaybackRate} />
                </div>
              </section>

              {displaySleepSettingsAvailable && <section aria-labelledby="display-sleep-heading">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 id="display-sleep-heading" className="text-xs font-semibold text-white">Display sleep</h3>
                  <p className="text-[10px] uppercase tracking-wide tabular-nums text-white/70" aria-live="polite">
                    {displaySleepTimeoutMinutes === 0
                      ? 'Off'
                      : playbackPaused
                        ? 'Paused'
                        : `${String(Math.floor((displaySleepTimerRemainingSeconds || 0) / 60)).padStart(2, '0')}:${String((displaySleepTimerRemainingSeconds || 0) % 60).padStart(2, '0')}`}
                  </p>
                </div>
                <div className="space-y-2 rounded-lg bg-white/10 p-3">
                  <SegmentedSetting label="Display sleep" columns="grid-cols-4 @[23rem]:grid-cols-7" options={DISPLAY_SLEEP_OPTIONS} value={displaySleepTimeoutMinutes}
                    onChange={setDisplaySleepTimeoutMinutes} />
                  <p className={`text-[11px] leading-relaxed ${displaySleepTimeoutError ? 'text-red-300' : 'text-white/60'}`} role={displaySleepTimeoutError ? 'alert' : undefined}>
                    {displaySleepTimeoutError || (displaySleepTimeoutMinutes === 0
                      ? 'The display stays awake while a video plays.'
                      : 'Lets the display sleep after this long. Pausing resets the countdown.')}
                  </p>
                </div>
              </section>}

              <section aria-labelledby="advanced-settings-heading">
                <h3 id="advanced-settings-heading" className="mb-2 text-xs font-semibold text-white">Advanced</h3>
                <div className="rounded-lg bg-white/10 p-3">
                  <button
                    type="button"
                    onClick={onCorrectSkipTiming}
                    className="w-full rounded-[8px] bg-white/[0.08] px-3 py-2 text-left text-xs font-medium text-white transition-colors hover:bg-white/15"
                  >
                    Correct automatic skip timing
                  </button>
                  {skipRescan && onRescanSkipMarkers && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={onRescanSkipMarkers}
                        disabled={skipRescan.state === 'scanning'}
                        className="w-full rounded-[8px] bg-white/[0.08] px-3 py-2 text-left text-xs font-medium text-white transition-colors hover:bg-white/15 disabled:cursor-wait disabled:opacity-70"
                      >
                        {skipRescan.state === 'scanning' ? 'Scanning intro and credits…' : 'Rescan intro and credits'}
                      </button>
                      {(skipRescan.state === 'done' || skipRescan.state === 'error') && (
                        <p role="status" className={`mt-1.5 text-[11px] ${skipRescan.state === 'error' ? 'text-amber-200/90' : 'text-white/60'}`}>
                          {skipRescan.state === 'error' ? skipRescan.message : 'Markers updated on the timeline.'}
                        </p>
                      )}
                    </div>
                  )}

                  <section className="mt-3 border-t border-white/10 pt-3" aria-labelledby="playback-information-heading">
                    <h4 id="playback-information-heading" className="text-xs font-semibold text-white">Playback information</h4>
                    <dl className="mt-3 space-y-2 text-xs">
                      {[
                        ['Engine', playbackInformation.engine],
                        ['Mode', playbackInformation.mode],
                        ['Video', selectedTrackLabel(videoTracks, selectedVideoTrackIndex, 'Not selected')],
                        ...playbackInformation.videoSpecs,
                        ...(videoOnly ? [] : [
                          ['Audio', selectedTrackLabel(audioTracks, selectedAudioTrackIndex, 'Not selected')],
                          ['Subtitles', selectedTrackLabel(subtitleTracks, selectedSubtitleTrackIndex, 'Off')],
                        ]),
                        ['Hardware decode', playbackInformation.hardwareDecode],
                        ['Encode backend', playbackInformation.encodeBackend],
                        ...(playbackInformation.originalFile ? [['Original file', playbackInformation.originalFile]] : []),
                      ].map(([label, value]) => (
                        String(value).length > 24 ? (
                          <div key={label} className="space-y-0.5">
                            <dt className="text-white/70">{label}</dt>
                            <dd className="break-words text-white/85">{value}</dd>
                          </div>
                        ) : (
                          <div key={label} className="flex justify-between gap-3">
                            <dt className="text-white/70">{label}</dt>
                            <dd className="text-right text-white/85">{value}</dd>
                          </div>
                        )
                      ))}
                    </dl>
                    {playbackInformation.note && (
                      <p className="mt-3 border-t border-white/10 pt-3 text-[10px] leading-relaxed text-white/70">
                        {playbackInformation.note}
                      </p>
                    )}
                  </section>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'audio' && (
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
                    <RulerSlider
                      label="Sync"
                      min={-5}
                      max={5}
                      step={0.05}
                      value={audioDelay}
                      defaultValue={0}
                      format={formatSyncOffset}
                      onValueChange={updateAudioDelay}
                      aria-label="Audio delay"
                      aria-valuetext={`${audioDelay.toFixed(2)} seconds`}
                    />
                  </div>
                ) : (
                  <p className="rounded-lg bg-white/10 px-3 py-2 text-xs text-white/70">
                    Delay controls are available with native libmpv playback.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Stays mounted while hidden so search results survive tab switches. */}
          {activeTab === 'subtitles' && showOnlineTab && (
            <div className={`space-y-5 ${subtitleSection === 'online' ? '' : 'hidden'}`}>
              {onlineSubtitles?.(subtitleSection === 'online')}
              {subtitleSection === 'online' && subtitleAppearance}
            </div>
          )}

          {activeTab === 'subtitles' && (!showOnlineTab || subtitleSection === 'tracks') && (
            <div className="space-y-5">
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold text-white">Subtitle track</p>
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
                            <span className="min-w-0"><span className="block truncate">{trackLabel(track, ordinal)}</span><span className="mt-0.5 block text-[10px] text-white/50">{trackSource(track)}</span></span>
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
                    <p className="text-[10px] uppercase tracking-wide text-white/70">libmpv</p>
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

              {subtitleAppearance}

            </div>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
