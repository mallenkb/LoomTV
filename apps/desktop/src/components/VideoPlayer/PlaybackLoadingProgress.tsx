import { useEffect, useRef, useState } from 'react';

export default function PlaybackLoadingProgress({ title, status, logoSources = [], progressPercent }: {
  title: string;
  status: string;
  logoSources?: string[];
  progressPercent?: number | null;
}) {
  const [logoIndex, setLogoIndex] = useState(0);
  const logoKey = logoSources.join('\n');
  useEffect(() => setLogoIndex(0), [logoKey]);
  const logo = logoSources[logoIndex];
  const percent = typeof progressPercent === 'number' && Number.isFinite(progressPercent)
    ? Math.min(100, Math.max(0, progressPercent)) : null;
  const [fillPercent, setFillPercent] = useState(percent ?? 0);
  const startedAt = useRef<number | null>(null);
  const receivedProgress = useRef(false);
  useEffect(() => {
    if (percent !== null) {
      receivedProgress.current = true;
      setFillPercent(previous => Math.max(previous, percent));
      return;
    }
    // Losing telemetry must not restart the same loading sequence.
    if (receivedProgress.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    startedAt.current ??= performance.now();
    const start = startedAt.current;
    const timer = window.setInterval(() => {
      // Unknown-duration preparation fills once, then waits below completion.
      // This is a visual estimate, never an announced measured percentage.
      const elapsed = performance.now() - start;
      setFillPercent(previous => Math.max(previous, Math.min(85, elapsed / 2400 * 85)));
      if (elapsed >= 2400) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [percent]);
  const fillClass = 'loom-player-title-fill absolute inset-0';
  const fillStyle = { clipPath: `inset(0 ${100 - fillPercent}% 0 0)` };
  return (
    <div role={percent === null ? 'status' : 'progressbar'} aria-label={`${title}: ${status}`} aria-live="polite"
      aria-valuemin={percent === null ? undefined : 0} aria-valuemax={percent === null ? undefined : 100}
      aria-valuenow={percent === null ? undefined : Math.round(percent)}
      className="relative max-w-[80%] text-3xl font-semibold tracking-tight">
      {logo ? <>
        <img src={logo} alt="" aria-hidden="true" className="block max-h-32 max-w-[min(28rem,70vw)] object-contain grayscale"
          onError={() => setLogoIndex(index => index + 1)} />
        <span aria-hidden="true" className={fillClass} style={fillStyle}>
          <img src={logo} alt="" className="h-full w-full object-contain" />
        </span>
      </> : <>
        <span aria-hidden="true" className="block text-white/30">{title}</span>
        <span aria-hidden="true" className={`${fillClass} text-white`} style={fillStyle}>{title}</span>
      </>}
    </div>
  );
}
