import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { SettingsDisclosure, SettingsNote, SettingsRow, SettingsSelect } from '@/components/settings/SettingsLayout';
import SettingsDetailItem from '@/components/settings/SettingsDetailItem';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ConfirmProvider';
import { SettingsDialog, SettingsDialogMessage } from '@/components/settings/SettingsDialog';
import { useLibrary } from '@/contexts/LibraryContext';
import { desktopApi } from '@/lib/desktopApi';
import RenameRecordDialog from './RenameRecordDialog';
import type { MediaRenameBatch, MediaRenameRecord, MediaRenamePreview, MediaRenamePreviewEntry, MediaRenameStatus } from '@/shared/desktopProtocol';

const HISTORY_PAGE_SIZE = 20;
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
  const [busy, setBusy] = useState<'preview' | 'apply' | 'undo' | 'mode' | 'history' | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [record, setRecord] = useState<MediaRenameRecord | null>(null);
  const historyGeneration = useRef(0);
  const [showSkipped, setShowSkipped] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const generation = ++historyGeneration.current;
    const [nextStatus, nextHistory] = await Promise.all([desktopApi.mediaRenameStatus(), desktopApi.listMediaRenames()]);
    if (generation !== historyGeneration.current) return;
    setOrganize(nextStatus);
    setHistory(nextHistory);
    setHasOlder(nextHistory.length === HISTORY_PAGE_SIZE);
  }, []);

  useEffect(() => {
    if (disabled || busy || organize?.mode !== 'auto' || !organize.waitingFiles) return;
    const timer = window.setTimeout(() => { void reload().catch(() => undefined); }, 10_000);
    return () => window.clearTimeout(timer);
  }, [disabled, busy, organize, reload]);

  const loadOlder = useCallback(async () => {
    const generation = historyGeneration.current;
    setBusy('history');
    setError('');
    try {
      const older = await desktopApi.listMediaRenames(history.length);
      if (generation !== historyGeneration.current) return;
      setHistory((current) => {
        const known = new Set(current.map((batch) => batch.id));
        return [...current, ...older.filter((batch) => !known.has(batch.id))];
      });
      setHasOlder(older.length === HISTORY_PAGE_SIZE);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [history.length]);

  const viewNames = useCallback(async (batch: MediaRenameBatch) => {
    setBusy('history');
    setError('');
    try {
      const next = await desktopApi.getMediaRenameRecord(batch.id);
      if (!next) throw new Error('That rename record could not be found.');
      setRecord(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
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
      // Matches the metadata sources have not confirmed wait for a deliberate choice.
      setSelected(new Set(next.entries
        .filter((entry) => !entry.verification || entry.verification.status === 'confirmed')
        .map((entry) => entry.id)));
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
      description: `The files are renamed on disk together with their subtitles${moves ? `, and ${moves.toLocaleString()} ${moves === 1 ? 'moves' : 'move'} into the right folder` : ''}. Watch progress, lists, and skip segments move with them, and you can restore the original import afterwards.`,
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

  const selectedCount = preview ? preview.entries.filter((entry) => selected.has(entry.id)).length : 0;

  const mode = organize?.mode ?? 'auto';
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
          : organize.waitingFiles
            ? 'Waiting for files that are still being copied or downloaded.'
            : organize.skippedFiles
              ? 'Some files are waiting or need review. Open the preview for details.'
              : 'Everything is organized.';

  return (
    <>
      <SettingsRow
        title="Rename files after sync"
        description={<span role="status">{summary}</span>}
      >
        {mode !== 'off' && (pending > 0 || lastBatch) ? (
          <Button type="button" variant={pending > 0 ? 'default' : 'outline'} size="sm" onClick={() => void openPreview()} disabled={disabled || busy !== null}>
            {busy === 'preview' ? 'Checking files…' : 'Review renames'}
          </Button>
        ) : null}
        <SettingsSelect label="Rename files after sync" value={mode} options={MODE_OPTIONS} onChange={(value) => void changeMode(value)} disabled={busy !== null} className="w-36" />
      </SettingsRow>
      {organize?.lastAutomaticError ? (
        <SettingsNote role="alert" tone="error">The last automatic rename did not run: {organize.lastAutomaticError}</SettingsNote>
      ) : null}
      {error && preview === null ? <SettingsNote role="alert" tone="error">{error}</SettingsNote> : null}
      {status ? <SettingsNote role="status">{status}</SettingsNote> : null}
      {lastBatch ? (
        <SettingsDisclosure
          title="Rename history"
          description={`Last rename: ${batchSummary(lastBatch)}${lastBatch.undoneAt ? ' · undone' : ''}`}
        >
          <div className="max-h-[45vh] divide-y divide-[var(--loom-settings-divider)] overflow-y-auto overscroll-contain">
            {history.map((batch) => (
              <div key={batch.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-xs">
                <div className="min-w-0">
                  <p className="text-[var(--loom-text)]">{batchSummary(batch)}{batch.undoneAt ? ' · undone' : ''}</p>
                  {batch.examples[0] ? <p className="mt-0.5 truncate text-[var(--loom-muted)]">{batch.examples[0].fromName} → {batch.examples[0].toName}</p> : null}
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => void viewNames(batch)} disabled={busy !== null}>
                  View record
                </Button>
              </div>
            ))}
            {hasOlder ? (
              <div className="pt-2.5">
                <Button type="button" variant="outline" size="sm" onClick={() => void loadOlder()} disabled={busy !== null}>
                  {busy === 'history' ? 'Loading…' : 'Load older renames'}
                </Button>
              </div>
            ) : null}
          </div>
        </SettingsDisclosure>
      ) : null}

      {record ? (
        <RenameRecordDialog
          record={record}
          disabled={disabled || busy !== null}
          error={error}
          onClose={() => { if (busy === null) setRecord(null); }}
        />
      ) : null}

      <SettingsDialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        busy={busy !== null}
        size="lg"
        title="Review renames"
        description={preview && preview.entries.length
          ? 'Untick anything that looks wrong. Only ticked items are renamed.'
          : 'Every matched file already has its Loom name, or needs a closer look first.'}
        footerStart={preview?.entries.length ? `${selectedCount.toLocaleString()} of ${preview.entries.length.toLocaleString()} selected` : undefined}
        footer={(
          <>
            <Button size="sm" type="button" variant="outline" onClick={() => setPreview(null)} disabled={busy !== null}>Cancel</Button>
            {preview?.entries.length ? (
              <Button size="sm" type="button" onClick={() => void apply()} disabled={busy !== null || selectedCount === 0}>
                {busy === 'apply' ? 'Renaming…' : `Rename ${selectedCount.toLocaleString()}`}
              </Button>
            ) : null}
          </>
        )}
      >
        {preview ? (
          <div className="space-y-3">
            {preview.entries.length ? (
              <div className="flex items-center gap-1">
                <Button type="button" variant="outline" size="sm" onClick={() => toggle(preview.entries.map((entry) => entry.id), true)}>Select all</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => toggle(preview.entries.map((entry) => entry.id), false)}>Select none</Button>
              </div>
            ) : null}
            {groups.map((group) => {
              const ids = group.entries.map((entry) => entry.id);
              const allOn = ids.every((id) => selected.has(id));
              return (
                <section key={group.key} className="overflow-hidden rounded-lg border border-[var(--loom-control-border)]">
                  <label className="flex h-10 cursor-pointer items-center gap-2.5 bg-[var(--loom-surface-2)] px-3 text-sm">
                    <input type="checkbox" checked={allOn} onChange={(event) => toggle(ids, event.target.checked)} className="h-4 w-4 accent-[var(--loom-accent)]" />
                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--loom-text)]">{group.title}</span>
                    <span className="shrink-0 text-xs text-[var(--loom-muted)]">{group.type === 'movie' ? 'Movie' : group.type === 'anime' ? 'Anime' : 'TV show'} · {group.entries.length}</span>
                  </label>
                  <ul className="divide-y divide-[color-mix(in_srgb,var(--loom-text)_8%,transparent)]">
                    {group.entries.map((entry) => (
                      <li key={entry.id}>
                        <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 text-xs">
                          <input type="checkbox" checked={selected.has(entry.id)} onChange={(event) => toggle([entry.id], event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--loom-accent)]" />
                          <span className="min-w-0 flex-1 space-y-0.5">
                            <span className="block text-[11px] font-medium text-[var(--loom-faint)]">{entry.label}</span>
                            <span className="block break-all text-[var(--loom-muted)]">{entry.fromName}</span>
                            <span className="flex items-start gap-1.5 break-all text-[var(--loom-text)]">
                              <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-[var(--loom-faint)]" aria-hidden="true" />
                              {entry.moveToFolder ? `${entry.moveToFolder}/` : ''}{entry.toName}
                            </span>
                            {entry.moveToFolder ? <span className="block text-[var(--loom-accent)]">Moves into {entry.createsFolder ? 'a new ' : ''}"{entry.moveToFolder}" folder</span> : null}
                            {entry.sidecars.length ? <span className="block text-[var(--loom-faint)]">+ {entry.sidecars.map((sidecar) => sidecar.toName).join(', ')}</span> : null}
                            {entry.verification ? (
                              <span className={`block ${entry.verification.status === 'confirmed' ? 'text-[var(--loom-faint)]' : entry.verification.status === 'conflict' ? 'settings-status-error' : 'settings-status-warning'}`}>
                                {entry.verification.note}
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
              <section className="overflow-hidden rounded-lg border border-[var(--loom-control-border)]">
                <button type="button" aria-expanded={showSkipped} onClick={() => setShowSkipped((value) => !value)} className="flex h-10 w-full items-center gap-2 px-3 text-left text-sm text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)]">
                  <ChevronRight className={`h-4 w-4 shrink-0 text-[var(--loom-muted)] transition-transform ${showSkipped ? 'rotate-90' : ''}`} aria-hidden="true" />
                  <span className="flex-1">{preview.skipped.length.toLocaleString()} {preview.skipped.length === 1 ? 'file' : 'files'} left as they are</span>
                </button>
                {showSkipped ? (
                  <ul className="divide-y divide-[color-mix(in_srgb,var(--loom-text)_8%,transparent)] px-3">
                    {preview.skipped.map((skip, index) => (
                      <SettingsDetailItem key={`${skip.fileName}:${index}`} title={skip.mediaTitle} detail={skip.fileName} reason={skip.reason} />
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
            {error ? <SettingsDialogMessage>{error}</SettingsDialogMessage> : null}
          </div>
        ) : null}
      </SettingsDialog>
    </>
  );
}
