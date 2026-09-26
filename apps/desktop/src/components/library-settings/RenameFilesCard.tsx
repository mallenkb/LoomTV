import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, FilePen, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ConfirmProvider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLibrary } from '@/contexts/LibraryContext';
import { desktopApi } from '@/lib/desktopApi';
import type { MediaRenameBatch, MediaRenamePreview, MediaRenamePreviewEntry } from '@/shared/desktopProtocol';

const HISTORY_SHOWN = 5;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // IPC errors arrive wrapped as "Error invoking remote method '...': Error: ...".
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

type Group = { key: string; title: string; type: MediaRenamePreviewEntry['mediaType']; entries: MediaRenamePreviewEntry[] };

/**
 * Renames matched files to the names LoomTV shows for them. Nothing changes
 * until the preview is approved, and every batch can be undone from here.
 */
export default function RenameFilesCard({ disabled }: { disabled: boolean }) {
  const { refreshLibrary } = useLibrary();
  const confirm = useConfirm();
  const [preview, setPreview] = useState<MediaRenamePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<MediaRenameBatch[]>([]);
  const [busy, setBusy] = useState<'preview' | 'apply' | 'undo' | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    desktopApi.listMediaRenames().then(setHistory).catch(() => undefined);
  }, []);

  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, Group>();
    for (const entry of preview?.entries || []) {
      const key = `${entry.mediaType}:${entry.mediaTitle}`;
      const group = byKey.get(key) || { key, title: entry.mediaTitle, type: entry.mediaType, entries: [] };
      group.entries.push(entry);
      byKey.set(key, group);
    }
    return [...byKey.values()];
  }, [preview]);

  const openPreview = useCallback(async () => {
    setBusy('preview');
    setError('');
    setStatus('');
    try {
      const next = await desktopApi.previewMediaRenames();
      setPreview(next);
      setSelected(new Set(next.entries.map((entry) => entry.id)));
      setShowSkipped(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const toggle = (ids: readonly string[], on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const apply = useCallback(async () => {
    if (!preview || selected.size === 0) return;
    const chosen = preview.entries.filter((entry) => selected.has(entry.id));
    const files = chosen.filter((entry) => entry.kind === 'file').length;
    const folders = chosen.length - files;
    const moves = chosen.filter((entry) => entry.moveToFolder).length;
    const confirmed = await confirm({
      title: `Rename ${files.toLocaleString()} ${files === 1 ? 'file' : 'files'}${folders ? ` and ${folders.toLocaleString()} ${folders === 1 ? 'folder' : 'folders'}` : ''}?`,
      description: `The files are renamed on disk together with their subtitles${moves ? `, and ${moves.toLocaleString()} ${moves === 1 ? 'moves' : 'move'} into the right folder` : ''}. Watch progress, lists, and skip segments move with them, and you can undo the whole batch afterwards.`,
      confirmLabel: 'Rename',
    });
    if (!confirmed) return;
    setBusy('apply');
    setError('');
    try {
      const result = await desktopApi.applyMediaRenames([...selected]);
      setPreview(null);
      setStatus(`Renamed ${result.renamed.toLocaleString()} ${result.renamed === 1 ? 'file' : 'files'}.`);
      setHistory(await desktopApi.listMediaRenames());
      await refreshLibrary();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [confirm, preview, refreshLibrary, selected]);

  const undo = useCallback(async (batch: MediaRenameBatch) => {
    const confirmed = await confirm({
      title: 'Undo this rename?',
      description: `Put ${batch.videoCount.toLocaleString()} ${batch.videoCount === 1 ? 'file' : 'files'} back under their old names. They will not be renamed this way again unless their match changes.`,
      confirmLabel: 'Undo rename',
    });
    if (!confirmed) return;
    setBusy('undo');
    setError('');
    setStatus('');
    try {
      setHistory(await desktopApi.undoMediaRename(batch.id));
      setStatus('The rename was undone.');
      await refreshLibrary();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [confirm, refreshLibrary]);

  const selectedCount = preview ? preview.entries.filter((entry) => selected.has(entry.id)).length : 0;

  return (
    <>
      <Card className="settings-panel">
        <CardHeader className="gap-1">
          <CardTitle className="text-base text-white">Rename files</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Rename matched movies and episodes to the names LoomTV shows, such as "S01E05 - Phantoms of the Dead.mkv". A movie that is not in a folder of its own gets one, and episodes loose in a show's folder, or in another season's folder, move into their season folder. You review every change first, files without a confident match are left as they are, and each batch can be undone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => void openPreview()} disabled={disabled || busy !== null} className="gap-2">
              <FilePen className="h-4 w-4" aria-hidden="true" />
              {busy === 'preview' ? 'Checking files…' : 'Preview renames'}
            </Button>
            {disabled ? <p className="text-xs text-[var(--loom-muted)]">Available when the library scan finishes.</p> : null}
          </div>
          {status ? <p role="status" className="text-sm text-[var(--loom-muted)]">{status}</p> : null}
          {error ? <p role="alert" className="text-sm text-red-200">{error}</p> : null}
          {history.length ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-faint)]">Recent renames</p>
              {history.slice(0, HISTORY_SHOWN).map((batch) => (
                <div key={batch.id} className="settings-panel-soft flex flex-wrap items-center justify-between gap-3 rounded-xl p-3">
                  <div className="min-w-0">
                    <p className="text-sm text-white">
                      {batch.videoCount.toLocaleString()} {batch.videoCount === 1 ? 'file' : 'files'}
                      {batch.folderCount ? `, ${batch.folderCount.toLocaleString()} ${batch.folderCount === 1 ? 'folder' : 'folders'}` : ''}
                      <span className="text-[var(--loom-muted)]"> · {new Date(batch.createdAt).toLocaleString()}</span>
                    </p>
                    {batch.examples[0] ? (
                      <p className="mt-0.5 truncate text-xs text-[var(--loom-muted)]">
                        {batch.examples[0].fromName} → {batch.examples[0].toName}
                      </p>
                    ) : null}
                  </div>
                  {batch.undoneAt ? (
                    <span className="text-xs text-[var(--loom-muted)]">Undone</span>
                  ) : (
                    <Button type="button" variant="outline" size="sm" onClick={() => void undo(batch)} disabled={disabled || busy !== null} className="gap-1.5">
                      <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Undo
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={preview !== null}
        onOpenChange={(open) => { if (!open && busy === null) setPreview(null); }}
        contentClassName="max-w-3xl border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]"
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[var(--loom-text)]">Review renames</DialogTitle>
            <DialogDescription className="text-[var(--loom-muted)]">
              {preview && preview.entries.length
                ? 'Untick anything that looks wrong. Only ticked items are renamed.'
                : 'Every matched file already has its LoomTV name, or needs a closer look first.'}
            </DialogDescription>
          </DialogHeader>
          {preview ? (
            <div className="mt-4 space-y-4">
              {preview.entries.length ? (
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-[var(--loom-muted)]">{selectedCount.toLocaleString()} of {preview.entries.length.toLocaleString()} selected</span>
                  <span className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => toggle(preview.entries.map((entry) => entry.id), true)}>Select all</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => toggle(preview.entries.map((entry) => entry.id), false)}>Select none</Button>
                  </span>
                </div>
              ) : null}
              <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
                {groups.map((group) => {
                  const ids = group.entries.map((entry) => entry.id);
                  const allOn = ids.every((id) => selected.has(id));
                  return (
                    <section key={group.key} className="settings-panel-soft rounded-xl p-3">
                      <label className="flex items-center gap-2 text-sm font-semibold text-white">
                        <input type="checkbox" checked={allOn} onChange={(event) => toggle(ids, event.target.checked)} className="h-4 w-4 accent-[var(--loom-accent)]" />
                        {group.title}
                        <span className="font-normal text-[var(--loom-muted)]">{group.type === 'movie' ? 'Movie' : group.type === 'anime' ? 'Anime' : 'TV show'} · {group.entries.length}</span>
                      </label>
                      <ul className="mt-2 space-y-1.5">
                        {group.entries.map((entry) => (
                          <li key={entry.id}>
                            <label className="flex items-start gap-2 text-xs">
                              <input type="checkbox" checked={selected.has(entry.id)} onChange={(event) => toggle([entry.id], event.target.checked)} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--loom-accent)]" />
                              <span className="w-24 shrink-0 text-[var(--loom-faint)]">{entry.label}</span>
                              <span className="min-w-0 flex-1">
                                <span className="block break-all text-[var(--loom-muted)]">{entry.fromName}</span>
                                <span className="flex items-start gap-1 break-all text-[var(--loom-text)]">
                                  <ArrowRight className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                                  {entry.moveToFolder ? `${entry.moveToFolder}/` : ''}{entry.toName}
                                </span>
                                {entry.moveToFolder ? (
                                  <span className="block text-[var(--loom-accent)]">
                                    Moves into {entry.createsFolder ? 'a new ' : ''}"{entry.moveToFolder}" folder
                                  </span>
                                ) : null}
                                {entry.sidecars.length ? (
                                  <span className="block text-[var(--loom-faint)]">
                                    + {entry.sidecars.map((sidecar) => sidecar.toName).join(', ')}
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
                {preview.skipped.length ? (
                  <section className="rounded-xl border border-[var(--loom-panel-border)] p-3">
                    <button type="button" onClick={() => setShowSkipped((value) => !value)} className="text-sm font-semibold text-white">
                      {showSkipped ? 'Hide' : 'Show'} {preview.skipped.length.toLocaleString()} {preview.skipped.length === 1 ? 'file' : 'files'} left as they are
                    </button>
                    {showSkipped ? (
                      <ul className="mt-2 space-y-1.5">
                        {preview.skipped.map((skip, index) => (
                          <li key={`${skip.fileName}:${index}`} className="text-xs">
                            <span className="block break-all text-[var(--loom-text)]">{skip.mediaTitle} · {skip.fileName}</span>
                            <span className="block text-[var(--loom-muted)]">{skip.reason}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                ) : null}
              </div>
              {error ? <p role="alert" className="text-sm text-red-200">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setPreview(null)} disabled={busy !== null}>Cancel</Button>
                <Button type="button" onClick={() => void apply()} disabled={busy !== null || selectedCount === 0}>
                  {busy === 'apply' ? 'Renaming…' : `Rename ${selectedCount.toLocaleString()}`}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
