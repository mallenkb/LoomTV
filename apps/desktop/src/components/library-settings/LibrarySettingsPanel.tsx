import { useCallback, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { CaretDown, DotsSixVertical } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronRight,
  Clock3,
  Download,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ConfirmProvider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLibrary } from '@/contexts/LibraryContext';
import { desktopApi } from '@/lib/desktopApi';
import type { SidebarNavItemId, SidebarOrderItem } from '@/pages/Settings.helpers';
import type { LibraryFolderSection, LibraryFolderStatus } from '@/pages/Settings.types';
import { normalizeOtherFolderIcon, otherFolderIconStorageKey, type OtherFolderIconId } from '@/components/OtherFolderIcons';
import { otherFolderGroupForFolder, type OtherFolderGroups } from '@/lib/otherFolderGroups';
import AddLibraryWizard, { type WizardFolder } from './AddLibraryWizard';
import {
  LIBRARY_TYPE_DEFINITIONS,
  LibraryTypeIcon,
  type LibraryKind,
} from './librarySettingsModel';

const AUTO_SYNC_OPTIONS = [
  { value: 6, label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every 24 hours' },
  { value: 72, label: 'Every 3 days' },
  { value: 168, label: 'Every 1 week' },
];

type LegacyLibraryKind = 'movies' | 'tvShows' | 'anime' | 'others';
const LIBRARY_SIDEBAR_IDS: Partial<Record<LibraryKind, SidebarNavItemId>> = {
  movies: 'movies',
  tvShows: 'tv',
  anime: 'anime',
};

type LibrarySettingsSectionProps = {
  folderSections: LibraryFolderSection[];
  folderStatuses: LibraryFolderStatus[];
  addLibraryFolder: (kind: LibraryFolderSection['key']) => void;
  removeLibraryFolder: (folder: string) => void | Promise<void>;
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


type UnifiedFolder = {
  id: string;
  path: string;
  name: string;
  count: number;
  scanning: boolean;
  state: 'available' | 'degraded' | 'unavailable';
  message: string | null;
  source: 'legacy';
  isNetworkLike?: boolean;
};

type UnifiedLibrary = {
  kind: LibraryKind;
  label: string;
  description: string;
  route?: string;
  folders: UnifiedFolder[];
  itemCount: number | null;
  scanning: boolean;
  status: 'ready' | 'empty' | 'degraded' | 'unavailable';
};

type EditingFolder = {
  folder: UnifiedFolder;
  name: string;
  path: string;
  icon: OtherFolderIconId;
  groupId: string;
};

function folderBaseName(folderPath: string): string {
  return folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || folderPath;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function notifyLibraryRootsChanged(): void {
  window.dispatchEvent(new Event('loomtv:library-roots-changed'));
}

function libraryStatusLabel(library: UnifiedLibrary): string {
  if (library.scanning) return 'Scanning';
  if (library.status === 'unavailable') return 'Folder unavailable';
  if (library.status === 'degraded') return 'Scan warning';
  if (library.status === 'empty') return 'Empty';
  return 'Ready';
}

function libraryStatusClass(library: UnifiedLibrary): string {
  if (library.scanning) return 'border-blue-400/30 bg-blue-400/10 text-blue-200';
  if (library.status === 'unavailable') return 'border-red-400/30 bg-red-400/10 text-red-200';
  if (library.status === 'degraded') return 'border-amber-400/30 bg-amber-400/10 text-amber-200';
  if (library.status === 'empty') return 'border-[var(--loom-panel-border)] bg-[var(--loom-surface-2)] text-[var(--loom-muted)]';
  return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200';
}

function folderStatusClass(folder: UnifiedFolder): string {
  if (folder.scanning) return 'border-blue-400/35 bg-blue-400/15 text-blue-100';
  if (folder.state === 'available') return 'border-emerald-400/35 bg-emerald-400/15 text-emerald-100';
  if (folder.state === 'degraded') return 'border-amber-400/35 bg-amber-400/15 text-amber-100';
  return 'border-red-400/35 bg-red-400/15 text-red-100';
}

function folderStatusLabel(folder: UnifiedFolder): string {
  if (folder.scanning) return 'Scanning';
  if (folder.state === 'degraded') return 'Scan incomplete';
  if (folder.state === 'unavailable') return folder.isNetworkLike ? 'Reconnect NAS share' : 'Folder unavailable';
  return folder.isNetworkLike ? 'NAS available' : 'Available';
}

function shouldIgnoreRowToggle(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('button, a, input, select, textarea, [role="button"]'));
}

export default function LibrarySettingsPanel({
  folderSections,
  folderStatuses,
  addLibraryFolder,
  removeLibraryFolder,
  customFolderNames,
  otherFolderGroups,
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
  const { addLibraryFolderPath, refreshLibrary } = useLibrary();
  const confirm = useConfirm();
  const [hideEmpty, setHideEmpty] = useState(false);
  const [expandedKind, setExpandedKind] = useState<LibraryKind | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busyKind, setBusyKind] = useState<LibraryKind | null>(null);
  const [actionError, setActionError] = useState('');
  const [editingFolder, setEditingFolder] = useState<EditingFolder | null>(null);
  const [editingError, setEditingError] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [sidebarDropTarget, setSidebarDropTarget] = useState<{ id: SidebarNavItemId; position: 'before' | 'after' } | null>(null);

  const statusByPath = useMemo(() => new Map(folderStatuses.map((status) => [status.path, status])), [folderStatuses]);

  const libraries = useMemo<UnifiedLibrary[]>(() => {
    const sidebarPositions = new Map(sidebarOrderItems.map((item, index) => [item.id, index]));
    return LIBRARY_TYPE_DEFINITIONS.map((definition) => {
      const legacySection = folderSections.find((section) => section.key === definition.kind);
      let folders: UnifiedFolder[] = [];
      let itemCount: number | null;

      if (legacySection) {
        folders = legacySection.folders.map((folder) => {
          const status = statusByPath.get(folder);
          return {
            id: folder,
            path: folder,
            name: customFolderNames[folder] || folderBaseName(folder),
            count: 0,
            scanning: false,
            state: status?.state || 'available',
            message: status?.message || null,
            source: 'legacy' as const,
            isNetworkLike: status?.isNetworkLike,
          };
        });
        itemCount = definition.kind === 'movies'
          ? movieCount
          : definition.kind === 'tvShows'
            ? tvShowCount
            : definition.kind === 'anime'
              ? animeCount
              : null;
      } else {
        itemCount = definition.kind === 'others' ? null : 0;
      }

      const status: UnifiedLibrary['status'] = folders.length === 0
        ? 'empty'
        : folders.some((folder) => folder.state === 'unavailable')
          ? 'unavailable'
          : folders.some((folder) => folder.state === 'degraded')
            ? 'degraded'
            : 'ready';
      return {
        kind: definition.kind,
        label: definition.label,
        description: definition.description,
        route: definition.route,
        folders,
        itemCount,
        scanning: folders.some((folder) => folder.scanning),
        status,
      };
    }).sort((left, right) => {
      const leftId = LIBRARY_SIDEBAR_IDS[left.kind];
      const rightId = LIBRARY_SIDEBAR_IDS[right.kind];
      const leftPosition = leftId ? sidebarPositions.get(leftId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      const rightPosition = rightId ? sidebarPositions.get(rightId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition;
    });
  }, [animeCount, customFolderNames, folderSections, movieCount, sidebarOrderItems, statusByPath, tvShowCount]);

  const filteredLibraries = useMemo(() => {
    return hideEmpty ? libraries.filter((library) => library.status !== 'empty') : libraries;
  }, [hideEmpty, libraries]);

  const refreshAll = refreshLibrary;

  const scanLibraryKind = useCallback(async (_kind: LibraryKind) => {
    scanLibrary();
    await refreshLibrary();
  }, [refreshLibrary, scanLibrary]);

  const addFolderForKind = useCallback(async (kind: LibraryKind, folderPath?: string): Promise<WizardFolder | null> => {
    const legacyKind = kind as LegacyLibraryKind;
    if (typeof window !== 'undefined' && window.desktopApi?.pickLibraryFolder && window.desktopApi?.addLibraryFolderPath) {
      const folder = folderPath || await desktopApi.pickLibraryFolder();
      if (!folder) return null;
      await addLibraryFolderPath(legacyKind, folder);
      await refreshLibrary();
      notifyLibraryRootsChanged();
      return { id: folder, path: folder, name: folderBaseName(folder) };
    }

    // The browser fallback owns folder selection inside the parent callback. It
    // does not return the selected path, so the review can only show a generic
    // entry until the renderer receives the refreshed catalog.
    await Promise.resolve(addLibraryFolder(legacyKind));
    await refreshLibrary();
    notifyLibraryRootsChanged();
    return { id: `legacy-${Date.now()}`, path: 'Folder selected', name: 'Folder selected' };
  }, [addLibraryFolder, addLibraryFolderPath, refreshLibrary]);

  const canAddFolder = (_kind: LibraryKind) => !desktopApi.isRemoteLibraryMode();

  const removeFolder = useCallback(async (_kind: LibraryKind, folder: UnifiedFolder | WizardFolder) => {
    const confirmed = await confirm({
      title: 'Remove this library folder?',
      description: `Remove "${folder.name || folder.path}" from the library. Files on disk will be kept.`,
      confirmLabel: 'Remove folder',
      destructive: true,
    });
    if (!confirmed) return false;
    if (folder.path === 'Folder selected') return;
    await removeLibraryFolder(folder.path);
    notifyLibraryRootsChanged();
  }, [confirm, removeLibraryFolder]);

  const runAction = async (kind: LibraryKind, action: () => Promise<void | boolean>, refreshAfter = true) => {
    setBusyKind(kind);
    setActionError('');
    try {
      if (await action() === false) return;
      if (refreshAfter) await refreshAll();
      notifyLibraryRootsChanged();
    } catch (cause) {
      setActionError(errorMessage(cause, 'The library could not be updated.'));
    } finally {
      setBusyKind(null);
    }
  };

  const addFromTable = async (kind: LibraryKind) => {
    await runAction(kind, async () => {
      await addFolderForKind(kind);
    });
  };

  const openFolderEditor = (folder: UnifiedFolder, kind: LibraryKind) => {
    if (folder.source !== 'legacy') return;
    const groupId = kind === 'others' ? otherFolderGroupForFolder(otherFolderGroups, folder.path) : '';
    setEditingFolder({
      folder,
      name: customFolderNames[folder.path] || folder.name,
      path: folder.path,
      icon: normalizeOtherFolderIcon(customFolderNames[otherFolderIconStorageKey(folder.path)] || otherFolderIcon),
      groupId,
    });
    setEditingError('');
  };

  const saveFolderEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingFolder) return;
    const path = editingFolder.path.trim();
    if (!path) {
      setEditingError('Folder path is required.');
      return;
    }
    setIsSavingEdit(true);
    setEditingError('');
    try {
      await onEditFolder(
        editingFolder.folder.path,
        path,
        editingFolder.name.trim(),
        editingFolder.icon,
        editingFolder.folder.source === 'legacy' ? (libraries.find((library) => library.folders.some((entry) => entry.id === editingFolder.folder.id))?.kind || 'others') as LegacyLibraryKind : 'others',
        editingFolder.groupId,
        '',
      );
      setEditingFolder(null);
      await refreshLibrary();
    } catch (cause) {
      setEditingError(errorMessage(cause, 'The folder could not be updated.'));
    } finally {
      setIsSavingEdit(false);
    }
  };

  const anyScanning = isScanning;
  const configuredCount = libraries.filter((library) => library.folders.length > 0).length;
  const totalItemCount = libraries.reduce((total, library) => total + (library.itemCount || 0), 0);

  return (
    <div className="space-y-6">
      <Card className="settings-panel">
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-white">Libraries</CardTitle>
            <CardDescription className="mt-2 max-w-2xl text-[var(--loom-muted)]">
              Manage every media folder in one place. Choose a type, then attach one or more folders.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-[var(--loom-muted)]">
              <input type="checkbox" checked={hideEmpty} onChange={(event) => setHideEmpty(event.target.checked)} className="h-4 w-4 accent-[var(--loom-accent)]" />
              Hide empty
            </label>
            <Button type="button" onClick={() => setWizardOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New library
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {(libraryActionError || actionError) ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-3 text-sm text-red-100">
              <span>{libraryActionError || actionError}</span>
              {libraryActionError && onRetryLibraryAction ? (
                <Button type="button" variant="outline" onClick={onRetryLibraryAction} className="shrink-0 border-red-300/40 text-red-50 hover:bg-red-500/15">Try again</Button>
              ) : null}
            </div>
          ) : null}


          <div className="space-y-2">
            {filteredLibraries.map((library) => {
              const expanded = expandedKind === library.kind;
              const busy = busyKind === library.kind;
              const sidebarItemId = LIBRARY_SIDEBAR_IDS[library.kind];
              const isDraggingCard = Boolean(sidebarItemId && draggedSidebarItem === sidebarItemId);
              const showDropLine = Boolean(
                sidebarDropTarget
                && sidebarItemId
                && sidebarDropTarget.id === sidebarItemId
                && draggedSidebarItem !== sidebarItemId,
              );
              const folderSummary = `${library.folders.length} ${library.folders.length === 1 ? 'folder' : 'folders'}`;
              const itemSummary = library.itemCount === null ? 'Mixed media' : `${library.itemCount.toLocaleString()} ${library.itemCount === 1 ? 'item' : 'items'}`;
              return (
                <motion.div
                  key={library.kind}
                  data-library-card
                  layout="position"
                  animate={isDraggingCard ? { x: 10, scale: 0.985, opacity: 0.48 } : { x: 0, scale: 1, opacity: 1 }}
                  transition={{
                    layout: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                    x: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
                    scale: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
                    opacity: { duration: 0.12 },
                  }}
                  onDragOver={(event) => {
                    if (!sidebarItemId || !draggedSidebarItem || draggedSidebarItem === sidebarItemId) return;
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const position = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
                    setSidebarDropTarget({ id: sidebarItemId, position });
                  }}
                  onDrop={(event) => {
                    if (!sidebarItemId || !draggedSidebarItem) return;
                    event.preventDefault();
                    const position = sidebarDropTarget?.id === sidebarItemId ? sidebarDropTarget.position : 'before';
                    setSidebarDropTarget(null);
                    onSidebarOrderDrop(sidebarItemId, position);
                  }}
                  className={`relative rounded-xl border bg-[var(--loom-panel)] transition-[border-color,box-shadow] ${isDraggingCard ? 'z-10 shadow-2xl shadow-black/35' : ''} ${expanded ? 'border-[var(--loom-control-border)]' : 'border-[var(--loom-panel-border)] hover:border-[var(--loom-control-border)]'}`}
                >
                  {showDropLine ? (
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-x-0 z-20 h-[3px] rounded-full bg-[var(--loom-text)] opacity-15 ${sidebarDropTarget?.position === 'before' ? '-top-[6px]' : '-bottom-[6px]'}`}
                    />
                  ) : null}
                  <div className="overflow-hidden rounded-[inherit]">
                    <div
                      draggable={Boolean(sidebarItemId)}
                      aria-grabbed={sidebarItemId ? isDraggingCard : undefined}
                      title={sidebarItemId ? 'Drag to reorder in the sidebar' : undefined}
                      onClick={(event) => {
                        if (shouldIgnoreRowToggle(event.target)) return;
                        setExpandedKind(expanded ? null : library.kind);
                      }}
                      onDragStart={(event) => {
                        if (!sidebarItemId) {
                          event.preventDefault();
                          return;
                        }
                        const target = event.target;
                        if (target instanceof Element && target.closest('[data-library-card-action]')) {
                          event.preventDefault();
                          return;
                        }
                        const card = event.currentTarget.closest<HTMLElement>('[data-library-card]');
                        if (card) {
                          const bounds = card.getBoundingClientRect();
                          event.dataTransfer.setDragImage(
                            card,
                            Math.max(0, event.clientX - bounds.left),
                            Math.max(0, event.clientY - bounds.top),
                          );
                        }
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', sidebarItemId);
                        setDraggedSidebarItem(sidebarItemId);
                      }}
                      onDragEnd={() => {
                        setDraggedSidebarItem(null);
                        setSidebarDropTarget(null);
                      }}
                      className={`flex min-h-[72px] flex-wrap items-center gap-2.5 px-4 py-3 sm:flex-nowrap ${isDraggingCard ? 'cursor-grabbing' : 'cursor-pointer'}`}
                    >
                      {sidebarItemId ? (
                        <button
                          type="button"
                          aria-label={`Reorder ${library.label} in the sidebar`}
                          aria-grabbed={isDraggingCard}
                          title="Use the arrow keys to reorder"
                          onKeyDown={(event) => {
                            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                            event.preventDefault();
                            event.stopPropagation();
                            moveSidebarItem(sidebarItemId, event.key === 'ArrowUp' ? -1 : 1);
                          }}
                          className="-ml-1 grid h-11 w-4 shrink-0 place-items-center rounded-md text-[var(--loom-faint)] hover:text-[var(--loom-text)]"
                        >
                          <DotsSixVertical className="h-4 w-4" weight="bold" aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="-ml-1 h-11 w-4 shrink-0" aria-hidden="true" />
                      )}
                      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--loom-surface-3)] ${expanded ? 'text-[var(--loom-accent)]' : 'text-[var(--loom-muted)]'}`}>
                        <LibraryTypeIcon kind={library.kind} active={expanded} className="h-5 w-5" />
                      </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-[var(--loom-text)]">{library.label}</span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--loom-muted)]">{folderSummary} · {itemSummary}</span>
                    </span>
                    <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${libraryStatusClass(library)}`}>
                      {libraryStatusLabel(library)}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
                      <Button type="button" variant="outline" size="sm" onClick={() => void addFromTable(library.kind)} disabled={busy || !canAddFolder(library.kind)} data-library-card-action className="gap-1.5">
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        Add folder
                      </Button>
                      <Button type="button" variant="secondary" size="icon" onClick={() => void runAction(library.kind, () => scanLibraryKind(library.kind))} disabled={anyScanning || busy || !library.folders.length || !canAddFolder(library.kind)} aria-label={`Scan ${library.label}`} title={`Scan ${library.label}`} data-library-card-action className="h-9 w-9 border border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] shadow-sm hover:border-[var(--loom-muted)]">
                        <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
                      </Button>
                      <button type="button" onClick={() => setExpandedKind(expanded ? null : library.kind)} aria-label={`${expanded ? 'Hide' : 'Show'} ${library.label} folders`} aria-expanded={expanded} data-library-card-action className="grid h-9 w-9 place-items-center rounded-lg text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]">
                        <ChevronRight className={`h-4 w-4 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                  <AnimatePresence initial={false}>
                    {expanded ? (
                      <motion.div
                        key={`${library.kind}-details`}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden border-t border-[var(--loom-border)] bg-[var(--loom-surface-2)]"
                      >
                        <div className="py-3 pl-[2.375rem] pr-4">
                          {library.folders.length > 0 ? (
                            <div className="divide-y divide-[var(--loom-border)] overflow-hidden rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-bg)]">
                              {library.folders.map((folder) => (
                                <div key={folder.id} className="flex min-h-12 flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                                  <FolderOpen className="h-4 w-4 shrink-0 text-[var(--loom-muted)]" aria-hidden="true" />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[var(--loom-text)]">{folder.name}</span>
                                    <code className="mt-0.5 block break-all text-[11px] leading-4 text-[var(--loom-faint)]">{folder.path}</code>
                                  </span>
                                  <span className="flex shrink-0 items-center gap-2">
                                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${folderStatusClass(folder)}`}>
                                      {folderStatusLabel(folder)}
                                    </span>
                                    {folder.state !== 'available' && folder.message ? <span className="max-w-72 truncate text-xs text-[var(--loom-muted)]" title={folder.message}>{folder.message}</span> : null}
                                  </span>
                                  {folder.source === 'legacy' ? (
                                    <Button type="button" variant="outline" size="icon" onClick={() => openFolderEditor(folder, library.kind)} aria-label={`Edit ${folder.name}`} title="Edit folder" className="h-8 w-8 border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]">
                                      <Pencil className="h-4 w-4" aria-hidden="true" />
                                    </Button>
                                  ) : null}
                                  <Button type="button" variant="outline" size="icon" onClick={() => void runAction(library.kind, () => removeFolder(library.kind, folder), false)} disabled={busy || folder.scanning} aria-label={`Remove ${folder.name}`} title="Remove folder" className="h-8 w-8 border-red-500/30 bg-red-500/10 text-red-200 hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-50">
                                    <X className="h-4 w-4" aria-hidden="true" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-[var(--loom-panel-border)] px-4 py-5 text-center text-sm text-[var(--loom-muted)]">No folders added yet. Use Add folder to choose one from this computer.</div>
                          )}
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                  </div>
                </motion.div>
              );
            })}
          </div>

          {filteredLibraries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--loom-panel-border)] px-4 py-8 text-center">
              <FolderOpen className="mx-auto h-8 w-8 text-[var(--loom-faint)]" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-[var(--loom-text)]">No configured libraries to show.</p>
              <p className="mt-1 text-sm text-[var(--loom-muted)]">Turn off Hide empty to see every library type.</p>
            </div>
          ) : null}

          <p className="text-center text-xs leading-relaxed text-[var(--loom-faint)]">Folders can be local paths or mounted NAS shares. Loom keeps the original files in place.</p>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader className="gap-1">
          <CardTitle className="text-base text-white">Library sync</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">{configuredCount} configured {configuredCount === 1 ? 'library' : 'libraries'} · {totalItemCount.toLocaleString()} indexed items</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {anyScanning ? (
            <div className="space-y-2 rounded-lg bg-[var(--loom-surface-2)] p-3">
              <div className="flex items-center justify-between gap-3 text-sm text-[var(--loom-muted)]"><span>Scanning library folders</span><span>{isScanning ? `${scanProgress}%` : 'In progress'}</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--loom-bg)]"><div className="h-full rounded-full bg-[var(--loom-accent)] transition-[width] duration-300" style={{ width: `${isScanning ? Math.max(4, scanProgress) : 35}%` }} /></div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--loom-surface-2)] p-3">
            <div className="flex min-w-0 items-start gap-3">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--loom-accent)]" aria-hidden="true" />
              <div><p className="text-sm font-semibold text-white">Automatic quick sync</p><p className="mt-0.5 text-xs text-[var(--loom-muted)]">Check for new or changed files on a schedule.</p></div>
            </div>
            <span className="relative block w-40 shrink-0">
              <select value={autoSyncIntervalHours} onChange={(event) => void setAutoSyncIntervalHours(Number(event.target.value))} aria-label="Automatic quick sync interval" className="h-10 w-full appearance-none rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] py-2 pl-4 pr-10 text-sm text-[var(--loom-text)] outline-none focus:border-[var(--loom-accent)]">
                {AUTO_SYNC_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <CaretDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)]" weight="regular" aria-hidden="true" />
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void runAction('movies', async () => { scanLibrary(); await refreshLibrary(); })} disabled={anyScanning} className="gap-2"><RefreshCw className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} aria-hidden="true" />{isScanning ? 'Syncing…' : 'Quick sync'}</Button>
            <Button type="button" onClick={() => void runAction('movies', async () => { refreshMetadata(); await refreshLibrary(); })} disabled={anyScanning} variant="outline">Refresh metadata</Button>
            <Button type="button" onClick={() => void runAction('movies', async () => { fullRescanLibrary(); await refreshLibrary(); })} disabled={anyScanning} variant="outline">Full rescan</Button>
          </div>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader className="gap-1"><CardTitle className="text-base text-white">Data management</CardTitle><CardDescription className="text-[var(--loom-muted)]">Back up the database or clear this device's local Loom data.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          <div className="settings-panel-soft rounded-xl p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="flex items-center gap-2 text-sm font-semibold text-white"><Download className="h-4 w-4 text-[var(--loom-accent)]" aria-hidden="true" />Database backup</p><p className="mt-1 text-xs text-[var(--loom-muted)]">Save a copy of library metadata, artwork, progress, and settings.</p></div><Button type="button" onClick={onBackupDatabase} variant="outline" className="gap-2"><Download className="h-4 w-4" aria-hidden="true" />Back up database</Button></div>{backupStatus ? <p className="mt-3 truncate text-sm text-[var(--loom-muted)]">{backupStatus}</p> : null}</div>
          <div className="settings-destructive-panel rounded-xl border border-red-500/20 bg-red-500/5 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="flex items-center gap-2 text-sm font-semibold text-white"><Trash2 className="h-4 w-4 text-red-400" aria-hidden="true" />Clear local app data</p><p className="mt-1 text-xs text-[var(--loom-muted)]">Remove saved folders, metadata, artwork, progress, and settings.</p></div><Button type="button" onClick={onClearAppData} disabled={isClearingData} variant="outline" className="gap-2 border-red-500/25 bg-red-500/10 text-red-100 hover:border-red-400/40 hover:bg-red-500/20 hover:text-red-50"><Trash2 className="h-4 w-4" aria-hidden="true" />{isClearingData ? 'Clearing…' : 'Clear data'}</Button></div>{clearDataStatus ? <p role={clearDataStatus.startsWith('Clear failed') ? 'alert' : 'status'} className={`mt-3 text-sm ${clearDataStatus.startsWith('Clear failed') ? 'text-red-200' : 'text-[var(--loom-muted)]'}`}>{clearDataStatus}</p> : null}</div>
        </CardContent>
      </Card>

      <AddLibraryWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        canAddFolder={canAddFolder}
        onAddFolder={addFolderForKind}
        onRemoveFolder={removeFolder}
      />

      <Dialog open={Boolean(editingFolder)} onOpenChange={(open) => { if (!open && !isSavingEdit) setEditingFolder(null); }} contentClassName="max-w-md border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]">
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[var(--loom-text)]">Edit folder</DialogTitle>
            <DialogDescription className="text-[var(--loom-muted)]">Change the display name or path for this folder.</DialogDescription>
          </DialogHeader>
          {editingFolder ? (
            <form className="mt-5 space-y-4" onSubmit={(event) => void saveFolderEditor(event)}>
              <label className="block text-sm text-[var(--loom-text)]">
                Folder name
                <input value={editingFolder.name} onChange={(event) => setEditingFolder((current) => current ? { ...current, name: event.target.value } : current)} disabled={isSavingEdit} className="mt-1.5 h-10 w-full rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 text-sm outline-none focus:border-[var(--loom-accent)]" />
              </label>
              <label className="block text-sm text-[var(--loom-text)]">
                Folder path
                <span className="mt-1.5 flex items-center gap-2">
                  <input value={editingFolder.path} onChange={(event) => setEditingFolder((current) => current ? { ...current, path: event.target.value } : current)} disabled={isSavingEdit} spellCheck={false} className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 font-mono text-xs outline-none focus:border-[var(--loom-accent)]" />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isSavingEdit}
                    className="h-10 shrink-0 gap-2"
                    onClick={() => {
                      void desktopApi.pickLibraryFolder(editingFolder.path)
                        .then((folder) => {
                          if (folder) setEditingFolder((current) => current ? { ...current, path: folder } : current);
                        })
                        .catch((cause) => setEditingError(errorMessage(cause, 'The folder picker could not be opened.')));
                    }}
                  >
                    <FolderOpen className="h-4 w-4" aria-hidden="true" />
                    Browse
                  </Button>
                </span>
              </label>
              {editingError ? <p role="alert" className="text-sm text-red-300">{editingError}</p> : null}
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setEditingFolder(null)} disabled={isSavingEdit}>Cancel</Button>
                <Button type="submit" disabled={isSavingEdit}>{isSavingEdit ? 'Saving…' : 'Save changes'}</Button>
              </div>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export type { LibrarySettingsSectionProps };
