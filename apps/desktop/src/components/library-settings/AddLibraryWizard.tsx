import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SETTINGS_INPUT_CLASS, SettingsDialog, SettingsDialogField, SettingsDialogMessage } from '@/components/settings/SettingsDialog';
import { SettingsSwitch } from '@/components/settings/SettingsLayout';
import { desktopApi } from '@/lib/desktopApi';
import {
  LIBRARY_TYPE_DEFINITIONS,
  VISIBLE_LIBRARY_TYPE_DEFINITIONS,
  LibraryTypeIcon,
  type LibraryKind,
} from './librarySettingsModel';

export type WizardFolder = {
  id: string;
  path: string;
  name?: string;
  count?: number;
  message?: string | null;
};

export type AddLibraryWizardProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canAddFolder: (kind: LibraryKind) => boolean;
  onAddFolder: (kind: LibraryKind, folderPath?: string) => Promise<WizardFolder | null>;
  onRemoveFolder: (kind: LibraryKind, folder: WizardFolder) => Promise<void | boolean>;
  onScan: (kind: LibraryKind) => Promise<void>;
};

const VIDEO_LIBRARY_KINDS = new Set<LibraryKind>(['movies', 'tvShows', 'anime', 'others']);

export default function AddLibraryWizard({
  open,
  onOpenChange,
  canAddFolder,
  onAddFolder,
  onRemoveFolder,
  onScan,
}: AddLibraryWizardProps) {
  const [kind, setKind] = useState<LibraryKind>('movies');
  const [folders, setFolders] = useState<WizardFolder[]>([]);
  const [scanAfterAdding, setScanAfterAdding] = useState(true);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const [folderPathInput, setFolderPathInput] = useState('');

  useEffect(() => {
    if (!open) return;
    setKind('movies');
    setFolders([]);
    setScanAfterAdding(true);
    setBusy(false);
    setRemovingId(null);
    setError('');
    setComplete(false);
    setFolderPathInput('');
  }, [open]);

  const selectedDefinition = LIBRARY_TYPE_DEFINITIONS.find((definition) => definition.kind === kind)
    || LIBRARY_TYPE_DEFINITIONS[0];
  const videoLibrary = VIDEO_LIBRARY_KINDS.has(kind);
  const folderActionsAvailable = canAddFolder(kind);

  const selectKind = (nextKind: LibraryKind) => {
    if (nextKind === kind) return;
    if (folders.length > 0) {
      setError('Remove the folder first to change the library type.');
      return;
    }
    setKind(nextKind);
    setScanAfterAdding(true);
    setError('');
  };

  const addFolder = async (folderPath?: string) => {
    if (!folderActionsAvailable) return;
    setBusy(true);
    setError('');
    try {
      const folder = await onAddFolder(kind, folderPath);
      if (!folder) return;
      setFolders((current) => current.some((entry) => entry.id === folder.id || entry.path === folder.path)
        ? current
        : [...current, folder]);
      setFolderPathInput('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The folder could not be added.');
    } finally {
      setBusy(false);
    }
  };

  const browseForFolder = async () => {
    if (!folderActionsAvailable) return;
    setBusy(true);
    setError('');
    try {
      const folderPath = await desktopApi.pickLibraryFolder(folderPathInput.trim() || undefined);
      if (folderPath) setFolderPathInput(folderPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The folder picker could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  const removeFolder = async (folder: WizardFolder) => {
    setRemovingId(folder.id);
    setError('');
    try {
      if (await onRemoveFolder(kind, folder) === false) return;
      setFolders((current) => current.filter((entry) => entry.id !== folder.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The folder could not be removed.');
    } finally {
      setRemovingId(null);
    }
  };

  const finish = async () => {
    if (folders.length === 0) {
      setError('Add a folder first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (scanAfterAdding && !videoLibrary) await onScan(kind);
      setComplete(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The library could not be scanned.');
    } finally {
      setBusy(false);
    }
  };

  const resetForAnother = () => {
    setComplete(false);
    setKind('movies');
    setFolders([]);
    setScanAfterAdding(true);
    setError('');
    setFolderPathInput('');
  };

  const closeDialog = () => onOpenChange(false);

  const typedPath = folderPathInput.trim();

  return (
    <SettingsDialog
      open={open}
      onClose={closeDialog}
      busy={busy || Boolean(removingId)}
      title={complete ? 'Library added' : 'Add a library'}
      description={complete ? undefined : 'Pick a library type, then add one or more folders.'}
      footer={complete ? (
        <>
          <Button size="sm" type="button" variant="outline" onClick={resetForAnother}>Add another</Button>
          <Button size="sm" type="button" onClick={closeDialog}>Done</Button>
        </>
      ) : (
        <>
          <Button size="sm" type="button" variant="outline" onClick={closeDialog} disabled={busy || Boolean(removingId)}>Cancel</Button>
          <Button size="sm" type="button" onClick={() => void finish()} disabled={busy || folders.length === 0}>
            {busy ? 'Adding…' : 'Add library'}
          </Button>
        </>
      )}
    >
      {complete ? (
        <div className="flex items-center gap-3 rounded-xl bg-[var(--loom-surface-2)] p-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--loom-surface-3)] text-[var(--loom-accent)]" aria-hidden="true">
            <LibraryTypeIcon kind={kind} active className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-[var(--loom-text)]">{selectedDefinition.label}</p>
            <p className="text-xs text-[var(--loom-muted)]">
              {folders.length.toLocaleString()} {folders.length === 1 ? 'folder' : 'folders'} added{videoLibrary || scanAfterAdding ? ' and scanned' : ''}.
            </p>
          </div>
          <CheckCircle2 className="h-5 w-5 shrink-0 settings-status-available" aria-hidden="true" />
        </div>
      ) : (
        <div className="space-y-4">
          <SettingsDialogField label="Library type" htmlFor="library-type" hint={folders.length > 0 ? 'Remove the folders to change the type.' : undefined}>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--loom-accent)]" aria-hidden="true">
                <LibraryTypeIcon kind={kind} active className="h-4 w-4" />
              </span>
              <select
                id="library-type"
                value={kind}
                onChange={(event) => selectKind(event.target.value as LibraryKind)}
                disabled={busy || folders.length > 0}
                className={`${SETTINGS_INPUT_CLASS} cursor-pointer appearance-none pl-9 pr-9`}
              >
                {VISIBLE_LIBRARY_TYPE_DEFINITIONS.map((definition) => (
                  <option key={definition.kind} value={definition.kind}>{definition.label}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)]" aria-hidden="true" />
            </div>
          </SettingsDialogField>

          <SettingsDialogField label="Folders" htmlFor="library-folder-path">
            {folders.length > 0 ? (
              <ul className="mb-2 divide-y divide-[color-mix(in_srgb,var(--loom-text)_8%,transparent)] overflow-hidden rounded-lg border border-[var(--loom-control-border)]">
                {folders.map((folder) => (
                  <li key={folder.id} className="flex h-10 items-center gap-2.5 pl-3 pr-1">
                    <FolderOpen className="h-4 w-4 shrink-0 text-[var(--loom-muted)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--loom-text)]" title={folder.path}>{folder.path}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => void removeFolder(folder)}
                      disabled={busy || removingId === folder.id}
                      aria-label={`Remove ${folder.name || folder.path}`}
                      className="settings-destructive-hover h-8 w-8 text-[var(--loom-muted)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-center gap-2">
              <input
                id="library-folder-path"
                value={folderPathInput}
                onChange={(event) => setFolderPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && typedPath) {
                    event.preventDefault();
                    void addFolder(typedPath);
                  }
                }}
                disabled={busy || !folderActionsAvailable}
                placeholder={folders.length ? 'Add another folder' : '/Volumes/Media/Movies'}
                spellCheck={false}
                className={`${SETTINGS_INPUT_CLASS} flex-1 font-mono text-xs`}
              />
              {typedPath ? (
                <Button size="sm" type="button" variant="outline" onClick={() => void addFolder(typedPath)} disabled={busy || !folderActionsAvailable} className="shrink-0 gap-1.5">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {busy ? 'Adding…' : 'Add'}
                </Button>
              ) : (
                <Button size="sm" type="button" variant="outline" onClick={() => void browseForFolder()} disabled={busy || !folderActionsAvailable} className="shrink-0 gap-1.5">
                  <FolderOpen className="h-4 w-4" aria-hidden="true" />
                  Browse
                </Button>
              )}
            </div>
          </SettingsDialogField>

          {!videoLibrary ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--loom-text)]">Scan after adding</span>
              <SettingsSwitch label="Scan after adding" checked={scanAfterAdding} onChange={setScanAfterAdding} />
            </div>
          ) : null}

          {!folderActionsAvailable ? <SettingsDialogMessage tone="warning">Folder picking is available in the Loom desktop app.</SettingsDialogMessage> : null}
          {error ? <SettingsDialogMessage>{error}</SettingsDialogMessage> : null}
        </div>
      )}
    </SettingsDialog>
  );
}
