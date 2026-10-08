import type { SubtitleStyleSettings } from './types';
import { MAX_SOFT_BOX_OPACITY, MIN_SOFT_BOX_OPACITY, selectedSubtitleStylePreset, type SubtitleStylePreset } from './subtitleStylePresets';
import StyledSubtitleText from './StyledSubtitleText';
import { MIN_SUBTITLE_BACKGROUND_BLUR_PERCENT } from '../../shared/subtitleBackground.ts';

const PRESETS: { value: SubtitleStylePreset; label: string; sample: string }[] = [
  { value: 'plain', label: 'Plain', sample: '' },
  { value: 'soft', label: 'Soft box', sample: 'rounded-md bg-black/70 px-2' },
  { value: 'solid', label: 'Solid box', sample: 'rounded-md bg-black px-2' },
];

function StyleSlider({ label, value, displayValue, min, max, step = 1, onChange }: {
  label: string;
  value: number;
  displayValue: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid min-h-8 grid-cols-[4rem_minmax(0,1fr)_2.5rem] items-center gap-2 text-xs">
      <span className="text-white/85">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={event => onChange(Number(event.target.value))}
        aria-label={`Subtitle ${label.toLowerCase()}`} aria-valuetext={displayValue}
        className="min-w-0 w-full accent-[var(--loom-accent)]" />
      <output className="text-right text-[11px] tabular-nums text-white/60">{displayValue}</output>
    </label>
  );
}

export default function SubtitleAppearancePanel({ style, updateStyle, applyPreset }: {
  style: SubtitleStyleSettings;
  updateStyle: (key: keyof SubtitleStyleSettings, value: number | string | boolean) => void;
  applyPreset: (preset: SubtitleStylePreset) => void;
}) {
  const selected = selectedSubtitleStylePreset(style);
  const previewFontSize = 14 * style.fontSize * style.scale / 32;
  const previewStyle = { ...style, borderWidth: style.borderWidth * previewFontSize / (style.fontSize * style.scale) };
  return (
    <section className="rounded-xl bg-white/[0.06] p-3" aria-label="Subtitle appearance">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-white">Subtitle style</h3>
        <span className="text-[11px] text-white/60">Live preview</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Subtitle style preset">
        {PRESETS.map(preset => (
          <button key={preset.value} type="button" aria-pressed={selected === preset.value}
            onClick={() => applyPreset(preset.value)}
            className={`flex min-h-[3.75rem] min-w-0 flex-col items-center justify-center gap-1 rounded-lg border px-1 py-1.5 text-[11px] transition-colors ${selected === preset.value
              ? 'border-[var(--loom-accent)] bg-[var(--loom-accent)]/10 text-white'
              : 'border-white/15 bg-white/[0.04] text-white/80 hover:bg-white/10'}`}>
            <span aria-hidden="true" className={`text-lg leading-normal text-white ${preset.value === 'plain' ? 'font-semibold' : 'font-bold'} ${preset.sample}`}>Aa</span>
            {preset.label}
          </button>
        ))}
      </div>
      <div className="relative my-3 overflow-hidden rounded-lg bg-gradient-to-br from-slate-500/60 via-slate-700/60 to-neutral-800"
        style={{ height: Math.max(76, previewFontSize * 3 + 16) }} aria-label="Subtitle appearance preview">
        <div className="absolute inset-x-2 top-1/2 -translate-y-1/2 text-center">
          <StyledSubtitleText text={'This is a subtitle preview.\nA second line of dialogue.'} style={previewStyle} fontSize={previewFontSize} />
        </div>
      </div>
      <StyleSlider label="Size" min={24} max={96} value={style.fontSize} displayValue={`${Math.round(style.fontSize / 32 * 100)}%`}
        onChange={value => updateStyle('fontSize', value)} />
      <StyleSlider label="Position" min={0} max={100} value={style.position} displayValue={`${Math.round(style.position)}%`}
        onChange={value => updateStyle('position', value)} />
      <details className="mt-2 border-t border-white/10 pt-2">
        <summary className="cursor-pointer py-1 text-xs text-white/80">Fine-tune</summary>
        {style.backgroundEnabled && <>
          <StyleSlider label="Opacity" min={selected === 'soft' ? MIN_SOFT_BOX_OPACITY * 100 : 0} max={selected === 'soft' ? MAX_SOFT_BOX_OPACITY * 100 : 100} step={5} value={Math.round(style.backgroundOpacity * 100)} displayValue={`${Math.round(style.backgroundOpacity * 100)}%`}
            onChange={value => updateStyle('backgroundOpacity', value / 100)} />
          {selected === 'soft' && <StyleSlider label="Blur" min={MIN_SUBTITLE_BACKGROUND_BLUR_PERCENT} max={100} step={5} value={style.backgroundBlurPercent} displayValue={`${Math.round(style.backgroundBlurPercent)}%`}
            onChange={value => updateStyle('backgroundBlurPercent', value)} />}
        </>}
        {!style.backgroundEnabled && <StyleSlider label="Outline" min={0} max={10} value={style.borderEnabled ? style.borderWidth : 0} displayValue={`${Math.round((style.borderEnabled ? style.borderWidth : 0) * 10)}%`}
          onChange={value => updateStyle('borderWidth', value)} />}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2">
          {([
            ['fontColor', 'Text'], ['borderColor', 'Outline'], ['backgroundColor', 'Box'],
          ] as const).filter(([key]) => key !== 'borderColor' || !style.backgroundEnabled).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5 text-[11px] text-white/70">
              <input type="color" disabled={key === 'backgroundColor' && !style.backgroundEnabled}
                value={/^#[0-9a-f]{6}$/i.test(style[key]) ? style[key] : '#000000'}
                onChange={event => updateStyle(key, event.target.value)}
                className="h-7 w-7 cursor-pointer rounded-md border border-white/20 bg-white/10 p-0.5 disabled:cursor-default disabled:opacity-40" />
              {label}
            </label>
          ))}
        </div>
      </details>
    </section>
  );
}
