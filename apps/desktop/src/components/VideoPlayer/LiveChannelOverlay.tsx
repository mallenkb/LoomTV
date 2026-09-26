import type { IptvGuideProgramme } from '@/shared/desktopProtocol';
import { clockTime, minutesLeft } from '@/lib/useLiveGuide';

/** What's on now, beside "LIVE": times as text, since a live show can't be seeked. */
export function LiveNowPlaying({ now, next, at }: { now: IptvGuideProgramme | null; next: IptvGuideProgramme | null; at: number }) {
  if (!now && !next) return null;
  return (
    <p className="min-w-0 truncate text-sm text-white/70">
      {now ? (
        <>
          <span className="font-semibold text-white">{now.title}</span>
          <span className="tabular-nums"> · {clockTime(now.startMs)} – {clockTime(now.endMs)} · {minutesLeft(now, at)} min left</span>
        </>
      ) : null}
      {next ? <span className="tabular-nums">{now ? ' · ' : ''}Next: {next.title} at {clockTime(next.startMs)}</span> : null}
    </p>
  );
}

/** Shown instead of a black screen when a live channel will not play. */
export default function LiveProblemPanel({
  problem, canStep, onStep, onClose,
}: {
  problem: string;
  canStep: boolean;
  onStep: (step: number) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="alert"
      className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-black/80 px-6"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="max-w-md text-center">
        <p className="text-lg font-semibold text-white">This channel can't play right now</p>
        <p className="mt-2 text-sm text-white/75">{problem}</p>
        <div className="mt-6 flex justify-center gap-3">
          {canStep ? (
            <button type="button" autoFocus onClick={() => onStep(1)} className="rounded-lg bg-white px-5 py-2.5 text-sm font-bold text-black outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]">
              Next channel
            </button>
          ) : null}
          <button type="button" onClick={onClose} className="rounded-lg border border-white/30 px-5 py-2.5 text-sm text-white outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
