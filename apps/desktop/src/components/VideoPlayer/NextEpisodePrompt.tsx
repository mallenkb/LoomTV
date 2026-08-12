import { Play } from 'lucide-react';
import { NEXT_EPISODE_COUNTDOWN_SECONDS } from './constants';
import { epCode } from './helpers';
import type { EpisodeFile } from './types';

interface NextEpisodePromptProps {
  nextCountdown: number | null;
  nextEpisodeFile: EpisodeFile;
  nextEpLabel: string | null;
  autoplayNextEnabled: boolean;
  playNextEpisodeNow: () => void;
  clearNextEpisodeCountdown: () => void;
  onDismiss: () => void;
}

export default function NextEpisodePrompt({
  nextCountdown,
  nextEpisodeFile,
  nextEpLabel,
  autoplayNextEnabled,
  playNextEpisodeNow,
  clearNextEpisodeCountdown,
  onDismiss,
}: NextEpisodePromptProps) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-50 flex items-end justify-end p-6 pb-28"
    >
      <div
        className="loom-modal-surface pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-white/15 bg-black text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <div className="p-5">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--loom-accent)]">Up next</p>
              <p className="mt-1.5 truncate text-lg font-semibold leading-tight">
                {nextEpLabel || epCode(nextEpisodeFile.season, nextEpisodeFile.episode)}
              </p>
              <p className="mt-2 text-sm text-white/65">
                {nextCountdown !== null
                  ? 'Playing next in'
                  : autoplayNextEnabled ? 'Autoplay starts when this episode finishes.' : 'Ready when you are.'}
              </p>
            </div>
            {nextCountdown !== null && (
              <div className="relative shrink-0">
                <svg viewBox="0 0 44 44" className="h-20 w-20 -rotate-90">
                  <circle cx="22" cy="22" r="20" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="3" />
                  <circle
                    cx="22"
                    cy="22"
                    r="20"
                    fill="none"
                    stroke="var(--loom-accent)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 20}
                    strokeDashoffset={2 * Math.PI * 20 * (1 - Math.min(1, Math.max(0, nextCountdown / NEXT_EPISODE_COUNTDOWN_SECONDS)))}
                    style={{ transition: 'stroke-dashoffset 1s linear' }}
                  />
                </svg>
                <div className="pointer-events-none absolute inset-0 grid place-items-center">
                  <span className="font-semibold text-white tabular-nums leading-none text-[28px]">
                    {nextCountdown}
                  </span>
                </div>
              </div>
            )}
          </div>
          <div className="mt-5 flex gap-2.5">
            <button
              onClick={(event) => {
                event.stopPropagation();
                playNextEpisodeNow();
              }}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-white text-sm font-semibold text-black shadow-sm transition-colors hover:bg-white/90"
            >
              <Play className="h-4 w-4 fill-current" />
              Play now
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                if (nextCountdown !== null) {
                  clearNextEpisodeCountdown();
                } else {
                  onDismiss();
                }
              }}
              className="flex h-11 items-center justify-center rounded-lg border border-white/20 bg-black/40 px-5 text-sm font-semibold text-white/80 backdrop-blur-md transition-colors hover:border-white/30 hover:bg-white/10 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
        {nextCountdown !== null && (
          <div className="h-1 w-full bg-white/10">
            <div
              className="h-full bg-[var(--loom-accent)] transition-[width] duration-1000 ease-linear"
              style={{
                width: `${Math.min(100, Math.max(0, ((NEXT_EPISODE_COUNTDOWN_SECONDS - nextCountdown) / NEXT_EPISODE_COUNTDOWN_SECONDS) * 100))}%`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
