import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, FilePen, Undo2 } from 'lucide-react';
import { CaretDown } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ConfirmProvider';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLibrary } from '@/contexts/LibraryContext';
import { desktopApi } from '@/lib/desktopApi';
import type { MediaRenameBatch, MediaRenamePreview, MediaRenamePreviewEntry, MediaRenameStatus } from '@/shared/desktopProtocol';

const HISTORY_SHOWN = 5;
type OrganizeMode = MediaRenameStatus['mode'];
const MODE_OPTIONS: Array<{ value: OrganizeMode; label: string }> = [
  { value: 'ask', label: 'Ask me' },
  { value: 'auto', label: 'Automatically' },
  { value: 'off', label: 'Off' },
];

function batchSummary(batch: MediaRenameBatch): string {
  const files = `${batch.videoCount.toLocaleString()} ${batch.videoCount === 1 ? 'file' : 'files'}`;
  const folders = batch.folderCount ? `, ${batch.folderCount.toLocaleString()} ${batch.folderCount === 1 ? 'folder' : 'folders'}` : '';
  return `${files}${folders} · ${new Date(batch.createdAt).toLocaleString()}`;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // IPC errors arrive wrapped as "Error invoking remote method '...': Error: ...".
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

type Group = { key: string; title: string; type: MediaRenamePreviewEntry['mediaType']; entries: MediaRenamePreviewEntry[] };

/**
 * The "Organize files" row of Library sync: renames and moves matched files
 * to the names LoomTV shows. In "Ask me" nothing changes until a preview is
 * approved; in "Automatically" the main process applies every change that
 * passes all checks after each sync. Every batch can be undone from here.
 */
export default function OrganizeFilesSection({ disabled }: { disabled: boolean }) {
  const { refreshLibrary } = useLibrary();
  const confirm = useConfirm();
  const [preview, setPreview] = useState<MediaRenamePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<MediaRenameBatch[]>([]);
  const [organize, setOrganize] = useState<MediaRenameStatus | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'apply' | 'undo' | 'mode' | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [nextStatus, nextHistory] = await Promise.all([desktopApi.mediaRenameStatus(), desktopApi.listMediaRenames()]);
    setOrganize(nextStatus);
    setHistory(nextHistory);
  }, []);

  // Re-read after mounting, after every sync finishes, and after an
  // automatic run renamed files in the background.
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    if (!disabled && (wasDisabled.current || organize === null)) void reload().catch(() => undefined);
    wasDisabled.current = disabled;
  }, [disabled, organize, reload]);
  useEffect(() => desktopApi.onLibraryFilesOrganized((result) => {
    setStatus(`Organized ${result.renamed.toLocaleString()} ${result.renamed === 1 ? 'file' : 'files'} after the last sync.`);
    void reload().catch(() => undefined);
  }), [reload]);

  const changeMode = useCallback(async (mode: OrganizeMode) => {
    setBusy('mode');
    setError('');
    try {
      await desktopApi.saveSettings({ organizeFilesAfterSync: mode });
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [reload]);

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
      await reload();
      await refreshLibrary();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [confirm, preview, refreshLibrary, reload, selected]);

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
      await desktopApi.undoMediaRename(batch.id);
      setStatus('The rename was undone.');
      await reload();
      await refreshLibrary();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [confirm, refreshLibrary, reload]);

  const selectedCount = preview ? preview.entries.filter((entry) => selected.has(entry.id)).length : 0;

  const mode = organize?.mode ?? 'ask';
  const pending = organize?.pendingFiles ?? 0;
  const lastBatch = history[0] || null;
  const summary = disabled
    ? 'Available when the sync finishes.'
    : organize === null
      ? 'Checking files…'
      : mode === 'off'
        ? 'Files keep their current names.'
        : pending > 0
          ? `${pending.toLocaleString()} ${pending === 1 ? 'file can' : 'files can'} be renamed to match ${pending === 1 ? 'its title' : 'their titles'}.`
          : 'Everything is organized.';

  return (
    <>
      <div className="space-y-3 rounded-lg bg-[var(--loom-surface-2)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <FilePen className="mt-0.5 h-4 w-4 shrink-0 text-[var(--loom-accent)]" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-white">Organize files after sync</p>
              <p className="mt-0.5 text-xs text-[var(--loom-muted)]">
                Rename and move matched files to the names LoomTV shows. Doubtful matches are never touched, and every batch can be undone.
              </p>
            </div>
          </div>
          <span className="relative block w-40 shrink-0">
            <select value={mode} onChange={(event) => void changeMode(event.target.value as OrganizeMode)} disabled={busy !== null} aria-label="Organize files after sync" className="h-10 w-full appearance-none rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] py-2 pl-4 pr-10 text-sm text-[var(--loom-text)] outline-none focus:border-[var(--loom-accent)]">
              {MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <CaretDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)]" weight="regular" aria-hidden="true" />
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--loom-control-border)] pt-3">
          <p className="text-sm text-[var(--loom-text)]" role="status">{summary}</p>
          <Button type="button" variant={pending > 0 ? 'default' : 'outline'} size="sm" onClick={() => void openPreview()} disabled={disabled || busy !== null} className="gap-1.5">
            {busy === 'preview' ? 'Checking files…' : 'Review renames'}
          </Button>
        </div>
        {organize?.lastAutomaticError ? (
          <p role="alert" className="text-xs text-red-200">The last automatic rename did not run: {organize.lastAutomaticError}</p>
        ) : null}
        {lastBatch ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--loom-muted)]">
            <span className="min-w-0 truncate">Last rename: {batchSummary(lastBatch)}{lastBatch.undoneAt ? ' · undone' : ''}</span>
            <span className="flex shrink-0 items-center gap-2">
              {!lastBatch.undoneAt ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void undo(lastBatch)} disabled={disabled || busy !== null} className="gap-1.5">
                  <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Undo
                </Button>
              ) : null}
              {history.length > 1 ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setShowHistory((value) => !value)}>
                  {showHistory ? 'Hide earlier' : 'Earlier renames'}
                </Button>
              ) : null}
            </span>
          </div>
        ) : null}
        {showHistory ? (
          <div className="space-y-2">
            {history.slice(1, HISTORY_SHOWN + 1).map((batch) => (
              <div key={batch.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--loom-bg)] p-2.5 text-xs">
                <div className="min-w-0">
                  <p className="text-[var(--loom-text)]">{batchSummary(batch)}</p>
                  {batch.examples[0] ? <p className="mt-0.5 truncate text-[var(--loom-muted)]">{batch.examples[0].fromName} → {batch.examples[0].toName}</p> : null}
                </div>
                {batch.undoneAt ? (
                  <span className="text-[var(--loom-muted)]">Undone</span>
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
        {status ? <p role="status" className="text-xs text-[var(--loom-muted)]">{status}</p> : null}
        {error && preview === null ? <p role="alert" className="text-xs text-red-200">{error}</p> : null}
      </div>

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
