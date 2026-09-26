import { ChevronLeft, ChevronRight, History } from 'lucide-react';

interface LiveChannelOverlayProps {
  name: string;
  index: number;
  total: number;
  /** Shown instead of a black screen when the channel will not play. */
  problem: string | null;
  showBar: boolean;
  canStep: boolean;
  canGoBack: boolean;
  onStep: (step: number) => void;
  onLast: () => void;
  onClose: () => void;
}

const barButton = 'grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40';

/** Channel name, position, and channel switching for a live stream. */
export default function LiveChannelOverlay({
  name, index, total, problem, showBar, canStep, canGoBack, onStep, onLast, onClose,
}: LiveChannelOverlayProps) {
  return (
    <>
      {showBar || problem ? (
        <div
          className="pointer-events-auto absolute left-1/2 top-20 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-black/70 px-3 py-2 text-white shadow-lg"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <button type="button" className={barButton} onClick={() => onStep(-1)} disabled={!canStep} aria-label="Previous channel" title="Previous channel (Page Up)">
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="min-w-0 max-w-[40vw] px-1 text-center">
            <p className="truncate text-sm font-semibold">{name}</p>
            {index > 0 && total > 1 ? <p className="text-[11px] text-white/60">{index.toLocaleString()} of {total.toLocaleString()}</p> : null}
          </div>
          <button type="button" className={barButton} onClick={() => onStep(1)} disabled={!canStep} aria-label="Next channel" title="Next channel (Page Down)">
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          </button>
          <button type="button" className={barButton} onClick={onLast} disabled={!canGoBack} aria-label="Last channel" title="Last channel (Q)">
            <History className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {problem ? (
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
      ) : null}
    </>
  );
}
