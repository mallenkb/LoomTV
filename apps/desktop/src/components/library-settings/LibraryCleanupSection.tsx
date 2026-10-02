import { useCallback, useEffect, useState } from 'react';
import { Sparkles, Undo2 } from 'lucide-react';
import { CaretDown } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { desktopApi } from '@/lib/desktopApi';
import type { LibraryCleanupBatch } from '@/shared/desktopProtocol';

type CleanupMode = 'auto' | 'off';

const MODE_OPTIONS: { value: CleanupMode; label: string }[] = [
  { value: 'auto', label: 'Automatically' },
  { value: 'off', label: 'Off' },
];

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function dateLabel(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Settings for the automatic cleanup that clears leftover download files and
 * redundant subtitles on each sync and launch, with the recent cleanups and
 * a way to put any of them back.
 */
export default function LibraryCleanupSection({ disabled }: { disabled: boolean }) {
  const [mode, setMode] = useState<CleanupMode>('auto');
  const [batches, setBatches] = useState<LibraryCleanupBatch[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [settings, history] = await Promise.all([desktopApi.getSettings(), desktopApi.libraryCleanupHistory()]);
      setMode(settings.cleanUpLibraryFiles === 'off' ? 'off' : 'auto');
      setBatches(history);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const changeMode = async (next: CleanupMode) => {
    setMode(next);
    setError('');
    try {
      await desktopApi.saveSettings({ cleanUpLibraryFiles: next });
    } catch (cause) {
      setError(errorMessage(cause));
      void load();
    }
  };

  const restore = async (batch: LibraryCleanupBatch) => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await desktopApi.restoreLibraryCleanup(batch.id);
      setStatus(result.skipped
        ? `Put back ${result.restored.toLocaleString()} ${result.restored === 1 ? 'file' : 'files'}. ${result.skipped.toLocaleString()} could not be put back because something else is in their place.`
        : `Put back ${result.restored.toLocaleString()} ${result.restored === 1 ? 'file' : 'files'}. Cleanup will leave them alone from now on.`);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const latest = batches.find((batch) => !batch.restoredAt);

  return (
    <div className="space-y-3 rounded-lg bg-[var(--loom-surface-2)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[var(--loom-accent)]" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-white">Clean up library folders</p>
            <p className="mt-0.5 text-xs text-[var(--loom-muted)]">
              On each sync and launch, removes text and link files left by downloads, images that are not artwork, and subtitle files that copy a track already built into the video. Videos, other subtitles and artwork are never touched. Removed files can be put back for 30 days, and anything put back is left alone after that.
            </p>
          </div>
        </div>
        <span className="relative block w-40 shrink-0">
          <select value={mode} onChange={(event) => void changeMode(event.target.value as CleanupMode)} disabled={busy} aria-label="Clean up library folders" className="h-10 w-full appearance-none rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] py-2 pl-4 pr-10 text-sm text-[var(--loom-text)] outline-none focus:border-[var(--loom-accent)]">
            {MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <CaretDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)]" weight="regular" aria-hidden="true" />
        </span>
      </div>
      <p className="border-t border-[var(--loom-control-border)] pt-3 text-sm text-[var(--loom-text)]" role="status">
        {latest
          ? `Last cleanup ${dateLabel(latest.createdAt)}: ${latest.items.length.toLocaleString()} ${latest.items.length === 1 ? 'file' : 'files'} removed.`
          : 'Nothing has been cleaned up yet.'}
      </p>
      {batches.length ? (
        <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
          {batches.map((batch) => (
            <div key={batch.id} className="rounded-lg bg-[var(--loom-bg)] p-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[var(--loom-text)]">
                  {dateLabel(batch.createdAt)} · {batch.items.length.toLocaleString()} {batch.items.length === 1 ? 'file' : 'files'}
                  <span className="text-[var(--loom-muted)]">{batch.restoredAt ? ' · put back' : ` · kept until ${dateLabel(batch.expiresAt)}`}</span>
                </p>
                <span className="flex shrink-0 items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setOpen(open === batch.id ? null : batch.id)}>
                    {open === batch.id ? 'Hide files' : 'Show files'}
                  </Button>
                  {!batch.restoredAt ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => void restore(batch)} disabled={disabled || busy} className="gap-1.5">
                      <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Put back
                    </Button>
                  ) : null}
                </span>
              </div>
              {open === batch.id ? (
                <ul className="mt-2 space-y-1">
                  {batch.items.map((item) => (
                    <li key={`${item.folder}/${item.name}`} className="min-w-0">
                      <span className="block break-all text-[var(--loom-text)]">{item.name}</span>
                      <span className="block break-all text-[var(--loom-faint)]">{item.reason} · {item.folder}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {status ? <p className="text-xs text-[var(--loom-muted)]">{status}</p> : null}
      {error ? <p role="alert" className="text-xs text-red-200">{error}</p> : null}
    </div>
  );
}
