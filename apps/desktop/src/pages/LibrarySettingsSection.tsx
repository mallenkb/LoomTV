import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, Clock, Download, FolderOpen, FolderPlus, GripVertical, HardDrive, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import SharedListHighlight from '@/components/SharedListHighlight';
import { normalizeOtherFolderIcon, OTHER_FOLDER_ICON_OPTIONS, otherFolderIconPair, otherFolderIconStorageKey, type OtherFolderIconId } from '@/components/OtherFolderIcons';
import type { SidebarNavItemId, SidebarOrderItem } from './Settings.helpers';
import type { LibraryFolderSection, LibraryFolderStatus } from './Settings.types';
import { otherFolderGroupForFolder, type OtherFolderGroups } from '@/lib/otherFolderGroups';
import { desktopApi } from '@/lib/desktopApi';

const AUTO_SYNC_OPTIONS = [
  { value: 6, label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every 24 hours' },
  { value: 72, label: 'Every 3 days' },
  { value: 168, label: 'Every 1 week' },
];

type LibrarySettingsSectionProps = {
  folderSections: LibraryFolderSection[];
  folderStatuses: LibraryFolderStatus[];
  addLibraryFolder: (kind: LibraryFolderSection['key']) => void;
  removeLibraryFolder: (folder: string) => void;
  customFolderNames: Record<string, string>;
  otherFolderGroups: OtherFolderGroups;
  onCreateOtherFolderGroup: (name: string, icon: OtherFolderIconId) => Promise<void>;
  onAddFolderToGroup: (groupId: string) => Promise<void>;
  onDeleteOtherFolderGroup: (groupId: string) => Promise<void>;
  onEditFolder: (folder: string, nextFolder: string, name: string, icon: OtherFolderIconId, kind: LibraryFolderSection['key'], groupId: string, newGroupName: string) => Promise<void>;
  otherFolderIcon: OtherFolderIconId;
  onOtherFolderIconChange: (icon: OtherFolderIconId) => void;
  sidebarOrderItems: SidebarOrderItem[];
  draggedSidebarItem: SidebarNavItemId | null;
  setDraggedSidebarItem: (item: SidebarNavItemId | null) => void;
  onSidebarOrderDrop: (targetId: SidebarNavItemId, position: 'before' | 'after') => void;
  moveSidebarItem: (itemId: SidebarNavItemId, direction: -1 | 1) => void;
  isScanning: boolean;
  scanProgress: number;
  movieCount: number;
  tvShowCount: number;
  animeCount: number;
  scanLibrary: () => void;
  refreshMetadata: () => void;
  fullRescanLibrary: () => void;
  autoSyncIntervalHours: number;
  setAutoSyncIntervalHours: (hours: number) => void | Promise<void>;
  backupStatus: string;
  clearDataStatus: string;
  isClearingData: boolean;
  libraryActionError?: string;
  onRetryLibraryAction?: () => void;
  onBackupDatabase: () => void;
  onClearAppData: () => void;
};

export default function LibrarySettingsSection({
  folderSections,
  folderStatuses,
  addLibraryFolder,
  removeLibraryFolder,
  customFolderNames,
  otherFolderGroups,
  onCreateOtherFolderGroup,
  onAddFolderToGroup,
  onDeleteOtherFolderGroup,
  onEditFolder,
  otherFolderIcon,
  sidebarOrderItems,
  draggedSidebarItem,
  setDraggedSidebarItem,
  onSidebarOrderDrop,
  moveSidebarItem,
  isScanning,
  scanProgress,
  movieCount,
  tvShowCount,
  animeCount,
  scanLibrary,
  refreshMetadata,
  fullRescanLibrary,
  autoSyncIntervalHours,
  setAutoSyncIntervalHours,
  backupStatus,
  clearDataStatus,
  isClearingData,
  libraryActionError,
  onRetryLibraryAction,
  onBackupDatabase,
  onClearAppData,
}: LibrarySettingsSectionProps) {
  const statusByPath = new Map(folderStatuses.map((status) => [status.path, status]));
  const problemCount = folderStatuses.filter((status) => status.state !== 'available').length;
  const networkFolderCount = folderStatuses.filter((status) => status.isNetworkLike).length;
  const [folderEditor, setFolderEditor] = useState<{
    folder: string;
    kind: LibraryFolderSection['key'];
    name: string;
    path: string;
    icon: OtherFolderIconId;
    groupId: string;
    newGroupName: string;
  } | null>(null);
  const [folderEditorError, setFolderEditorError] = useState('');
  const [isSavingFolder, setIsSavingFolder] = useState(false);
  const [isGroupCreatorOpen, setIsGroupCreatorOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupIcon, setNewGroupIcon] = useState<OtherFolderIconId>('folder');
  const [groupActionError, setGroupActionError] = useState('');
  const [busyGroupId, setBusyGroupId] = useState('');
  const [autoSyncMenuOpen, setAutoSyncMenuOpen] = useState(false);
  const [sidebarDropTarget, setSidebarDropTarget] = useState<{
    id: SidebarNavItemId;
    position: 'before' | 'after';
  } | null>(null);

  const canMoveSidebarItem = (itemId: SidebarNavItemId, direction: -1 | 1) => {
    const itemIndex = sidebarOrderItems.findIndex((entry) => entry.id === itemId);
    const nextIndex = itemIndex + direction;
    return itemId !== 'divider' && itemIndex >= 0 && nextIndex >= 0 && nextIndex < sidebarOrderItems.length;
  };

  const openFolderEditor = (folder: string, kind: LibraryFolderSection['key']) => {
    const defaultName = folder.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || folder;
    setFolderEditor({
      folder,
      kind,
      name: customFolderNames[folder] || defaultName,
      path: folder,
      icon: normalizeOtherFolderIcon(customFolderNames[otherFolderIconStorageKey(folder)] || otherFolderIcon),
      groupId: otherFolderGroupForFolder(otherFolderGroups, folder),
      newGroupName: '',
    });
    setFolderEditorError('');
  };

  const saveFolderEditor = async () => {
    if (!folderEditor) return;
    const nextPath = folderEditor.path.trim();
    if (!nextPath) {
      setFolderEditorError('Folder path is required.');
      return;
    }
    setIsSavingFolder(true);
    setFolderEditorError('');
    try {
      if (folderEditor.groupId === '__new__' && !folderEditor.newGroupName.trim()) {
        setFolderEditorError('Group name is required.');
        return;
      }
      await onEditFolder(
        folderEditor.folder,
        nextPath,
        folderEditor.name,
        folderEditor.icon,
        folderEditor.kind,
        folderEditor.groupId === '__new__' ? '' : folderEditor.groupId,
        folderEditor.groupId === '__new__' ? folderEditor.newGroupName : '',
      );
      setFolderEditor(null);
    } catch (error) {
      setFolderEditorError(error instanceof Error ? error.message : 'The folder could not be updated.');
    } finally {
      setIsSavingFolder(false);
    }
  };

  return (
    <>
      <Card className={`settings-panel relative ${autoSyncMenuOpen ? 'z-40' : 'z-0'}`}>
        <CardHeader>
          <CardTitle className="text-white">Scan Library</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Scans local files and fetches metadata from TMDB, TVmaze, TheTVDB, Jikan (MAL), and OMDb.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-sm text-[var(--loom-muted)]">
              Movies: {movieCount} &nbsp;|&nbsp; TV Shows: {tvShowCount} &nbsp;|&nbsp; Anime: {animeCount}
            </p>
            {isScanning && (
              <div className="space-y-2">
                <div className="w-full bg-[var(--loom-bg)] rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-[var(--loom-accent)] h-2 rounded-full transition-[width] duration-300"
                    style={{ width: `${Math.max(4, scanProgress)}%` }}
                  />
                </div>
                <p className="text-xs text-[var(--loom-muted)]">Syncing library… {scanProgress}%</p>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--loom-surface-2)] p-3">
              <div className="flex min-w-0 items-start gap-3">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--loom-accent)]" />
                <div>
                  <p className="text-sm font-semibold text-white">Automatic quick sync</p>
                  <p className="mt-0.5 text-xs text-[var(--loom-muted)]">Check for new or changed files, and refresh cached titles when metadata keys change.</p>
                </div>
              </div>
              <div
                className="relative w-48 shrink-0 text-sm"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setAutoSyncMenuOpen(false);
                }}
              >
                <button
                  type="button"
                  aria-label="Automatic quick sync interval"
                  aria-haspopup="listbox"
                  aria-expanded={autoSyncMenuOpen}
                  onClick={() => setAutoSyncMenuOpen((open) => !open)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setAutoSyncMenuOpen(false);
                  }}
                  className="flex h-10 w-full items-center justify-between rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 text-left font-medium text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-surface-3)] focus-visible:border-[var(--loom-accent)] focus-visible:outline-none"
                >
                  <span>{AUTO_SYNC_OPTIONS.find((option) => option.value === autoSyncIntervalHours)?.label || `${autoSyncIntervalHours} hours`}</span>
                  <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--loom-muted)] transition-transform ${autoSyncMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                {autoSyncMenuOpen ? (
                  <div
                    role="listbox"
                    aria-label="Automatic quick sync interval options"
                    className="absolute right-0 top-full z-50 mt-2 w-full overflow-hidden rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] p-1 text-[var(--loom-text)] shadow-xl"
                  >
                    <SharedListHighlight activeId={String(autoSyncIntervalHours)} className="loom-shared-highlight-menu">
                      {AUTO_SYNC_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="option"
                          aria-selected={option.value === autoSyncIntervalHours}
                          data-highlight-id={String(option.value)}
                          onClick={() => {
                            setAutoSyncMenuOpen(false);
                            void setAutoSyncIntervalHours(option.value);
                          }}
                          className="relative z-[1] flex w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:text-[var(--loom-active-text)]"
                        >
                          {option.label}
                        </button>
                      ))}
                    </SharedListHighlight>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={scanLibrary} disabled={isScanning} className="gap-2">
                <RefreshCw className={`w-4 h-4 ${isScanning ? 'loom-scan-spinner' : ''}`} />
                {isScanning ? 'Syncing…' : problemCount > 0 ? 'Retry incomplete folders' : 'Quick sync'}
              </Button>
              <Button onClick={refreshMetadata} disabled={isScanning} variant="outline" className="gap-2">
                Refresh metadata
              </Button>
              <Button onClick={fullRescanLibrary} disabled={isScanning} variant="outline" className="gap-2">
                Full rescan
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Library Folders</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Add local folders or OS-mounted NAS shares. Unavailable folders stay in your library until you reconnect or remove them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {libraryActionError ? (
            <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-3 text-sm text-red-100">
              <div className="flex min-w-0 items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <div className="min-w-0">
                  <p className="font-semibold">Library update failed</p>
                  <p className="mt-1 break-words text-red-100/85">{libraryActionError}</p>
                </div>
              </div>
              {onRetryLibraryAction ? (
                <Button type="button" variant="outline" onClick={onRetryLibraryAction} className="shrink-0 border-red-300/40 text-red-50 hover:bg-red-500/15">
                  Try again
                </Button>
              ) : null}
            </div>
          ) : null}
          {(networkFolderCount > 0 || problemCount > 0) && (
            <div className={`mb-4 rounded-lg border p-3 text-sm ${
              problemCount > 0
                ? 'settings-status-banner-warning border-amber-500/30 bg-amber-500/10 text-amber-100'
                : 'settings-status-banner-success border-emerald-500/25 bg-emerald-500/10 text-emerald-100'
            }`}
            >
              <div className="flex items-start gap-2">
                {problemCount > 0 ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <HardDrive className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <p>
                  {problemCount > 0
                    ? `${problemCount} folder${problemCount === 1 ? '' : 's'} could not complete the last health check or scan. Quick Sync preserves saved items and continues with healthy folders.`
                    : `${networkFolderCount} network-style folder${networkFolderCount === 1 ? '' : 's'} detected. Loom will route mobile playback through this desktop so phones do not need NAS access.`}
                </p>
              </div>
            </div>
          )}
          <div className="space-y-3">
            {folderSections.map((section) => (
              <div key={section.key} className="rounded-lg bg-[var(--loom-surface-2)] p-3">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">{section.title}</p>
                    <p className="text-xs text-[var(--loom-muted)]">{section.description}</p>
                  </div>
                  <Button variant="outline" onClick={() => {
                    if (section.key === 'others') {
                      setNewGroupName('');
                      setNewGroupIcon('folder');
                      setGroupActionError('');
                      setIsGroupCreatorOpen(true);
                    } else addLibraryFolder(section.key);
                  }} className="gap-2 shrink-0">
                    <FolderPlus className="w-4 h-4" />
                    {section.key === 'others' ? 'Add group' : 'Add folder'}
                  </Button>
                </div>

                {section.key === 'others' && Object.keys(otherFolderGroups).length > 0 ? (
                  <div className="mb-3 space-y-2">
                    {Object.entries(otherFolderGroups).map(([groupId, group]) => {
                      const GroupIcon = otherFolderIconPair(group.icon).outline;
                      const memberFolders = group.folders.filter((folder) => section.folders.includes(folder));
                      return (
                        <div key={groupId} className="rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-bg)] p-3">
                          <div className="flex items-center gap-3">
                            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--loom-surface-2)] text-[var(--loom-text)]"><GroupIcon className="h-5 w-5" /></span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-white">{group.name}</p>
                              <p className="text-xs text-[var(--loom-muted)]">{memberFolders.length} {memberFolders.length === 1 ? 'folder' : 'folders'}</p>
                            </div>
                            <Button type="button" variant="outline" className="h-9 gap-2 px-3" disabled={busyGroupId === groupId} onClick={() => {
                              setBusyGroupId(groupId);
                              setGroupActionError('');
                              void onAddFolderToGroup(groupId).catch((error) => setGroupActionError(error instanceof Error ? error.message : 'The folder could not be added.')).finally(() => setBusyGroupId(''));
                            }}><FolderPlus className="h-4 w-4" />{busyGroupId === groupId ? 'Adding…' : 'Add folder'}</Button>
                            <button type="button" title="Delete group" aria-label={`Delete ${group.name}`} className="p-2 text-red-500 hover:text-red-400" onClick={() => void onDeleteOtherFolderGroup(groupId)}><Trash2 className="h-4 w-4" /></button>
                          </div>
                          {memberFolders.length > 0 ? (
                            <div className="mt-3 divide-y divide-[var(--loom-border)] border-t border-[var(--loom-border)]">
                              {memberFolders.map((folder) => (
                                <div key={folder} className="flex items-center gap-3 py-2 pl-2 text-xs text-[var(--loom-muted)]">
                                  <span className="min-w-0 flex-1 truncate">{customFolderNames[folder] || folder}</span>
                                  <button type="button" onClick={() => openFolderEditor(folder, 'others')} aria-label={`Edit ${folder}`} className="p-1 hover:text-white"><Pencil className="h-4 w-4" /></button>
                                  <button type="button" onClick={() => removeLibraryFolder(folder)} aria-label={`Remove ${folder}`} className="p-1 text-red-500 hover:text-red-400"><X className="h-4 w-4" /></button>
                                </div>
                              ))}
                            </div>
                          ) : <p className="mt-3 text-xs text-[var(--loom-faint)]">No folders yet. Add one from this computer.</p>}
                        </div>
                      );
                    })}
                    {groupActionError ? <p role="alert" className="text-sm text-red-300">{groupActionError}</p> : null}
                  </div>
                ) : null}

                <div className="flex flex-col divide-y divide-[var(--loom-border)]">
                  {section.folders.length === 0 ? (
                    <p className="text-[var(--loom-faint)] text-sm py-2">No {section.title.toLowerCase()} folders added</p>
                  ) : (
                    section.folders.filter((folder) => section.key !== 'others' || !Object.values(otherFolderGroups).some((group) => group.folders.includes(folder))).map((folder) => (
                      <div key={folder} className="settings-folder-row flex items-center justify-between gap-3 rounded-lg px-3 py-3 text-sm text-white">
                        <div className="min-w-0 flex-1">
                          <span className="block truncate">{customFolderNames[folder] || folder}</span>
                          <FolderStatusLine status={statusByPath.get(folder)} />
                        </div>
                        <button type="button" onClick={() => openFolderEditor(folder, section.key)} aria-label={`Edit ${folder}`} title="Edit folder" className="p-1 text-[var(--loom-muted)] hover:text-white"><Pencil className="h-4 w-4" /></button>
                        <button
                          type="button"
                          onClick={() => removeLibraryFolder(folder)}
                          aria-label={`Remove ${customFolderNames[folder] || folder}`}
                          title="Remove folder"
                          className="text-red-500 hover:text-red-400 p-1 shrink-0"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(folderEditor)}
        onOpenChange={(open) => { if (!open && !isSavingFolder) setFolderEditor(null); }}
        contentClassName="max-w-md border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]"
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit folder</DialogTitle>
            <DialogDescription className="text-[var(--loom-muted)]">Change this folder's name, file path, and sidebar icon.</DialogDescription>
          </DialogHeader>
          {folderEditor ? (
            <form className="mt-6 space-y-5" onSubmit={(event) => { event.preventDefault(); void saveFolderEditor(); }}>
              <label className="flex flex-col gap-1.5 text-sm text-[var(--loom-text)]">
                Folder name
                <input autoFocus value={folderEditor.name} onChange={(event) => setFolderEditor({ ...folderEditor, name: event.target.value })} disabled={isSavingFolder} className="h-11 w-full rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-bg)] px-3 text-sm outline-none focus:border-[var(--loom-accent)] disabled:opacity-60" />
              </label>
              <label className="flex flex-col gap-1.5 text-sm text-[var(--loom-text)]">
                Folder path
                <span className="flex gap-2">
                  <input value={folderEditor.path} onChange={(event) => setFolderEditor({ ...folderEditor, path: event.target.value })} disabled={isSavingFolder} spellCheck={false} className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-bg)] px-3 font-mono text-xs outline-none focus:border-[var(--loom-accent)] disabled:opacity-60" />
                  <Button type="button" variant="outline" disabled={isSavingFolder} aria-label="Choose folder from computer" title="Browse folders" className="h-11 shrink-0 gap-2 px-3" onClick={() => {
                    void desktopApi.pickLibraryFolder(folderEditor.path).then((path) => {
                      if (path) setFolderEditor((current) => current ? { ...current, path } : current);
                    }).catch((error) => setFolderEditorError(error instanceof Error ? error.message : 'The folder picker could not be opened.'));
                  }}>
                    <FolderOpen className="h-4 w-4" />
                    Browse
                  </Button>
                </span>
              </label>
              {folderEditor.kind === 'others' ? (
                <>
                <label className="flex flex-col gap-1.5 text-sm text-[var(--loom-text)]">
                  Group
                  <select value={folderEditor.groupId} onChange={(event) => {
                    const groupId = event.target.value;
                    const groupIcon = groupId && groupId !== '__new__' ? otherFolderGroups[groupId]?.icon : undefined;
                    setFolderEditor({ ...folderEditor, groupId, icon: normalizeOtherFolderIcon(groupIcon || folderEditor.icon) });
                  }} disabled={isSavingFolder} className="h-11 w-full rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-bg)] px-3 text-sm outline-none focus:border-[var(--loom-accent)]">
                    <option value="">No group</option>
                    <option value="__new__">Create a new group</option>
                    {Object.entries(otherFolderGroups).map(([id, group]) => <option key={id} value={id}>{group.name}</option>)}
                  </select>
                </label>
                {folderEditor.groupId === '__new__' ? (
                  <label className="flex flex-col gap-1.5 text-sm text-[var(--loom-text)]">
                    Group name
                    <input value={folderEditor.newGroupName} onChange={(event) => setFolderEditor({ ...folderEditor, newGroupName: event.target.value })} disabled={isSavingFolder} className="h-11 w-full rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-bg)] px-3 text-sm outline-none focus:border-[var(--loom-accent)]" />
                  </label>
                ) : null}
                <fieldset disabled={isSavingFolder}>
                  <legend className="mb-3 text-sm font-medium">Folder icon</legend>
                  <div className="grid grid-cols-6 gap-2">
                    {OTHER_FOLDER_ICON_OPTIONS.map((option) => {
                      const selected = option.id === folderEditor.icon;
                      const Icon = selected ? option.solid : option.outline;
                      return (
                        <button key={option.id} type="button" aria-label={option.label} aria-pressed={selected} title={option.label} onClick={() => setFolderEditor({ ...folderEditor, icon: option.id })} className={`grid aspect-square place-items-center rounded-xl border transition-colors ${selected ? 'border-[var(--loom-accent)] bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] text-[var(--loom-muted)] hover:text-[var(--loom-text)]'}`}>
                          <Icon className="h-5 w-5" />
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
                </>
              ) : null}
              {folderEditorError ? <p role="alert" className="text-sm text-red-300">{folderEditorError}</p> : null}
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setFolderEditor(null)} disabled={isSavingFolder}>Cancel</Button>
                <Button type="submit" disabled={isSavingFolder}>{isSavingFolder ? 'Saving…' : 'Save changes'}</Button>
              </div>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={isGroupCreatorOpen} onOpenChange={setIsGroupCreatorOpen} contentClassName="max-w-md border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create custom library</DialogTitle>
            <DialogDescription className="text-[var(--loom-muted)]">Create a group first, then add as many folders as you want.</DialogDescription>
          </DialogHeader>
          <form className="mt-6 space-y-5" onSubmit={(event) => {
            event.preventDefault();
            if (!newGroupName.trim()) { setGroupActionError('Group name is required.'); return; }
            setBusyGroupId('__create__');
            setGroupActionError('');
            void onCreateOtherFolderGroup(newGroupName, newGroupIcon).then(() => setIsGroupCreatorOpen(false)).catch((error) => setGroupActionError(error instanceof Error ? error.message : 'The group could not be created.')).finally(() => setBusyGroupId(''));
          }}>
            <label className="flex flex-col gap-1.5 text-sm">Group name<input autoFocus value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="Children's Videos" className="h-11 rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-bg)] px-3 outline-none focus:border-[var(--loom-accent)]" /></label>
            <fieldset><legend className="mb-3 text-sm font-medium">Group icon</legend><div className="grid grid-cols-6 gap-2">{OTHER_FOLDER_ICON_OPTIONS.map((option) => { const selected = option.id === newGroupIcon; const Icon = selected ? option.solid : option.outline; return <button key={option.id} type="button" title={option.label} aria-label={option.label} aria-pressed={selected} onClick={() => setNewGroupIcon(option.id)} className={`grid aspect-square place-items-center rounded-xl border ${selected ? 'border-[var(--loom-accent)] bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] text-[var(--loom-muted)]'}`}><Icon className="h-5 w-5" /></button>; })}</div></fieldset>
            {groupActionError ? <p role="alert" className="text-sm text-red-300">{groupActionError}</p> : null}
            <div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setIsGroupCreatorOpen(false)}>Cancel</Button><Button type="submit" disabled={busyGroupId === '__create__'}>{busyGroupId === '__create__' ? 'Creating…' : 'Create group'}</Button></div>
          </form>
        </DialogContent>
      </Dialog>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Sidebar Order</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Drag sidebar destinations into the order you want. The divider is not draggable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 rounded-lg bg-[var(--loom-surface-2)] p-2">
            {sidebarOrderItems.map((item, index) => (
              <div
                key={item.id}
                draggable={item.id !== 'divider'}
                onDragStart={(event) => {
                  if (item.id === 'divider') {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', item.id);
                  setDraggedSidebarItem(item.id);
                }}
                onDragEnd={() => {
                  setDraggedSidebarItem(null);
                  setSidebarDropTarget(null);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const position = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
                  setSidebarDropTarget((current) => current?.id === item.id && current.position === position
                    ? current
                    : { id: item.id, position });
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSidebarDropTarget(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const position = sidebarDropTarget?.id === item.id ? sidebarDropTarget.position : 'before';
                  setSidebarDropTarget(null);
                  onSidebarOrderDrop(item.id, position);
                }}
                aria-grabbed={draggedSidebarItem === item.id}
                aria-disabled={item.id === 'divider'}
                className={`relative flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-[border-color,background-color,opacity,transform] ${
                  draggedSidebarItem === item.id
                    ? 'cursor-grabbing scale-[0.99] border-[var(--loom-accent)] bg-[var(--loom-accent)]/10 opacity-45'
                    : item.id === 'divider'
                      ? 'cursor-default select-none border-dashed border-[var(--loom-control-border)] bg-[var(--loom-surface-3)] opacity-50'
                      : 'cursor-grab border-[var(--loom-panel-border)] bg-[var(--loom-surface-2)] hover:border-[var(--loom-accent)]/35 active:cursor-grabbing'
                }`}
              >
                {sidebarDropTarget?.id === item.id && draggedSidebarItem !== item.id ? (
                  <span
                    className={`pointer-events-none absolute inset-x-2 z-20 h-0.5 rounded-full bg-[var(--loom-accent)] shadow-[0_0_12px_var(--loom-accent)] ${
                      sidebarDropTarget.position === 'before' ? '-top-[5px]' : '-bottom-[5px]'
                    }`}
                    aria-hidden="true"
                  >
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-[var(--loom-accent)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--loom-accent-foreground)] shadow-lg">
                      Drop here
                    </span>
                  </span>
                ) : null}
                {item.id === 'divider' ? (
                  <>
                    <span className="block h-4 w-4 shrink-0" aria-hidden="true" />
                    <span
                      className="h-6 w-6 shrink-0 rounded-lg bg-[var(--loom-surface-2)] ring-1 ring-inset ring-[var(--loom-control-border)]"
                      aria-hidden="true"
                    />
                  </>
                ) : (
                  <>
                    <GripVertical className="h-4 w-4 shrink-0 text-[var(--loom-faint)]" />
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[var(--loom-surface-3)] text-xs font-semibold text-[var(--loom-accent)]">
                      {sidebarOrderItems.slice(0, index + 1).filter((entry) => entry.id !== 'divider').length}
                    </span>
                  </>
                )}
                <span className={`min-w-0 flex-1 text-sm font-medium ${item.id === 'divider' ? 'text-[var(--loom-muted)]' : 'text-white'}`}>
                  {item.label}
                </span>
                {item.id !== 'divider' ? <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveSidebarItem(item.id, -1)}
                    disabled={!canMoveSidebarItem(item.id, -1)}
                    aria-label={`Move ${item.label} up`}
                    className="grid h-8 w-8 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSidebarItem(item.id, 1)}
                    disabled={!canMoveSidebarItem(item.id, 1)}
                    aria-label={`Move ${item.label} down`}
                    className="grid h-8 w-8 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </div> : null}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-[var(--loom-faint)]">
            Home and search stay pinned. Moving an item across the divider shifts the divider naturally in the list. Settings and refresh stay at the bottom.
          </p>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Data Management</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Back up the database or clear this device's local LoomTV data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3">
            <div className="settings-panel-soft rounded-xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Download className="h-4 w-4 text-[var(--loom-accent)]" />
                    Database Backup
                  </p>
                  <p className="mt-1 text-xs text-[var(--loom-muted)]">
                    Saves a copy of the local SQLite database with library metadata, artwork, progress, and settings.
                  </p>
                </div>
                <Button onClick={onBackupDatabase} variant="outline" className="gap-2">
                  <Download className="h-4 w-4" />
                  Back Up Database
                </Button>
              </div>
              {backupStatus && <p className="mt-3 min-w-0 truncate text-sm text-[var(--loom-muted)]">{backupStatus}</p>}
            </div>

            <div className="settings-destructive-panel rounded-xl border border-red-500/20 bg-red-500/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="settings-destructive-title flex items-center gap-2 text-sm font-semibold text-white">
                    <Trash2 className="h-4 w-4 text-red-400" />
                    Clear local app data
                  </p>
                  <p className="mt-1 text-xs text-[var(--loom-muted)]">
                    Removes saved library folders, scanned metadata, artwork, watch progress, and settings.
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={onClearAppData}
                  disabled={isClearingData}
                  variant="outline"
                  className="settings-destructive-button gap-2 border-red-500/25 bg-red-500/10 text-red-100 hover:border-red-400/40 hover:bg-red-500/20 hover:text-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                  {isClearingData ? 'Clearing…' : 'Clear data'}
                </Button>
              </div>
              {clearDataStatus && (
                <p
                  className={`mt-3 text-sm ${clearDataStatus.startsWith('Clear failed') ? 'text-red-200' : 'text-[var(--loom-muted)]'}`}
                  role={clearDataStatus.startsWith('Clear failed') ? 'alert' : 'status'}
                >
                  {clearDataStatus}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function FolderStatusLine({ status }: { status?: LibraryFolderStatus }) {
  if (!status) {
    return <span className="mt-1 block text-xs text-[var(--loom-faint)]">Checking folder status...</span>;
  }

  const available = status.state === 'available';
  const degraded = status.state === 'degraded';
  const Icon = available ? CheckCircle2 : AlertTriangle;
  const label = available
    ? status.isNetworkLike ? 'NAS available' : 'Available'
    : degraded ? 'Scan incomplete' : status.isNetworkLike ? 'Reconnect NAS share' : 'Folder unavailable';
  return (
    <span className={`mt-1 flex min-w-0 items-center gap-1.5 text-xs ${available ? 'settings-status-available' : 'settings-status-unavailable'}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 truncate text-[var(--loom-faint)]">{status.message}</span>
    </span>
  );
}
