import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SettingsDisclosure, SettingsNote } from '@/components/settings/SettingsLayout';
import { SettingsDialog, SettingsDialogMessage } from '@/components/settings/SettingsDialog';
import { useLibrary } from '@/contexts/LibraryContext';
import { desktopApi } from '@/lib/desktopApi';
import type { LibraryImportSummary, LibraryOriginalPreview, MediaRenamePreview } from '@/shared/desktopProtocol';

export default function OriginalImportsSection({ disabled }: { disabled: boolean }) {
  const { refreshLibrary } = useLibrary();
  const [records, setRecords] = useState<LibraryImportSummary[]>([]);
  const [preview, setPreview] = useState<LibraryOriginalPreview | null>(null);
  const [renamePreview, setRenamePreview] = useState<MediaRenamePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [hasOlder, setHasOlder] = useState(false);
  const [shown, setShown] = useState(50);
  const [deleted, setDeleted] = useState(false);
  const load = useCallback(async (offset = 0) => {
    const next = await desktopApi.listLibraryImports(offset);
    setRecords((current) => offset ? [...current, ...next] : next);
    setHasOlder(next.length === 20);
  }, []);
  useEffect(() => {
    if (!disabled) void load().catch((cause) => setError(String(cause)));
  }, [disabled, load]);
  useEffect(() => desktopApi.onLibraryFilesOrganized(() => { void load().catch((cause) => setError(String(cause))); }), [load]);

  const inspect = async (id: string) => {
    setBusy(true);
    setError('');
    setRenamePreview(null);
    try { setPreview(await desktopApi.previewLibraryOriginal(id)); setShown(50); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!preview || preview.removedAt) return;
    setBusy(true);
    setError('');
    setRenamePreview(null);
    try {
      const result = await desktopApi.restoreLibraryOriginal(preview.importId);
      setStatus(result.complete ? 'The original names and available contents are restored.' : 'Restoration is incomplete. Missing or blocked files remain listed, and held files are kept for retry.');
      setPreview(await desktopApi.previewLibraryOriginal(preview.importId));
      await Promise.all([load(), refreshLibrary()]);
      if (result.issues.length) setError(result.issues.map((issue) => `${issue.path}: ${issue.reason}`).join('\n'));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };

  const previewRename = async () => {
    if (!preview || preview.removedAt) return;
    setBusy(true);
    setError('');
    try { setRenamePreview(await desktopApi.previewMediaRenames(preview.importId)); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const applyRename = async () => {
    if (!preview || !renamePreview?.entries.length) return;
    setBusy(true);
    setError('');
    try {
      const result = await desktopApi.applyMediaRenames(renamePreview.entries.map((entry) => entry.id), preview.importId);
      setStatus(`Renamed ${result.renamed} video${result.renamed === 1 ? '' : 's'} using metadata. The first recorded names are still available to restore.`);
      setRenamePreview(null);
      setPreview(await desktopApi.previewLibraryOriginal(preview.importId));
      await Promise.all([load(), refreshLibrary()]);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };

  return (
    <>
      {records.length ? (
      <SettingsDisclosure
        title="Original file names"
        description="Restore the names and locations files had when LoomTV first saw them."
        summary={records.filter((record) => !record.removedAt).length}
      >
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap items-center gap-1">
            <div role="radiogroup" aria-label="Records to show" className="settings-segmented inline-flex rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] p-0.5">
              {([false, true] as const).map((value) => (
                <button key={String(value)} type="button" role="radio" aria-checked={deleted === value} onClick={() => setDeleted(value)} className={`h-[30px] rounded-md px-2.5 text-xs font-medium transition-colors ${deleted === value ? 'bg-[var(--loom-active-bg)] text-[var(--loom-active-text)]' : 'text-[var(--loom-muted)] hover:text-[var(--loom-text)]'}`}>
                  {value ? 'Deleted' : 'Available'}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" disabled={busy || disabled} onClick={() => { void load().catch((cause) => setError(String(cause))); }}>Refresh</Button>
          </div>
          <div className="max-h-[40vh] divide-y divide-[var(--loom-settings-divider)] overflow-y-auto">
            {records.filter((record) => Boolean(record.removedAt) === deleted).map((record) => (
              <div key={record.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs">
                <div className="min-w-0">
                  <p className="text-[var(--loom-text)]">{record.title}</p>
                  <p className="text-[var(--loom-muted)]">
                    {new Date(record.createdAt).toLocaleString()} · {record.entryCount} {record.entryCount === 1 ? 'file' : 'files'}
                    {record.removedAt ? ` · removed ${new Date(record.removedAt).toLocaleString()}` : record.restoredAt ? ' · restored' : record.restoreRequestedAt ? ' · restore needs review' : ''}
                  </p>
                </div>
                <Button variant="outline" size="sm" disabled={busy || disabled} onClick={() => void inspect(record.id)}>{record.removedAt ? 'View history' : 'Review'}</Button>
              </div>
            ))}
            {!records.some((record) => Boolean(record.removedAt) === deleted) ? <p className="py-2.5 text-xs text-[var(--loom-muted)]">No {deleted ? 'deleted' : 'available'} records.</p> : null}
          </div>
          {hasOlder ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { void load(records.length).catch((cause) => setError(String(cause))); }}>Load older records</Button> : null}
          <p className="text-[11px] leading-4 text-[var(--loom-faint)]">Records keep names and locations only, not copies of the video. Cleanup files are kept for 30 days.</p>
        </div>
      </SettingsDisclosure>
      ) : null}
      {status ? <SettingsNote role="status">{status}</SettingsNote> : null}
      {error && !preview ? <SettingsNote role="alert" tone="error"><span className="whitespace-pre-wrap">{error}</span></SettingsNote> : null}
      <SettingsDialog
        open={Boolean(preview)}
        onClose={() => { setPreview(null); setRenamePreview(null); }}
        busy={busy}
        size="lg"
        title={preview ? `${preview.title}: original names` : 'Original names'}
        description="Check the first saved locations before restoring. Occupied destinations are kept, and deleted files can't be recreated."
        footerStart={preview ? `${preview.entries.length.toLocaleString()} ${preview.entries.length === 1 ? 'file' : 'files'}` : undefined}
        footer={(
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { setPreview(null); setRenamePreview(null); }}>Close</Button>
            {preview && !preview.removedAt ? <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => void previewRename()}>Rename using metadata</Button> : null}
            {preview && !preview.removedAt ? <Button size="sm" disabled={disabled || busy} onClick={() => void restore()}>Restore original</Button> : null}
          </>
        )}
      >
        <div className="space-y-3">
          {preview?.originalQuality === 'historical-partial' ? <SettingsDialogMessage tone="warning">Some names came from older rename records. The full original folder contents weren't recorded then.</SettingsDialogMessage> : null}
          {renamePreview ? (
            <section className="overflow-hidden rounded-lg border border-[var(--loom-control-border)]">
              <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--loom-surface-2)] px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--loom-text)]">Metadata names</p>
                  <p className="text-xs text-[var(--loom-muted)]">Only this import is renamed.</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setRenamePreview(null)}>Cancel</Button>
                  <Button size="sm" disabled={busy || disabled || !renamePreview.entries.length} onClick={() => void applyRename()}>Apply names</Button>
                </div>
              </div>
              <ul className="max-h-[30vh] divide-y divide-[color-mix(in_srgb,var(--loom-text)_8%,transparent)] overflow-y-auto text-xs">
                {renamePreview.entries.map((entry) => (
                  <li key={entry.id} className="space-y-0.5 break-all px-3 py-2">
                    <p className="text-[var(--loom-muted)]">{entry.fromName}</p>
                    <p className="text-[var(--loom-text)]">→ {entry.moveToFolder ? `${entry.moveToFolder}/` : ''}{entry.toName}</p>
                    {entry.verification ? <p className="text-[var(--loom-faint)]">{entry.verification.note}</p> : null}
                    {entry.sidecars.map((sidecar) => <p key={sidecar.fromName} className="text-[var(--loom-faint)]">{sidecar.fromName} → {sidecar.toName}</p>)}
                  </li>
                ))}
                {renamePreview.skipped.map((entry, index) => <li key={index} className="px-3 py-2 text-[var(--loom-muted)]">{entry.fileName}: {entry.reason}</li>)}
                {!renamePreview.entries.length ? <li className="px-3 py-2 text-[var(--loom-muted)]">No safe name changes for this import. Check its metadata match or the reasons above.</li> : null}
              </ul>
            </section>
          ) : null}
          <ul className="divide-y divide-[color-mix(in_srgb,var(--loom-text)_8%,transparent)] overflow-hidden rounded-lg border border-[var(--loom-control-border)] text-xs">
            {preview?.entries.slice(0, shown).map((entry, index) => (
              <li key={`${entry.original}:${index}`} className="space-y-0.5 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--loom-faint)]">Original</span>
                  <span className="text-[11px] text-[var(--loom-muted)]">{entry.status}</span>
                </div>
                <p className="select-text break-all text-[var(--loom-text)]">{entry.original}</p>
                <p className="select-text break-all text-[var(--loom-muted)]">Now: {entry.current}</p>
              </li>
            ))}
          </ul>
          {preview && preview.entries.length > shown ? <Button variant="outline" size="sm" className="w-full" onClick={() => setShown((value) => value + 50)}>Show more</Button> : null}
          {preview?.issues.length ? <SettingsDialogMessage tone="warning"><span className="whitespace-pre-wrap">{preview.issues.map((issue) => `${issue.path}: ${issue.reason}`).join('\n')}</span></SettingsDialogMessage> : null}
          {error ? <SettingsDialogMessage><span className="whitespace-pre-wrap">{error}</span></SettingsDialogMessage> : null}
        </div>
      </SettingsDialog>
    </>
  );
}
