import { SkipForward } from 'lucide-react';

interface NextEpisodePromptProps {
  controlsVisible: boolean;
  progress: number;
  playNextEpisodeNow: () => void;
}

export default function NextEpisodePrompt({
  controlsVisible,
  progress,
  playNextEpisodeNow,
}: NextEpisodePromptProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        playNextEpisodeNow();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      aria-label="Play next episode"
      className={`loom-player-next-episode pointer-events-auto absolute right-8 z-50 inline-flex h-14 w-fit max-w-[calc(100vw-2rem)] items-center gap-2.5 overflow-hidden rounded-lg bg-white px-8 text-black shadow-[0_8px_24px_rgba(0,0,0,0.36)] outline-none transition-[bottom] duration-300 ease-out focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black ${controlsVisible ? 'bottom-32' : 'bottom-16'}`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 bg-black/[0.18] transition-[width] duration-1000 ease-linear"
        style={{ width: `${progress}%` }}
      />
      <span className="relative shrink-0 whitespace-nowrap text-base font-bold">
        Next Episode
      </span>
      <span className="relative grid shrink-0 place-items-center">
        <SkipForward className="h-5 w-5" strokeWidth={2.4} fill="currentColor" aria-hidden="true" />
      </span>
    </button>
  );
}
