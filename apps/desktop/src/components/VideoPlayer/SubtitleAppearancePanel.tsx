import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { SubtitleStyleSettings } from './types';
import { MAX_SOFT_BOX_OPACITY, MIN_SOFT_BOX_OPACITY, selectedSubtitleStylePreset, type SubtitleStylePreset } from './subtitleStylePresets';
import StyledSubtitleText from './StyledSubtitleText';
import { DEFAULT_SUBTITLE_STYLE } from './constants';
import { RulerSlider } from '@/components/ui/ruler-slider';
import { formatSyncOffset, type OnlineSubtitleTiming } from './syncOffset';

// Corners: the card matches the track list (rounded-lg, 12px in this theme);
// tiles and toggle tracks are 8px, and controls inside them 6px.
const PRESETS: { value: SubtitleStylePreset; label: string; sample: string }[] = [
  { value: 'plain', label: 'Outline', sample: '[text-shadow:0_0_2px_#000,0_0_2px_#000]' },
  { value: 'soft', label: 'Soft box', sample: 'rounded bg-black/60 px-1.5' },
  { value: 'solid', label: 'Solid box', sample: 'rounded bg-black px-1.5' },
];

// Font sizes behind S/M/L/XL; 32 is the default (100%).
export const SUBTITLE_SIZE_STEPS = [
  { label: 'S', value: 24 }, { label: 'M', value: 32 }, { label: 'L', value: 40 }, { label: 'XL', value: 48 },
] as const;
// Position is the distance from the top in percent. Raised clears burned-in
// captions; High clears a lower-third or on-screen graphics.
export const SUBTITLE_POSITION_STEPS = [
  { label: 'Bottom', value: DEFAULT_SUBTITLE_STYLE.position }, { label: 'Raised', value: 92 }, { label: 'High', value: 86 },
] as const;

// The Height slider in More options goes up to 40% above the bottom edge.
const MAX_SUBTITLE_HEIGHT_PERCENT = 40;

// How far the preview lifts its text for each position step.
const PREVIEW_POSITION_PADDING: Record<(typeof SUBTITLE_POSITION_STEPS)[number]['label'], string> = {
  Bottom: 'pb-3', Raised: 'pb-7', High: 'pb-11',
};

/** The step closest to a stored value, so in-between values from older versions still show a selection. */
export function nearestStep<T extends { value: number }>(steps: readonly T[], value: number): T {
  return steps.reduce((best, step) => (Math.abs(step.value - value) < Math.abs(best.value - value) ? step : best));
}

function Segmented<T extends { label: string; value: number }>({ label, steps, value, onChange }: {
  label: string;
  steps: readonly T[];
  value: number;
  onChange: (value: number) => void;
}) {
  const selected = nearestStep(steps, value);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-white/80">{label}</span>
      <div role="group" aria-label={`Subtitle ${label.toLowerCase()}`}
        className="grid w-48 auto-cols-fr grid-flow-col gap-0.5 rounded-[8px] bg-white/[0.08] p-0.5">
        {steps.map(step => (
          <button key={step.label} type="button" aria-pressed={selected === step}
            onClick={() => onChange(step.value)}
            className={`rounded-[6px] py-1 text-[13px] font-medium transition-colors ${selected === step
              ? 'bg-white/20 text-white'
              : 'text-white/70 hover:text-white'}`}>
            {step.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SubtitleAppearancePanel({ style, updateStyle, applyPreset, previewImage, timing }: {
  style: SubtitleStyleSettings;
  /** A still from what is playing, so the preview shows subtitles over a real scene. */
  previewImage?: string;
  updateStyle: (key: keyof SubtitleStyleSettings, value: number | string | boolean) => void;
  applyPreset: (preset: SubtitleStylePreset) => void;
  /** Present while an online subtitle is showing; adds Timing to More options. */
  timing?: OnlineSubtitleTiming;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const selected = selectedSubtitleStylePreset(style);
  const previewFontSize = 14 * style.fontSize * style.scale / 32;
  const previewStyle = { ...style, borderWidth: style.borderWidth * previewFontSize / (style.fontSize * style.scale) };
  const reset = () => {
    applyPreset('soft');
    updateStyle('fontSize', DEFAULT_SUBTITLE_STYLE.fontSize);
    updateStyle('position', DEFAULT_SUBTITLE_STYLE.position);
  };
  return (
    <section aria-labelledby="subtitle-appearance-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="subtitle-appearance-heading" className="text-xs font-semibold text-white">Appearance</h3>
        <button type="button" onClick={reset} className="rounded-[6px] bg-white/10 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-white/[0.16]">Reset</button>
      </div>
      <div className="rounded-lg bg-white/[0.04] p-3">
        <div className={`flex h-28 items-end justify-center overflow-hidden rounded-[8px] bg-slate-500/40 bg-cover bg-center px-2 transition-[padding] ${PREVIEW_POSITION_PADDING[nearestStep(SUBTITLE_POSITION_STEPS, style.position).label]}`}
          style={previewImage ? { backgroundImage: `url(${JSON.stringify(previewImage)})` } : undefined}
          aria-label="Subtitle appearance preview">
          <div className="text-center">
            <StyledSubtitleText text="This is how your subtitles will look." style={previewStyle} fontSize={previewFontSize} />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label="Subtitle style preset">
          {PRESETS.map(preset => (
            <button key={preset.value} type="button" aria-pressed={selected === preset.value}
              onClick={() => applyPreset(preset.value)}
              className={`flex min-w-0 flex-col items-center gap-1 rounded-[8px] border px-1 py-2 text-[13px] font-medium transition-colors ${selected === preset.value
                ? 'border-[var(--loom-accent)] bg-[var(--loom-accent)]/15 text-white'
                : 'border-transparent bg-white/[0.06] text-white/80 hover:bg-white/10 hover:text-white'}`}>
              <span aria-hidden="true" className={`text-base font-semibold leading-snug text-white ${preset.sample}`}>Aa</span>
              {preset.label}
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-2.5">
          <Segmented label="Size" steps={SUBTITLE_SIZE_STEPS} value={style.fontSize} onChange={value => updateStyle('fontSize', value)} />
          <Segmented label="Position" steps={SUBTITLE_POSITION_STEPS} value={style.position} onChange={value => updateStyle('position', value)} />
        </div>
        <div className="mt-3 overflow-hidden rounded-[8px] bg-white/[0.06]">
          <button type="button" aria-expanded={moreOpen} aria-controls="subtitle-appearance-more"
            onClick={() => setMoreOpen(open => !open)}
            className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/[0.06]">
            More options
            <ChevronDown aria-hidden="true" className={`h-4 w-4 text-white/70 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
          </button>
          {moreOpen && (
            <div id="subtitle-appearance-more" className="grid gap-3 border-t border-white/10 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-white/90">Colors</span>
                <div className="flex gap-3">
                  {([['fontColor', 'Text'], ['backgroundColor', 'Box']] as const)
                    .filter(([key]) => key !== 'backgroundColor' || style.backgroundEnabled)
                    .map(([key, label]) => (
                      <label key={key} className="flex items-center gap-1.5 text-sm text-white/90">
                        <input type="color" value={/^#[0-9a-f]{6}$/i.test(style[key]) ? style[key] : '#000000'}
                          onChange={event => updateStyle(key, event.target.value)}
                          className="h-8 w-8 cursor-pointer rounded-[6px]" />
                        {label}
                      </label>
                    ))}
                </div>
              </div>
              {timing && (
                <RulerSlider label="Timing" min={-10} max={10} step={0.25} value={timing.delay} defaultValue={0}
                  format={formatSyncOffset}
                  onValueChange={timing.setDelay}
                  onKeyDown={event => event.stopPropagation()}
                  aria-valuetext={`${Math.abs(timing.delay).toFixed(2)} seconds ${timing.delay < 0 ? 'earlier' : timing.delay > 0 ? 'later' : 'offset'}`} />
              )}
              {/* Fine-tunes the position presets; the slider reads as height above the bottom edge. */}
              <RulerSlider label="Height" min={0} max={MAX_SUBTITLE_HEIGHT_PERCENT} step={1}
                value={Math.round(100 - style.position)}
                defaultValue={100 - DEFAULT_SUBTITLE_STYLE.position}
                marks={SUBTITLE_POSITION_STEPS.map(step => 100 - step.value)}
                format={height => `${height}%`}
                onValueChange={height => updateStyle('position', 100 - height)}
                aria-valuetext={`${Math.round(100 - style.position)}% from the bottom`} />
              {selected === 'soft' && (
                <RulerSlider label="Box opacity" min={MIN_SOFT_BOX_OPACITY * 100} max={MAX_SOFT_BOX_OPACITY * 100} step={5}
                  value={Math.round(style.backgroundOpacity * 100)}
                  defaultValue={MAX_SOFT_BOX_OPACITY * 100}
                  format={opacity => `${opacity}%`}
                  onValueChange={opacity => updateStyle('backgroundOpacity', opacity / 100)} />
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
