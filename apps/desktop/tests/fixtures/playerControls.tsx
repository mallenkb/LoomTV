import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RulerSlider } from '@/components/ui/ruler-slider';
import { formatSyncOffset } from '@/components/VideoPlayer/syncOffset';
import PlayerControlBar from '@/components/VideoPlayer/PlayerControlBar';
import SubtitleOverlay from '@/components/VideoPlayer/SubtitleOverlay';
import SubtitleAppearancePanel from '@/components/VideoPlayer/SubtitleAppearancePanel';
import { DEFAULT_SUBTITLE_STYLE } from '@/components/VideoPlayer/constants';
import { applySubtitleStylePreset } from '@/components/VideoPlayer/subtitleStylePresets';
import { timelineSegmentBands } from '@/components/VideoPlayer/skipPrompt';
import type { SubtitleStyleSettings } from '@/components/VideoPlayer/types';
import '@/index.css';

// Every desktop call resolves to nothing, so previews and thumbnails stay idle.
Object.defineProperty(window, 'desktopApi', {
  configurable: true,
  value: new Proxy({}, { get: () => async () => null }),
});

declare global {
  interface Window {
    __fixture: {
      values: Record<string, number>;
      setControls: (visible: boolean) => void;
      setPosition: (position: number) => void;
    };
  }
}

const values: Record<string, number> = {};
const noop = () => undefined;
const DURATION = 1420;
const SEGMENTS = [
  { id: 'recap', type: 'recap', startMs: 0, endMs: 90_000, mediaDurationMs: DURATION * 1000 },
  { id: 'intro', type: 'intro', startMs: 150_000, endMs: 240_000, mediaDurationMs: DURATION * 1000 },
  { id: 'credits', type: 'credits', startMs: 1_290_000, endMs: null, mediaDurationMs: DURATION * 1000 },
];

function Fixture() {
  const [volume, setVolume] = useState(0.9);
  const [delay, setDelay] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [controls, setControls] = useState(true);
  const [style, setStyle] = useState<SubtitleStyleSettings>({ ...DEFAULT_SUBTITLE_STYLE });
  const refs = {
    seek: useRef<HTMLDivElement>(null), fill: useRef<HTMLDivElement>(null), thumb: useRef<HTMLDivElement>(null),
    hud: useRef<HTMLDivElement>(null), current: useRef<HTMLSpanElement>(null), total: useRef<HTMLSpanElement>(null),
    position: useRef(200), video: useRef<HTMLVideoElement>(null),
  };
  const [clock] = useState(() => new EventTarget());
  Object.assign(values, { volume, delay, zoom, position: style.position, opacity: style.backgroundOpacity });
  window.__fixture = {
    values,
    setControls,
    setPosition: (position) => setStyle((current) => ({ ...current, position })),
  };
  const progressPct = (refs.position.current / DURATION) * 100;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16, padding: 16, background: 'var(--loom-bg)', color: 'white' }}>
      <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
        <div data-testid="player" style={{ position: 'relative', height: 540, overflow: 'hidden', borderRadius: 12, background: '#334155' }}>
          <SubtitleOverlay
            controlsVisible={controls}
            cues={[{ start: 0, end: 99_999, text: 'Subtitle position check' }]}
            videoRef={refs.video}
            currentTimeRef={refs.position}
            style={style}
            visible
            paused
            clockEvents={clock}
          />
          <PlayerControlBar
            filePath="/fixture.mkv"
            showControls={controls}
            seekSliderRef={refs.seek}
            progressFillRef={refs.fill}
            progressThumbRef={refs.thumb}
            scrubTimeHudRef={refs.hud}
            currentTimeTextRef={refs.current}
            durationTimeTextRef={refs.total}
            playbackPositionRef={refs.position}
            duration={DURATION}
            position={refs.position.current}
            isLiveStream={false}
            showRemainingTime={false}
            progressPct={progressPct}
            timelineSegments={timelineSegmentBands(SEGMENTS, DURATION)}
            paused
            muted={false}
            volume={volume}
            skipBackSeconds={10}
            skipForwardSeconds={10}
            hasEpisodes
            showSidebar={false}
            showMediaPanel={false}
            mediaPanelTab="video"
            fullscreen={false}
            handleProgressPointerDown={noop}
            handleProgressKeyDown={noop}
            togglePlay={noop}
            toggleTimeDisplay={noop}
            seekTo={noop}
            toggleMute={noop}
            handleVolume={setVolume}
            handlePrevEpisode={noop}
            handleNextEpisode={noop}
            openEpisodePanel={noop}
            openSubtitlesPanel={noop}
            openMediaPanel={noop}
            toggleFullscreen={noop}
          />
        </div>
        <div data-testid="app-sliders" style={{ display: 'grid', gap: 12, borderRadius: 12, padding: 16, background: 'var(--loom-surface)' }}>
          <RulerSlider tone="app" label="Zoom" min={1} max={3} step={0.01} value={zoom} defaultValue={1} format={(v) => `${Math.round(v * 100)}%`} onValueChange={setZoom} />
          <div data-testid="media-sliders" style={{ borderRadius: 12, padding: 12, background: 'rgb(0 0 0 / 0.6)' }}>
            <RulerSlider label="Sync" min={-5} max={5} step={0.05} value={delay} defaultValue={0}
              format={formatSyncOffset} onValueChange={setDelay} aria-label="Audio delay" />
          </div>
        </div>
      </div>
      <div data-testid="appearance" style={{ borderRadius: 12, padding: 16, background: '#1c1c1c', alignSelf: 'start' }}>
        <SubtitleAppearancePanel
          style={style}
          updateStyle={(key, value) => setStyle((current) => ({ ...current, [key]: value }))}
          applyPreset={(preset) => setStyle((current) => applySubtitleStylePreset(current, preset))}
        />
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<Fixture />);
