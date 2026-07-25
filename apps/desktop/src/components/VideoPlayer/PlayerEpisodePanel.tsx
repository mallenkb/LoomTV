import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Play, Star, X } from 'lucide-react';
import SafeArtwork from '../SafeArtwork';
import { WatchedSolidIcon } from '../LoomIcons';
import { desktopApi } from '@/lib/desktopApi';
import { isWatched, progressFraction } from '@/lib/progress';
import { ScrollArea } from '../ui/scroll-area';
import { clampSidePanelWidth, epCode, isInProgress } from './helpers';
import type { EpisodeFile, EpisodeMeta } from './types';
import { episodeFileKey, indexEpisodeFiles } from './episodeIndex';

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

function runtimeLabel(secs?: number): string {
  if (!secs || !Number.isFinite(secs) || secs <= 0) return '';
  const totalMinutes = Math.max(1, Math.round(secs / 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function seasonCode(season: number): string {
  return `S${String(Math.max(0, season)).padStart(2, '0')}`;
}

function EpisodeThumbnail({
  code,
  episode,
  file,
  title,
  isCurrent,
}: {
  code: string;
  episode: EpisodeMeta;
  file?: EpisodeFile;
  title: string;
  isCurrent: boolean;
}) {
  const [generatedThumbnail, setGeneratedThumbnail] = useState('');
  const filePath = file?.filePath || '';
  const existingThumbnail = episode.still || file?.still || file?.thumbnail || '';

  useEffect(() => {
    let cancelled = false;
    setGeneratedThumbnail('');

    if (!filePath || existingThumbnail) return () => {
      cancelled = true;
    };

    void desktopApi.getThumbnail(filePath, '00:03:00')
      .then(({ url }) => {
        if (!cancelled) setGeneratedThumbnail(url);
      })
      .catch(() => {
        if (!cancelled) setGeneratedThumbnail('');
      });

    return () => {
      cancelled = true;
    };
  }, [existingThumbnail, filePath]);

  const sources = useMemo(() => [
    episode.still,
    file?.still,
    file?.thumbnail,
    generatedThumbnail,
  ].filter(Boolean) as string[], [episode.still, file?.still, file?.thumbnail, generatedThumbnail]);

  return (
    <SafeArtwork
      src={sources}
      alt={`${title} thumbnail`}
      className={`aspect-video w-full rounded-lg border ${isCurrent ? 'border-[var(--loom-accent)]/60' : 'border-white/10'}`}
      imgClassName="object-cover"
      fallback={(
        <div className="absolute inset-0 grid place-items-center bg-white/[0.03]">
          <span className="font-mono text-[10px] font-medium text-[var(--loom-muted)]">{code}</span>
        </div>
      )}
    />
  );
}

interface PlayerEpisodeRowProps {
  episode: EpisodeMeta;
  file?: EpisodeFile;
  isCurrent: boolean;
  currentDuration?: number;
  currentPosition?: number;
  progressRevision: number;
  displayEpisodeTitle: PlayerEpisodePanelProps['displayEpisodeTitle'];
  goToEpisode: PlayerEpisodePanelProps['goToEpisode'];
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

const PlayerEpisodeRow = memo(function PlayerEpisodeRow({
  episode,
  file,
  isCurrent,
  currentDuration,
  currentPosition,
  progressRevision,
  displayEpisodeTitle,
  goToEpisode,
  buttonRef,
}: PlayerEpisodeRowProps) {
  const epPath = file?.filePath;
  const epDur = isCurrent ? currentDuration : file?.localMetadata?.durationSeconds;
  const episodeTitle = displayEpisodeTitle(episode.season, episode.number, episode.title, epPath);
  const watched = epPath ? isWatched(epPath, epDur) : false;
  const inProgress = epPath ? isInProgress(epPath, epDur) : false;
  const episodeRating = Number.isFinite(episode.rating) && episode.rating > 0 ? episode.rating : 0;
  const code = epCode(episode.season, episode.number);
  const runtime = runtimeLabel(epDur);
  const progFrac = isCurrent && currentDuration && currentDuration > 0
    ? (currentPosition || 0) / currentDuration
    : epPath
      ? progressFraction(epPath, epDur)
      : 0;
  void progressRevision;

  return (
    <button
      ref={buttonRef}
      disabled={!file}
      onClick={() => file && goToEpisode(episode.season, episode.number)}
      className={`group relative flex w-full items-start gap-3.5 px-5 py-3 text-left transition-colors
        ${isCurrent ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}
        ${!file ? 'cursor-not-allowed opacity-30' : ''}`}
    >
      {isCurrent && (
        <span className="pointer-events-none absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-[var(--loom-accent)]" />
      )}

      <span className="relative block w-32 shrink-0 overflow-hidden rounded-lg">
        <EpisodeThumbnail
          code={code}
          episode={episode}
          file={file}
          title={episodeTitle}
          isCurrent={isCurrent}
        />
        {file && !isCurrent && (
          <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-white/95 shadow-lg">
              <Play className="ml-0.5 h-3.5 w-3.5 fill-black text-black" />
            </span>
          </span>
        )}
        {watched && !isCurrent && (
          <WatchedSolidIcon
            role="img"
            aria-label="Watched"
            className="absolute right-1.5 top-1.5 h-6 w-6 text-emerald-500 drop-shadow-[0_2px_6px_rgba(0,0,0,0.65)]"
          />
        )}
        {runtime && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1 py-0.5 text-[9px] font-medium leading-none text-white/90">
            {runtime}
          </span>
        )}
        {(inProgress || isCurrent) && progFrac > 0 && (
          <span className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-b-lg bg-white/20">
            <span
              className="block h-full bg-[var(--loom-accent)]"
              style={{ width: `${Math.min(100, progFrac * 100)}%` }}
            />
          </span>
        )}
      </span>

      <span className="min-w-0 flex-1 pt-0.5">
        <span className="flex items-center justify-between gap-2">
          <span className={`truncate text-[13px] font-medium ${isCurrent ? 'text-[var(--loom-accent)]' : 'text-white'}`}>
            {episode.number}. {episodeTitle}
          </span>
          {episodeRating > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-[var(--loom-rating)]">
              <Star className="h-2.5 w-2.5 fill-current" />
              {episodeRating.toFixed(1)}
            </span>
          )}
        </span>
        {episode.summary ? (
          <span className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--loom-muted)]">
            {episode.summary}
          </span>
        ) : (
          <span className="mt-1 block font-mono text-[10px] text-[var(--loom-muted)]/70">
            {code}
          </span>
        )}
      </span>
    </button>
  );
});

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
  const hasMultipleSeasons = sortedSeasons.length > 1;
  const defaultSeason = sortedSeasons.includes(currentSeason)
    ? currentSeason
    : sortedSeasons[0] ?? currentSeason;
  // Season currently in view in the scroll list; drives the tab highlight.
  const [activeSeason, setActiveSeason] = useState(defaultSeason);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const tabRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const currentEpisodeRef = useRef<HTMLButtonElement | null>(null);
  const totalEpisodeCount = sortedSeasons.reduce(
    (count, season) => count + (groupedEpisodes[season] || []).length,
    0,
  );
  const episodeFileByCode = useMemo(() => indexEpisodeFiles(episodeFiles), [episodeFiles]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // The section whose top has crossed the viewport top (offset by the
    // sticky header height) is the one the user is looking at.
    const threshold = viewport.scrollTop + 48;
    let inView = sortedSeasons[0] ?? defaultSeason;
    for (const season of sortedSeasons) {
      const section = sectionRefs.current[season];
      if (section && section.offsetTop <= threshold) inView = season;
    }
    setActiveSeason(inView);
  }, [defaultSeason, sortedSeasons]);

  const jumpToSeason = useCallback((season: number) => {
    const viewport = viewportRef.current;
    const section = sectionRefs.current[season];
    if (!viewport || !section) return;
    setActiveSeason(season);
    viewport.scrollTo({ top: section.offsetTop, behavior: 'smooth' });
  }, []);

  // Keep the active season tab visible as the list scrolls past seasons.
  useEffect(() => {
    tabRefs.current[activeSeason]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeSeason]);

  // On open, bring the currently playing episode into view.
  useEffect(() => {
    const viewport = viewportRef.current;
    const target = currentEpisodeRef.current;
    if (!viewport || !target) return;
    viewport.scrollTop = Math.max(0, target.offsetTop - viewport.clientHeight / 2 + target.clientHeight / 2);
    handleScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <aside
      className="loom-no-drag player-side-panel absolute inset-y-0 right-0 z-50 flex flex-col bg-neutral-950 shadow-2xl"
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

      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold tracking-tight text-white">{title}</p>
          <p className="mt-0.5 text-[11px] text-[var(--loom-muted)]">
            {hasMultipleSeasons ? `${sortedSeasons.length} seasons · ` : ''}{totalEpisodeCount} episodes
          </p>
        </div>
        <button
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--loom-muted)] transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Close episode panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {hasMultipleSeasons && (
        <div className="border-b border-white/[0.07] px-4 pb-3">
          <div
            aria-label="Jump to season"
            className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
          >
            {sortedSeasons.map((season) => {
              const isActive = season === activeSeason;
              const isCurrentSeason = season === currentSeason;
              const seasonEpisodeCount = (groupedEpisodes[season] || []).length;

              return (
                <button
                  key={season}
                  type="button"
                  ref={(node) => {
                    tabRefs.current[season] = node;
                  }}
                  onClick={() => jumpToSeason(season)}
                  title={isCurrentSeason ? `${seasonCode(season)} · now playing` : undefined}
                  aria-pressed={isActive}
                  className={`flex shrink-0 items-center gap-2 rounded-full border py-1.5 pl-3 pr-2 text-[11px] font-semibold tracking-tight transition-colors duration-150
                    ${isActive
                      ? 'border-[var(--loom-accent)]/70 bg-[var(--loom-accent)]/15 text-[var(--loom-accent)]'
                      : 'border-white/10 bg-white/[0.03] text-white/70 hover:border-white/25 hover:bg-white/[0.06] hover:text-white'}
                  `}
                >
                  {isCurrentSeason && (
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.20)]"
                    />
                  )}
                  <span>{seasonCode(season)}</span>
                  <span
                    className={`inline-flex min-w-[19px] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] leading-none tabular-nums
                      ${isActive ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'bg-white/10 text-white/55'}`}
                  >
                    {seasonEpisodeCount}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <ScrollArea className="flex-1" ref={viewportRef} onScroll={handleScroll}>
        {tick >= 0 && sortedSeasons.map((season) => (
          <div
            key={season}
            ref={(node) => {
              sectionRefs.current[season] = node;
            }}
          >
            <div className="sticky top-0 z-10 flex items-baseline justify-between border-b border-white/[0.07] bg-neutral-950/90 px-5 py-2.5 backdrop-blur-md">
              <span className="flex items-center gap-2 text-xs font-semibold text-white">
                {seasonCode(season)}
                {season === currentSeason && (
                  <span className="rounded-full bg-[var(--loom-accent)]/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--loom-accent)]">
                    Now playing
                  </span>
                )}
              </span>
              <span className="text-[10px] font-medium text-[var(--loom-muted)]">
                {(groupedEpisodes[season] || []).length} episodes
              </span>
            </div>
            {(groupedEpisodes[season] || []).map((ep) => {
              const file = episodeFileByCode.get(episodeFileKey(ep.season, ep.number));
              const isCurrent = ep.season === currentSeason && ep.number === currentEpisode;
              return (
                <PlayerEpisodeRow
                  key={`${ep.season}-${ep.number}`}
                  episode={ep}
                  file={file}
                  isCurrent={isCurrent}
                  currentDuration={isCurrent ? duration : undefined}
                  currentPosition={isCurrent ? position : undefined}
                  progressRevision={tick}
                  displayEpisodeTitle={displayEpisodeTitle}
                  goToEpisode={goToEpisode}
                  buttonRef={isCurrent ? currentEpisodeRef : undefined}
                />
              );
            })}
          </div>
        ))}
      </ScrollArea>
    </aside>
  );
}
