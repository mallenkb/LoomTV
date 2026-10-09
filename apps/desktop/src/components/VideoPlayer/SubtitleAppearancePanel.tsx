import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { SubtitleStyleSettings } from './types';
import { MAX_SOFT_BOX_OPACITY, MIN_SOFT_BOX_OPACITY, selectedSubtitleStylePreset, type SubtitleStylePreset } from './subtitleStylePresets';
import StyledSubtitleText from './StyledSubtitleText';
import { DEFAULT_SUBTITLE_STYLE } from './constants';

const PRESETS: { value: SubtitleStylePreset; label: string; sample: string }[] = [
  { value: 'plain', label: 'Outline', sample: '[text-shadow:0_0_2px_#000,0_0_2px_#000]' },
  { value: 'soft', label: 'Soft box', sample: 'rounded bg-black/60 px-1.5' },
  { value: 'solid', label: 'Solid box', sample: 'rounded bg-black px-1.5' },
];

// Font sizes behind S/M/L/XL; 32 is the default (100%).
export const SUBTITLE_SIZE_STEPS = [
  { label: 'S', value: 24 }, { label: 'M', value: 32 }, { label: 'L', value: 40 }, { label: 'XL', value: 48 },
] as const;
// Position is the distance from the top in percent; Raised clears burned-in captions.
export const SUBTITLE_POSITION_STEPS = [
  { label: 'Bottom', value: DEFAULT_SUBTITLE_STYLE.position }, { label: 'Raised', value: 85 },
] as const;

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
      <span className="text-sm font-medium text-white/90">{label}</span>
      <div role="group" aria-label={`Subtitle ${label.toLowerCase()}`} className="flex gap-0.5 rounded-lg bg-white/10 p-0.5">
        {steps.map(step => (
          <button key={step.label} type="button" aria-pressed={selected === step}
            onClick={() => onChange(step.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${selected === step
              ? 'bg-[var(--loom-accent)] text-white'
              : 'text-white/90 hover:bg-white/10'}`}>
            {step.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SubtitleAppearancePanel({ style, updateStyle, applyPreset }: {
  style: SubtitleStyleSettings;
  updateStyle: (key: keyof SubtitleStyleSettings, value: number | string | boolean) => void;
  applyPreset: (preset: SubtitleStylePreset) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const selected = selectedSubtitleStylePreset(style);
  const previewFontSize = 15 * style.fontSize * style.scale / 32;
  const previewStyle = { ...style, borderWidth: style.borderWidth * previewFontSize / (style.fontSize * style.scale) };
  const reset = () => {
    applyPreset('soft');
    updateStyle('fontSize', DEFAULT_SUBTITLE_STYLE.fontSize);
    updateStyle('position', DEFAULT_SUBTITLE_STYLE.position);
  };
  return (
    <section className="rounded-xl bg-white/[0.06] p-3.5" aria-label="Subtitle appearance">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-white">Subtitles</h3>
        <span className="text-xs text-white/75">Applies live</span>
      </div>
      <div className="mt-3 flex h-[72px] items-end justify-center overflow-hidden rounded-lg bg-slate-600/70 px-2 pb-2"
        aria-label="Subtitle appearance preview">
        <StyledSubtitleText text="This is a subtitle preview." style={previewStyle} fontSize={previewFontSize} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label="Subtitle style preset">
        {PRESETS.map(preset => (
          <button key={preset.value} type="button" aria-pressed={selected === preset.value}
            onClick={() => applyPreset(preset.value)}
            className={`flex min-w-0 flex-col items-center gap-1.5 rounded-lg border-[1.5px] px-1 py-2 text-sm font-medium transition-colors ${selected === preset.value
              ? 'border-[var(--loom-accent)] bg-[var(--loom-accent)]/25 text-white'
              : 'border-white/30 bg-white/[0.05] text-white/90 hover:bg-white/10'}`}>
            <span aria-hidden="true" className={`text-xl font-semibold leading-snug text-white ${preset.sample}`}>Aa</span>
            {preset.label}
          </button>
        ))}
      </div>
      <div className="mt-4 grid gap-3">
        <Segmented label="Size" steps={SUBTITLE_SIZE_STEPS} value={style.fontSize} onChange={value => updateStyle('fontSize', value)} />
        <Segmented label="Position" steps={SUBTITLE_POSITION_STEPS} value={style.position} onChange={value => updateStyle('position', value)} />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-white/15 pt-3">
        <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen(open => !open)}
          className="flex items-center gap-1.5 text-sm font-medium text-white/90 hover:text-white">
          <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
          More
        </button>
        <button type="button" onClick={reset} className="text-sm font-medium text-white/90 hover:text-white">Reset</button>
      </div>
      {moreOpen && (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-white/90">Colors</span>
            <div className="flex gap-3">
              {([['fontColor', 'Text'], ['backgroundColor', 'Box']] as const)
                .filter(([key]) => key !== 'backgroundColor' || style.backgroundEnabled)
                .map(([key, label]) => (
                  <label key={key} className="flex items-center gap-1.5 text-sm text-white/90">
                    <input type="color" value={/^#[0-9a-f]{6}$/i.test(style[key]) ? style[key] : '#000000'}
                      onChange={event => updateStyle(key, event.target.value)}
                      className="h-8 w-8 cursor-pointer rounded-md border border-white/40 bg-transparent p-0.5" />
                    {label}
                  </label>
                ))}
            </div>
          </div>
          {selected === 'soft' && (
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-white/90">Box opacity</span>
              <input type="range" min={MIN_SOFT_BOX_OPACITY * 100} max={MAX_SOFT_BOX_OPACITY * 100} step={5}
                value={Math.round(style.backgroundOpacity * 100)}
                onChange={event => updateStyle('backgroundOpacity', Number(event.target.value) / 100)}
                aria-valuetext={`${Math.round(style.backgroundOpacity * 100)}%`}
                className="w-36 accent-[var(--loom-accent)]" />
            </label>
          )}
        </div>
      )}
    </section>
  );
}
