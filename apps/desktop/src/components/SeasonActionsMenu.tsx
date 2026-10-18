import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, ScanSearch } from 'lucide-react';
import { useToast } from '@/components/ToastProvider';
import { desktopApi } from '@/lib/desktopApi';

type SeasonActionsMenuProps = {
  showId: string;
  season: number;
  seasonTitle: string;
};

/**
 * The ⋯ menu on a season row. Rescans start a full intro and credits
 * analysis in the background, for this season or the whole show; progress
 * shows in Settings > Playback > Skip analysis.
 */
export default function SeasonActionsMenu({ showId, season, seasonTitle }: SeasonActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const rescan = async (wholeShow: boolean) => {
    setOpen(false);
    setBusy(true);
    try {
      const status = await desktopApi.getLocalSegmentAnalysisStatus();
      if (!status.enabled || !status.available) {
        showToast({ title: 'Intro detection is off', description: status.message || 'Turn it on in Settings > Playback > Skip analysis.', tone: 'error' });
        return;
      }
      const { queued } = await desktopApi.runLocalSegmentAnalysis(
        wholeShow ? { mediaId: showId, mode: 'full' } : { mediaId: showId, season, mode: 'full' },
      );
      const scope = wholeShow ? 'this show' : seasonTitle;
      showToast(queued > 0
        ? { title: `Rescanning ${queued} ${queued === 1 ? 'episode' : 'episodes'}`, description: `Intro and credits for ${scope}. Progress is in Settings > Playback > Skip analysis.`, tone: 'success' }
        : { title: 'Nothing to rescan', description: `No local files were found for ${scope}.`, tone: 'info' });
    } catch (error) {
      showToast({ title: 'Rescan failed', description: error instanceof Error ? error.message : 'Try again from Settings > Playback > Skip analysis.', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const itemClass = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]';

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-label={`${seasonTitle} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        className="grid h-7 w-7 place-items-center rounded-full text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-control-veil)] hover:text-[var(--loom-text)] disabled:cursor-wait disabled:opacity-60"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`${seasonTitle} actions`}
          className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-[var(--loom-control-border)] bg-[var(--loom-panel)] p-1 text-[var(--loom-text)] shadow-[0_20px_60px_rgba(0,0,0,0.62)] backdrop-blur-xl"
        >
          <button type="button" role="menuitem" onClick={() => void rescan(false)} className={itemClass}>
            <ScanSearch className="h-4 w-4" aria-hidden="true" />
            Rescan intro and credits
          </button>
          <button type="button" role="menuitem" onClick={() => void rescan(true)} className={itemClass}>
            <ScanSearch className="h-4 w-4" aria-hidden="true" />
            Rescan the whole show
          </button>
        </div>
      )}
    </div>
  );
}
