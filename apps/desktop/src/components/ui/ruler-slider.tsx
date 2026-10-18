import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { Undo2 } from 'lucide-react';
import { fillSliderGeometry } from './fillSliderGeometry';
import { RULER_TICK_COUNT, snapToMark } from './rulerSliderMarks';

type RulerSliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'min' | 'max' | 'step' | 'onChange' | 'defaultValue'> & {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onValueChange: (value: number) => void;
  /** Shown in the header; also the screen reader value unless aria-valuetext is set. */
  format: (value: number) => string;
  /** The value Reset and double-click return to. The value turns accent while it differs. */
  defaultValue?: number;
  /** Values drawn as notches on the track; a drag near one snaps to it. */
  marks?: number[];
  /** "app" follows the theme surfaces; "media" is for panels over video. */
  tone?: 'app' | 'media';
  /** False drops the label and value row, for tight spots like the control bar. */
  showHeader?: boolean;
};

const TONES = {
  app: { label: 'text-[var(--loom-muted)]', value: 'text-[var(--loom-text)]', track: 'bg-[color-mix(in_oklab,var(--loom-text)_16%,transparent)]', tick: 'bg-[var(--loom-muted)]', reset: 'bg-[color-mix(in_oklab,var(--loom-text)_10%,transparent)] text-[var(--loom-text)] hover:bg-[color-mix(in_oklab,var(--loom-text)_16%,transparent)]' },
  media: { label: 'text-white/65', value: 'text-white', track: 'bg-white/[0.16]', tick: 'bg-white/35', reset: 'bg-white/10 text-white hover:bg-white/[0.16]' },
} as const;

const TICKS = Array.from({ length: RULER_TICK_COUNT + 1 }, (_, index) => index);

/**
 * A labeled slider: header with the value, a 10px track that fills from zero
 * (or the left edge), and tick guides under the track.
 * A transparent native range input covers the track, so drag, click, arrow
 * keys and screen readers all work. The ruler shows only while dragging or
 * stepping with the keyboard. Pointer drags snap to notches;
 * keyboard steps never do, so arrows can always move past one.
 */
export function RulerSlider({
  label,
  value,
  min,
  max,
  step,
  onValueChange,
  format,
  defaultValue,
  marks = [],
  tone = 'media',
  showHeader = true,
  className = '',
  onPointerDown,
  onPointerUp,
  ...inputProps
}: RulerSliderProps) {
  const pointerActive = useRef(false);
  const [sliding, setSliding] = useState(false);
  useEffect(() => {
    if (!sliding) return undefined;
    // The pointer can be released outside the track, so listen on the window.
    const stop = () => { pointerActive.current = false; setSliding(false); };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [sliding]);
  const { valuePct, fillLeft, fillWidth } = fillSliderGeometry(value, min, max);
  const colors = TONES[tone];
  const changed = defaultValue !== undefined && Math.abs(value - defaultValue) > step / 2;
  const toPct = (input: number) => fillSliderGeometry(input, min, max).valuePct;
  const notches = marks.length > 0 ? marks : defaultValue !== undefined ? [defaultValue] : [];
  const reset = () => { if (defaultValue !== undefined) onValueChange(defaultValue); };

  return (
    <div className={`group/ruler grid gap-2 ${className}`}>
      {showHeader && (
      <div className="flex h-6 items-center justify-between gap-3 text-sm">
        <span className={colors.label}>{label}</span>
        <span className="flex items-center gap-2">
          <span className={`tabular-nums ${changed ? 'text-[var(--loom-accent)]' : colors.value}`}>{format(value)}</span>
          {changed && (
            <button
              type="button"
              onClick={reset}
              aria-label={`Reset ${label.toLowerCase()}`}
              title="Reset"
              className={`grid h-6 w-6 place-items-center rounded-[6px] transition-colors ${colors.reset} outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]`}
            >
              <Undo2 className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          )}
        </span>
      </div>
      )}
      <div
        className="group relative h-6 rounded-full"
        onDoubleClick={reset}
      >
        <div aria-hidden="true" className={`absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full ${colors.track}`} />
        <div
          aria-hidden="true"
          className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-[var(--loom-accent)]"
          style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
        />
        {notches.map((notch) => (
          <div
            key={notch}
            aria-hidden="true"
            className="absolute top-1/2 h-1.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current opacity-50"
            style={{ left: `${toPct(notch)}%` }}
          />
        ))}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 h-4 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.5)] transition-transform group-active:scale-110"
          style={{ left: `${valuePct}%` }}
        />
        <div
          aria-hidden="true"
          data-ruler-guides=""
          className={`pointer-events-none absolute inset-x-1.5 top-full -mt-0.5 h-[5px] transition-opacity duration-150 ${sliding ? 'opacity-100' : 'opacity-0 group-has-[:focus-visible]/ruler:opacity-100'}`}
        >
          {TICKS.map((index) => (
            <div
              key={index}
              className={`absolute top-0 w-px ${colors.tick} ${index % 5 === 0 ? 'h-[5px]' : 'h-[3px] opacity-60'}`}
              style={{ left: `${(index / RULER_TICK_COUNT) * 100}%` }}
            />
          ))}
        </div>
        <input
          {...inputProps}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={inputProps['aria-label'] ?? label}
          aria-valuetext={inputProps['aria-valuetext'] ?? format(value)}
          onPointerDown={(event) => { pointerActive.current = true; setSliding(true); onPointerDown?.(event); }}
          onPointerUp={(event) => { pointerActive.current = false; onPointerUp?.(event); }}
          onChange={(event) => {
            const next = Number(event.target.value);
            onValueChange(pointerActive.current ? snapToMark(next, notches, min, max) : next);
          }}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 [&::-moz-range-thumb]:h-full [&::-moz-range-thumb]:w-px [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:h-full [&::-webkit-slider-thumb]:w-px [&::-webkit-slider-thumb]:appearance-none"
        />
      </div>
    </div>
  );
}
