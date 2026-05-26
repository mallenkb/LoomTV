import { CheckCircle, Star, X } from 'lucide-react';
import { isWatched, progressFraction } from '@/lib/progress';
import { ScrollArea } from '../ui/scroll-area';
import { clampSidePanelWidth, epCode, isInProgress } from './helpers';
import type { EpisodeFile, EpisodeMeta } from './types';

interface PlayerEpisodePanelProps {
  episodePanelWidth: number;
  setEpisodePanelWidth: React.Dispatch<React.SetStateAction<number>>;
  startSidePanelResize: (
    event: React.MouseEvent<HTMLDivElement>,
    currentWidth: number,
    setWidth: React.Dispatch<React.SetStateAction<number>>,
  ) => void;
  title: string;
  onClose: () => void;
  tick: number;
  sortedSeasons: number[];
  groupedEpisodes: Record<number, EpisodeMeta[]>;
  episodeFiles: EpisodeFile[];
  currentSeason: number;
  currentEpisode: number;
  duration: number;
  position: number;
  displayEpisodeTitle: (season: number, episode: number, rawTitle?: string, filePath?: string) => string;
  goToEpisode: (season: number, episode: number) => void;
}

export default function PlayerEpisodePanel({
  episodePanelWidth,
  setEpisodePanelWidth,
  startSidePanelResize,
  title,
  onClose,
  tick,
  sortedSeasons,
  groupedEpisodes,
  episodeFiles,
  currentSeason,
  currentEpisode,
  duration,
  position,
  displayEpisodeTitle,
  goToEpisode,
}: PlayerEpisodePanelProps) {
  return (
    <aside
      className="loom-no-drag player-side-panel absolute inset-y-0 right-0 z-50 flex flex-col border-l border-white/10 bg-[#111] shadow-2xl"
      style={{ width: clampSidePanelWidth(episodePanelWidth), maxWidth: '40vw' }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div
        className="absolute left-0 top-0 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize items-center justify-center group"
        onMouseDown={(event) => startSidePanelResize(event, episodePanelWidth, setEpisodePanelWidth)}
        title="Drag to resize"
      >
        <span className="h-12 w-1 rounded-full bg-white/10 transition-colors group-hover:bg-[var(--loom-accent)]/70" />
      </div>
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <p className="text-sm font-semibold text-white truncate">{title}</p>
        <button
          onClick={onClose}
          className="text-[var(--loom-muted)] hover:text-white ml-2 shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <ScrollArea className="flex-1">
        {tick >= 0 && sortedSeasons.map((season) => (
          <div key={season}>
            <p className="sticky top-0 z-10 bg-[#111] px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[var(--loom-accent)]">
              Season {season}
            </p>
            {(groupedEpisodes[season] || []).map((ep) => {
              const file = episodeFiles.find((item) => item.season === ep.season && item.episode === ep.number);
              const isCurrent = ep.season === currentSeason && ep.number === currentEpisode;
              const epPath = file?.filePath;
              const epDur = isCurrent ? duration : file?.localMetadata?.durationSeconds;
              const episodeTitle = displayEpisodeTitle(ep.season, ep.number, ep.title, epPath);
              const watched = epPath ? isWatched(epPath, epDur) : false;
              const inProgress = epPath ? isInProgress(epPath, epDur) : false;
              const episodeRating = Number.isFinite(ep.rating) && ep.rating > 0 ? ep.rating : 0;
              const progFrac = isCurrent && duration > 0
                ? position / duration
                : epPath
                  ? progressFraction(epPath, epDur)
                  : 0;

              return (
                <button
                  key={`${ep.season}-${ep.number}`}
                  disabled={!file}
                  onClick={() => file && goToEpisode(ep.season, ep.number)}
                  className={`relative w-full flex items-center gap-2 px-4 py-2.5 text-left transition-colors
                    ${isCurrent ? 'bg-[var(--loom-accent)]/15' : 'hover:bg-white/5'}
                    ${!file ? 'cursor-not-allowed opacity-30' : ''}`}
                >
                  {(inProgress || isCurrent) && progFrac > 0 && (
                    <span
                      className={`pointer-events-none absolute bottom-0 left-0 h-0.5 ${isCurrent ? 'bg-[var(--loom-accent)]' : 'bg-amber-400'}`}
                      style={{ width: `${Math.min(100, progFrac * 100)}%` }}
                    />
                  )}
                  <span className={`w-12 shrink-0 font-mono text-[10px] ${isCurrent ? 'text-[var(--loom-accent)]' : 'text-[var(--loom-muted)]'}`}>
                    {epCode(ep.season, ep.number)}
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-xs leading-snug ${isCurrent ? 'font-medium text-[var(--loom-accent)]' : 'text-white'}`}>
                    {episodeTitle}
                  </span>
                  {episodeRating > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#f5c451]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#f5c451]">
                      <Star className="h-2.5 w-2.5 fill-current" />
                      {episodeRating.toFixed(1)}
                    </span>
                  )}
                  {watched && !isCurrent && <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />}
                  {inProgress && !isCurrent && <span className="shrink-0 text-[9px] text-amber-400">resume</span>}
                </button>
              );
            })}
          </div>
        ))}
      </ScrollArea>
    </aside>
  );
}
