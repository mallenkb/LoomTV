import { useEffect, useRef, useState } from 'react';
import { Bookmark, Eye, MoreHorizontal, Play } from 'lucide-react';
import WatchedToggle from '@/components/WatchedToggle';
import { useToast } from '@/components/ToastProvider';
import {
  HERO_ACTION_DIVIDER_CLASS,
  HERO_ACTION_FIRST_SEGMENT_CLASS,
  HERO_ACTION_GROUP_CLASS,
  HERO_ACTION_MIDDLE_SEGMENT_CLASS,
  HERO_ACTION_SEGMENT_CLASS,
} from '@/components/heroActionStyles';

type DetailHeroActionsProps = {
  canBookmark: boolean;
  inMyList: boolean;
  watched: boolean;
  onPlayTrailer?: () => void;
  onToggleList: () => void;
  onToggleWatched: () => void;
};

export default function DetailHeroActions({
  canBookmark,
  inMyList,
  watched,
  onPlayTrailer,
  onToggleList,
  onToggleWatched,
}: DetailHeroActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (!menuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const toggleWatchedFromMenu = () => {
    const willBeWatched = !watched;
    setMenuOpen(false);
    onToggleWatched();
    showToast({
      title: willBeWatched ? 'Marked as watched' : 'Marked as unwatched',
      tone: willBeWatched ? 'success' : 'info',
      durationMs: 2800,
      variant: 'confirmation',
    });
  };

  return (
    <>
      <div className={`loom-detail-hero-actions ${HERO_ACTION_GROUP_CLASS}`}>
        {onPlayTrailer && (
          <>
            <button
              type="button"
              aria-label="Play trailer"
              onClick={onPlayTrailer}
              className={`flex h-14 items-center gap-2 px-5 text-sm font-semibold text-white ${HERO_ACTION_FIRST_SEGMENT_CLASS} ${HERO_ACTION_SEGMENT_CLASS}`}
            >
              <Play className="h-5 w-5 fill-current" />
              <span>Trailer</span>
            </button>
            <span className={HERO_ACTION_DIVIDER_CLASS} />
          </>
        )}
        {canBookmark && (
          <>
            <button
              type="button"
              aria-label={inMyList ? 'Remove from My List' : 'Add to My List'}
              aria-pressed={inMyList}
              onClick={onToggleList}
              className={`loom-detail-bookmark grid h-14 w-14 place-items-center text-white ${onPlayTrailer ? HERO_ACTION_MIDDLE_SEGMENT_CLASS : HERO_ACTION_FIRST_SEGMENT_CLASS} ${HERO_ACTION_SEGMENT_CLASS}`}
              title={inMyList ? 'Remove from My List' : 'Add to My List'}
            >
              <Bookmark className="h-5 w-5" fill={inMyList ? 'currentColor' : 'none'} />
            </button>
            <span className={HERO_ACTION_DIVIDER_CLASS} />
          </>
        )}
        <WatchedToggle
          watched={watched}
          onToggle={onToggleWatched}
          surface="plain"
          className={`loom-modern-hero-watched-toggle h-14 w-14 bg-transparent text-white ${HERO_ACTION_MIDDLE_SEGMENT_CLASS} ${HERO_ACTION_SEGMENT_CLASS}`}
          label={watched ? 'Mark as unwatched' : 'Mark as watched'}
        />
      </div>

      <div ref={menuRef} className="loom-detail-hero-actions-menu relative hidden shrink-0">
        <button
          type="button"
          aria-label="More title actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className="grid h-14 w-14 place-items-center rounded-full bg-white/10 text-white shadow-[0_16px_38px_rgba(0,0,0,0.28)] backdrop-blur-[12px] transition-colors hover:bg-black/40"
        >
          <MoreHorizontal className="h-6 w-6" />
        </button>

        {menuOpen && (
          <div
            role="menu"
            aria-label="Title actions"
            className="absolute bottom-full right-0 z-50 mb-2 w-56 overflow-hidden rounded-xl border border-[var(--loom-control-border)] bg-[var(--loom-panel)] p-1 text-[var(--loom-text)] shadow-[0_20px_60px_rgba(0,0,0,0.62)] backdrop-blur-xl"
          >
            {onPlayTrailer && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onPlayTrailer();
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
              >
                <Play className="h-4 w-4 fill-current" />
                Play trailer
              </button>
            )}
            {canBookmark && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onToggleList();
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
              >
                <Bookmark className="h-4 w-4" fill={inMyList ? 'currentColor' : 'none'} />
                {inMyList ? 'Remove from My List' : 'Add to My List'}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={toggleWatchedFromMenu}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
            >
              <Eye className="h-4 w-4" fill={watched ? 'currentColor' : 'none'} />
              {watched ? 'Mark as unwatched' : 'Mark as watched'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
