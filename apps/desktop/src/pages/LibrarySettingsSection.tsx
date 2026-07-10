import { AlertTriangle, CheckCircle2, ChevronDown, Clock, FolderPlus, HardDrive, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
};

export default function LibrarySettingsSection({
  folderSections,
  folderStatuses,
  addLibraryFolder,
  removeLibraryFolder,
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
}: LibrarySettingsSectionProps) {
  const statusByPath = new Map(folderStatuses.map((status) => [status.path, status]));
  const unavailableCount = folderStatuses.filter((status) => status.state === 'unavailable').length;
  const networkFolderCount = folderStatuses.filter((status) => status.isNetworkLike).length;

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
          {(networkFolderCount > 0 || unavailableCount > 0) && (
            <div className={`mb-4 rounded-lg border p-3 text-sm ${
              unavailableCount > 0
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'
            }`}
            >
              <div className="flex items-start gap-2">
                {unavailableCount > 0 ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <HardDrive className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <p>
                  {unavailableCount > 0
                    ? `${unavailableCount} folder${unavailableCount === 1 ? '' : 's'} need to be reconnected. Quick Sync will preserve their saved items and continue with available folders.`
                    : `${networkFolderCount} network-style folder${networkFolderCount === 1 ? '' : 's'} detected. Loom will route mobile playback through this desktop so phones do not need NAS access.`}
                </p>
              </div>
            </div>
          )}
          <div className="space-y-3">
            {folderSections.map((section) => (
              <div key={section.key} className="rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">{section.title}</p>
                    <p className="text-xs text-[var(--loom-muted)]">{section.description}</p>
                  </div>
                  <Button onClick={() => addLibraryFolder(section.key)} variant="outline" className="gap-2 shrink-0">
                    <FolderPlus className="w-4 h-4" />
                    Add folder
                  </Button>
                </div>

                <div className="flex flex-col gap-2">
                  {section.folders.length === 0 ? (
                    <p className="text-[var(--loom-faint)] text-sm py-2">No {section.title.toLowerCase()} folders added</p>
                  ) : (
                    section.folders.map((folder) => (
                      <div key={folder} className="settings-panel-soft flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-white">
                        <div className="min-w-0 flex-1">
                          <span className="block truncate">{folder}</span>
                          <FolderStatusLine status={statusByPath.get(folder)} />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLibraryFolder(folder)}
                          aria-label={`Remove ${folder}`}
                          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
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
                <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
                {isScanning ? 'Syncing...' : unavailableCount > 0 ? 'Sync Available Folders' : 'Quick Sync'}
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
            Automatically refreshes your local files and metadata while Loom Media Server is open.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <label className="relative inline-flex h-11 min-w-56 items-center rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] text-sm text-white transition-colors focus-within:border-[var(--loom-accent)]">
              <Clock className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--loom-accent)]" />
              <select
                value={autoSyncIntervalHours}
                onChange={(event) => void setAutoSyncIntervalHours(Number(event.target.value))}
                aria-label="Automatic sync interval"
                className="h-full w-full cursor-pointer appearance-none rounded-lg bg-transparent py-0 pl-9 pr-10 text-sm font-medium text-white outline-none"
              >
                {AUTO_SYNC_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-[var(--loom-muted)]" />
            </label>
            <p className="text-sm text-[var(--loom-muted)]">
              Current interval: {AUTO_SYNC_OPTIONS.find((option) => option.value === autoSyncIntervalHours)?.label.toLowerCase() || `${autoSyncIntervalHours} hours`}
            </p>
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
  const Icon = available ? CheckCircle2 : AlertTriangle;
  const label = available
    ? status.isNetworkLike ? 'NAS available' : 'Available'
    : status.isNetworkLike ? 'Reconnect NAS share' : 'Folder unavailable';
  return (
    <span className={`mt-1 flex min-w-0 items-center gap-1.5 text-xs ${available ? 'text-emerald-300' : 'text-amber-300'}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 truncate text-[var(--loom-faint)]">{status.message}</span>
    </span>
  );
}
