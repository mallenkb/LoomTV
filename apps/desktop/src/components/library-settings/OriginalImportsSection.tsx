import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
    <div className="space-y-3 rounded-lg bg-[var(--loom-surface-2)] p-3">
      <p className="text-sm font-semibold text-[var(--loom-text)]">Original imports</p>
      <p className="text-xs text-[var(--loom-muted)]">Restore the first recorded names and locations, including available cleanup files. Original records stay after deletion, but they contain no backup of the video. Cleanup files are kept for 30 days. After restoring, you can rename using metadata again. Your original record stays the same.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setDeleted((value) => !value)}>{deleted ? 'Show available imports' : 'Show deleted history'}</Button>
        <Button variant="outline" size="sm" disabled={busy || disabled} onClick={() => { void load().catch((cause) => setError(String(cause))); }}>Refresh records</Button>
      </div>
      <div className="max-h-[40vh] space-y-2 overflow-y-auto">
        {records.filter((record) => Boolean(record.removedAt) === deleted).map((record) => (
          <div key={record.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--loom-bg)] p-3 text-xs">
            <div>
              <p className="text-[var(--loom-text)]">{record.title}</p>
              <p className="text-[var(--loom-muted)]">{new Date(record.createdAt).toLocaleString()} · {record.entryCount} recorded entries</p>
              <p className="text-[var(--loom-muted)]">{record.removedAt ? `Removal detected ${new Date(record.removedAt).toLocaleString()}` : record.restoredAt ? 'Original state restored' : record.restoreRequestedAt ? 'Restore requested. Review remaining files.' : 'Original record saved'}</p>
            </div>
            <Button variant="outline" size="sm" disabled={busy || disabled} onClick={() => void inspect(record.id)}>{record.removedAt ? 'View history' : 'Review original'}</Button>
          </div>
        ))}
        {!records.some((record) => Boolean(record.removedAt) === deleted) ? <p className="text-xs text-[var(--loom-muted)]">No {deleted ? 'deleted' : 'available'} imports on this page. New records appear after a library scan.</p> : null}
        {hasOlder ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { void load(records.length).catch((cause) => setError(String(cause))); }}>Load older imports</Button> : null}
      </div>
      {status ? <p role="status" className="text-xs text-[var(--loom-muted)]">{status}</p> : null}
      {error && !preview ? <p role="alert" className="whitespace-pre-wrap text-xs text-red-200">{error}</p> : null}
      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open && !busy) setPreview(null); }} contentClassName="max-w-3xl bg-[var(--loom-panel)] text-[var(--loom-text)]">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{preview?.title}: original names</DialogTitle>
            <DialogDescription className="text-[var(--loom-muted)]">Review the first saved locations before restoring. Occupied destinations are kept. Files you deleted cannot be recreated from this record.</DialogDescription>
          </DialogHeader>
          {preview?.originalQuality === 'historical-partial' ? <p className="my-3 text-xs text-amber-200">Some names were recovered from older rename records. The complete original folder contents were not recorded at that time.</p> : null}
          {renamePreview ? <div className="my-3 max-h-[35vh] space-y-2 overflow-y-auto rounded-lg border border-[var(--loom-border)] p-3 text-xs">
            <p className="font-semibold">Review metadata names</p>
            <p>Only this import will be renamed. Automatic organization can manage it again after you apply these changes.</p>
            {renamePreview.entries.map((entry) => <div key={entry.id} className="break-all"><p>{entry.fromName} → {entry.moveToFolder ? `${entry.moveToFolder}/` : ''}{entry.toName}</p>{entry.verification ? <p className="text-[var(--loom-muted)]">{entry.verification.note}</p> : null}{entry.sidecars.map((sidecar) => <p key={sidecar.fromName} className="text-[var(--loom-muted)]">{sidecar.fromName} → {sidecar.toName}</p>)}</div>)}
            {renamePreview.skipped.map((entry, index) => <p key={index}>{entry.fileName}: {entry.reason}</p>)}
            {!renamePreview.entries.length ? <p>No safe name changes are available for this import. Check its metadata match or the reasons above.</p> : null}
            <Button size="sm" disabled={busy || disabled || !renamePreview.entries.length} onClick={() => void applyRename()}>Apply metadata names</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setRenamePreview(null)}>Cancel rename</Button>
          </div> : null}
          <div className="my-3 max-h-[50vh] space-y-3 overflow-y-auto">
            {preview?.entries.slice(0, shown).map((entry, index) => (
              <dl key={`${entry.original}:${index}`} className="space-y-1 rounded-lg bg-[var(--loom-bg)] p-3 text-xs">
                <dt className="text-[var(--loom-muted)]">Original location</dt><dd className="select-text break-all">{entry.original}</dd>
                <dt className="text-[var(--loom-muted)]">Current location</dt><dd className="select-text break-all">{entry.current}</dd>
                <dt className="text-[var(--loom-muted)]">Status</dt><dd>{entry.status}</dd>
              </dl>
            ))}
            {preview && preview.entries.length > shown ? <Button variant="outline" size="sm" onClick={() => setShown((value) => value + 50)}>Show more files</Button> : null}
          </div>
          {preview?.issues.length ? <p className="whitespace-pre-wrap text-xs text-amber-200">{preview.issues.map((issue) => `${issue.path}: ${issue.reason}`).join('\n')}</p> : null}
          {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-red-200">{error}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            {preview && !preview.removedAt ? <Button disabled={disabled || busy} onClick={() => void restore()}>Restore original</Button> : null}
            {preview && !preview.removedAt ? <Button variant="outline" disabled={busy || disabled} onClick={() => void previewRename()}>Rename using metadata</Button> : null}
            <Button variant="outline" disabled={busy} onClick={() => { setPreview(null); setRenamePreview(null); }}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
