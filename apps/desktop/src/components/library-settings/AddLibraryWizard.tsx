import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, FolderOpen, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { desktopApi } from '@/lib/desktopApi';
import {
  LIBRARY_TYPE_DEFINITIONS,
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
};


export default function AddLibraryWizard({
  open,
  onOpenChange,
  canAddFolder,
  onAddFolder,
  onRemoveFolder,
}: AddLibraryWizardProps) {
  const [kind, setKind] = useState<LibraryKind>('movies');
  const [folders, setFolders] = useState<WizardFolder[]>([]);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const [folderPathInput, setFolderPathInput] = useState('');

  useEffect(() => {
    if (!open) return;
    setKind('movies');
    setFolders([]);
    setBusy(false);
    setRemovingId(null);
    setError('');
    setComplete(false);
    setFolderPathInput('');
  }, [open]);

  const selectedDefinition = LIBRARY_TYPE_DEFINITIONS.find((definition) => definition.kind === kind)
    || LIBRARY_TYPE_DEFINITIONS[0];
  const folderActionsAvailable = canAddFolder(kind);

  const selectKind = (nextKind: LibraryKind) => {
    if (nextKind === kind) return;
    if (folders.length > 0) {
      setError('Remove the folder first to change the library type.');
      return;
    }
    setKind(nextKind);
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
    setError('');
    setFolderPathInput('');
  };

  const closeDialog = () => onOpenChange(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!busy && !removingId) onOpenChange(nextOpen); }}
      contentClassName="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-4 text-[var(--loom-text)] sm:p-5"
    >
      <DialogContent className="space-y-4">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg text-[var(--loom-text)]">{complete ? 'Library added' : 'Add a library'}</DialogTitle>
          <DialogDescription className="text-[var(--loom-muted)]">
            {complete ? 'Your folders are ready in Libraries.' : 'Choose a type and folder.'}
          </DialogDescription>
        </DialogHeader>

        {complete ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-emerald-400/25 bg-emerald-400/10 p-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--loom-text)]">{selectedDefinition.label}</p>
                <p className="mt-1 text-sm text-[var(--loom-muted)]">
                  The folders were added and scanned.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={resetForAnother}>Add another</Button>
              <Button type="button" onClick={closeDialog}>Done</Button>
            </div>
          </div>
        ) : (
          <>
            <section aria-labelledby="library-type-heading" className="space-y-2.5">
              <label id="library-type-heading" htmlFor="library-type" className="block text-sm font-medium text-[var(--loom-text)]">
                Library type
              </label>
              <div className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--loom-surface-3)] text-[var(--loom-accent)]" aria-hidden="true">
                  <LibraryTypeIcon kind={kind} active className="h-5 w-5" />
                </span>
                <div className="relative min-w-0 flex-1">
                  <select
                    id="library-type"
                    value={kind}
                    onChange={(event) => selectKind(event.target.value as LibraryKind)}
                    disabled={busy || folders.length > 0}
                    className="h-10 w-full appearance-none rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 py-2 pr-9 text-sm text-[var(--loom-text)] outline-none focus:border-[var(--loom-accent)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {LIBRARY_TYPE_DEFINITIONS.map((definition) => (
                      <option key={definition.kind} value={definition.kind}>{definition.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)]" aria-hidden="true" />
                </div>
              </div>
              {folders.length > 0 ? <p className="text-xs text-[var(--loom-faint)]">Remove the folder to change type.</p> : null}
            </section>

            <section aria-labelledby="library-folder-heading" className="space-y-2.5">
              <label id="library-folder-heading" htmlFor="library-folder-path" className="block text-sm font-medium text-[var(--loom-text)]">
                Folder
              </label>
              {folders.length > 0 ? (
                <div className="space-y-1.5">
                  {folders.map((folder) => (
                    <div key={folder.id} className="flex items-center gap-2 rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-surface-2)] px-3 py-2">
                      <FolderOpen className="h-4 w-4 shrink-0 text-[var(--loom-muted)]" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-sm text-[var(--loom-text)]" title={folder.path}>{folder.name || folder.path}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => void removeFolder(folder)}
                        disabled={busy || removingId === folder.id}
                        aria-label={`Remove ${folder.name || folder.path}`}
                        className="h-7 w-7 text-[var(--loom-muted)] hover:bg-red-500/15 hover:text-red-200"
                      >
                        {removingId === folder.id ? <span className="block h-3.5 w-3.5 animate-pulse" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <input
                  id="library-folder-path"
                  value={folderPathInput}
                  onChange={(event) => setFolderPathInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && folderPathInput.trim()) {
                      event.preventDefault();
                      void addFolder(folderPathInput.trim());
                    }
                  }}
                  disabled={busy || !folderActionsAvailable}
                  placeholder="/Volumes/Media"
                  spellCheck={false}
                  className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 font-mono text-xs text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)] disabled:cursor-not-allowed disabled:opacity-60"
                />
                <Button type="button" variant="outline" onClick={() => void browseForFolder()} disabled={busy || !folderActionsAvailable} className="h-10 shrink-0 gap-1.5">
                  <FolderOpen className="h-4 w-4" aria-hidden="true" />
                  Browse
                </Button>
              </div>
              <Button type="button" variant="outline" onClick={() => void addFolder(folderPathInput.trim())} disabled={busy || !folderActionsAvailable || !folderPathInput.trim()} className="h-9 w-full gap-1.5">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {busy ? 'Adding folder…' : 'Add folder'}
              </Button>
              {!folderActionsAvailable ? <p role="alert" className="text-xs text-amber-200">Folder picking is available in the Loom desktop app.</p> : null}
            </section>



            {error ? <p role="alert" className="rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p> : null}

            <div className="flex justify-end gap-2 border-t border-[var(--loom-border)] pt-4">
              <Button type="button" variant="outline" onClick={closeDialog} disabled={busy || Boolean(removingId)}>Cancel</Button>
              <Button type="button" onClick={() => void finish()} disabled={busy || folders.length === 0}>
                {busy ? 'Adding…' : 'Add library'}
              </Button>
            </div>
          </>
        )}

        <button type="button" onClick={closeDialog} disabled={busy || Boolean(removingId)} aria-label="Close add library" className="absolute right-3 top-3 rounded-full p-2 text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)] hover:text-[var(--loom-text)] disabled:opacity-50">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </DialogContent>
    </Dialog>
  );
}
