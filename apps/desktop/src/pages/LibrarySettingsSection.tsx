import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, Clock, Download, FolderPlus, GripVertical, HardDrive, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import SharedListHighlight from '@/components/SharedListHighlight';
import { SIDEBAR_NAV_LABELS, type SidebarNavItemId } from './Settings.helpers';
import type { LibraryFolderSection, LibraryFolderStatus } from './Settings.types';

const AUTO_SYNC_OPTIONS = [
  { value: 6, label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every 24 hours' },
  { value: 48, label: 'Every 48 hours' },
  { value: 72, label: 'Every 3 days' },
  { value: 96, label: 'Every 4 days' },
  { value: 120, label: 'Every 5 days' },
  { value: 144, label: 'Every 6 days' },
  { value: 168, label: 'Every 1 week' },
];

type LibrarySettingsSectionProps = {
  folderSections: LibraryFolderSection[];
  folderStatuses: LibraryFolderStatus[];
  addLibraryFolder: (kind: LibraryFolderSection['key']) => void;
  removeLibraryFolder: (folder: string) => void;
  customFolderNames: Record<string, string>;
  onRenameFolder: (folder: string, name: string) => void;
  sidebarNavOrder: SidebarNavItemId[];
  draggedSidebarItem: SidebarNavItemId | null;
  setDraggedSidebarItem: (item: SidebarNavItemId | null) => void;
  onSidebarOrderDrop: (targetId: SidebarNavItemId) => void;
  moveSidebarItem: (itemId: SidebarNavItemId, direction: -1 | 1) => void;
  isScanning: boolean;
  scanProgress: number;
  movieCount: number;
  tvShowCount: number;
  animeCount: number;
  scanLibrary: () => void;
  refreshMetadata: () => void;
  fullRescanLibrary: () => void;
  refreshLibrary: () => void;
  autoSyncIntervalHours: number;
  setAutoSyncIntervalHours: (hours: number) => void | Promise<void>;
  backupStatus: string;
  clearDataStatus: string;
  isClearingData: boolean;
  onBackupDatabase: () => void;
  onClearAppData: () => void;
};

export default function LibrarySettingsSection({
  folderSections,
  folderStatuses,
  addLibraryFolder,
  removeLibraryFolder,
  customFolderNames,
  onRenameFolder,
  sidebarNavOrder,
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
  refreshLibrary,
  autoSyncIntervalHours,
  setAutoSyncIntervalHours,
  backupStatus,
  clearDataStatus,
  isClearingData,
  onBackupDatabase,
  onClearAppData,
}: LibrarySettingsSectionProps) {
  const statusByPath = new Map(folderStatuses.map((status) => [status.path, status]));
  const problemCount = folderStatuses.filter((status) => status.state !== 'available').length;
  const networkFolderCount = folderStatuses.filter((status) => status.isNetworkLike).length;
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [autoSyncMenuOpen, setAutoSyncMenuOpen] = useState(false);

  return (
    <>
      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Library Folders</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Add local folders or OS-mounted NAS shares. Unavailable folders stay in your library until you reconnect or remove them.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                  <Button variant="outline" onClick={() => addLibraryFolder(section.key)} className="gap-2 shrink-0">
                    <FolderPlus className="w-4 h-4" />
                    Add
                  </Button>
                </div>

                <div className="flex flex-col divide-y divide-[var(--loom-border)]">
                  {section.folders.length === 0 ? (
                    <p className="text-[var(--loom-faint)] text-sm py-2">No {section.title.toLowerCase()} folders added</p>
                  ) : (
                    section.folders.map((folder) => (
                      <div key={folder} className="settings-folder-row flex items-center justify-between gap-3 rounded-lg px-3 py-3 text-sm text-white">
                        <div className="min-w-0 flex-1">
                          {editingFolder === folder ? (
                            <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); onRenameFolder(folder, editingName); setEditingFolder(null); }}>
                              <input autoFocus value={editingName} onChange={(event) => setEditingName(event.target.value)} className="min-w-0 flex-1 rounded border border-[var(--loom-accent)] bg-[var(--loom-bg)] px-2 py-1 text-sm text-white outline-none" aria-label={`Rename ${folder}`} />
                              <button type="submit" className="text-[var(--loom-accent)]">Save</button>
                            </form>
                          ) : <span className="block truncate">{customFolderNames[folder] || folder}</span>}
                          <FolderStatusLine status={statusByPath.get(folder)} />
                        </div>
                        {editingFolder !== folder && <button type="button" onClick={() => { setEditingFolder(folder); setEditingName(customFolderNames[folder] || folder); }} aria-label={`Rename ${folder}`} className="p-1 text-[var(--loom-muted)] hover:text-white"><Pencil className="h-4 w-4" /></button>}
                        <button
                          type="button"
                          onClick={() => removeLibraryFolder(folder)}
                          aria-label={`Remove ${folder}`}
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

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Sidebar Order</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Drag the middle sidebar items into the order you want.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 rounded-lg bg-[var(--loom-surface-2)] p-2">
            {sidebarNavOrder.map((itemId, index) => (
              <div
                key={itemId}
                draggable
                onDragStart={() => setDraggedSidebarItem(itemId)}
                onDragEnd={() => setDraggedSidebarItem(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => onSidebarOrderDrop(itemId)}
                className={`flex cursor-grab items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors active:cursor-grabbing ${
                  draggedSidebarItem === itemId
                    ? 'border-[var(--loom-accent)] bg-[var(--loom-accent)]/10'
                    : 'border-[var(--loom-panel-border)] bg-[var(--loom-surface-2)] hover:border-[var(--loom-accent)]/35'
                }`}
              >
                <GripVertical className="h-4 w-4 shrink-0 text-[var(--loom-faint)]" />
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[var(--loom-surface-3)] text-xs font-semibold text-[var(--loom-accent)]">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium text-white">
                  {SIDEBAR_NAV_LABELS[itemId]}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveSidebarItem(itemId, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${SIDEBAR_NAV_LABELS[itemId]} up`}
                    className="grid h-8 w-8 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSidebarItem(itemId, 1)}
                    disabled={index === sidebarNavOrder.length - 1}
                    aria-label={`Move ${SIDEBAR_NAV_LABELS[itemId]} down`}
                    className="grid h-8 w-8 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-[var(--loom-faint)]">
            Home stays pinned first. Settings and refresh stay pinned at the bottom.
          </p>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Scan Library</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Scans local files and fetches metadata from TMDB, TVmaze, Jikan (MAL), and OMDb.
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
                <p className="text-xs text-[var(--loom-muted)]">Syncing library progressively... {scanProgress}%</p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={scanLibrary} disabled={isScanning} className="gap-2">
                <RefreshCw className={`w-4 h-4 ${isScanning ? 'loom-scan-spinner' : ''}`} />
                {isScanning ? 'Syncing...' : problemCount > 0 ? 'Retry Incomplete Folders' : 'Quick Sync'}
              </Button>
              <Button onClick={refreshMetadata} disabled={isScanning} variant="outline" className="gap-2">
                Refresh Metadata
              </Button>
              <Button onClick={fullRescanLibrary} disabled={isScanning} variant="outline" className="gap-2">
                Full Rescan
              </Button>
              <Button onClick={refreshLibrary} variant="outline" className="gap-2">
                Refresh
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-[var(--loom-accent)]" />
            Automatic Sync
          </CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Automatically refreshes your local files and metadata while LoomTV is open.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <div
              className="relative min-w-56 text-sm"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setAutoSyncMenuOpen(false);
              }}
            >
              <Clock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-accent)]" />
              <button
                type="button"
                aria-label="Automatic sync interval"
                aria-haspopup="listbox"
                aria-expanded={autoSyncMenuOpen}
                onClick={() => setAutoSyncMenuOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setAutoSyncMenuOpen(false);
                }}
                className="flex h-11 w-full items-center rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] pl-9 pr-10 text-left font-medium text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-surface-2)] focus-visible:outline-none"
              >
                {AUTO_SYNC_OPTIONS.find((option) => option.value === autoSyncIntervalHours)?.label || `${autoSyncIntervalHours} hours`}
              </button>
              <ChevronDown className={`pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-[var(--loom-muted)] transition-transform ${autoSyncMenuOpen ? 'rotate-180' : ''}`} />
              {autoSyncMenuOpen ? (
                <div
                  role="listbox"
                  aria-label="Automatic sync interval options"
                  className="absolute left-0 top-full z-30 mt-2 max-h-64 w-full overflow-y-auto rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] p-1 text-[var(--loom-text)]"
                >
                  <SharedListHighlight activeId={String(autoSyncIntervalHours)} className="loom-shared-highlight-menu">
                  {AUTO_SYNC_OPTIONS.map((option) => {
                    const selected = option.value === autoSyncIntervalHours;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        data-shared-highlight-item
                        data-shared-highlight-id={String(option.value)}
                        onClick={() => {
                          void setAutoSyncIntervalHours(option.value);
                          setAutoSyncMenuOpen(false);
                        }}
                        className={`relative z-10 flex w-full items-center rounded-md px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${selected ? 'font-semibold' : ''}`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                  </SharedListHighlight>
                </div>
              ) : null}
            </div>
            <p className="text-sm text-[var(--loom-muted)]">
              Current interval: {AUTO_SYNC_OPTIONS.find((option) => option.value === autoSyncIntervalHours)?.label.toLowerCase() || `${autoSyncIntervalHours} hours`}
            </p>
          </div>
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
                    Clear App Data
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
                  {isClearingData ? 'Clearing...' : 'Clear Data'}
                </Button>
              </div>
              {clearDataStatus && <p className="mt-3 text-sm text-[var(--loom-muted)]">{clearDataStatus}</p>}
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
