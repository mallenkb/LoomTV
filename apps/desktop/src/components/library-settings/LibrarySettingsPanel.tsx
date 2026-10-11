import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { DotsSixVertical } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronRight,
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
import { SettingsBadge, SettingsGroup, useSettingsAccordion, SettingsNote, SettingsPageHeader, SettingsRow, SettingsSelect } from '@/components/settings/SettingsLayout';
import { SETTINGS_INPUT_CLASS, SettingsDialog, SettingsDialogField, SettingsDialogMessage } from '@/components/settings/SettingsDialog';
import { useLibrary } from '@/contexts/LibraryContext';
import { useProfiles } from '@/contexts/ProfileContext';
import { desktopApi } from '@/lib/desktopApi';
import { usePhotoLibrary } from '@/lib/photoLibrary';
import type { MediaLibraryKind, MediaLibraryRoot } from '@/shared/mediaLibraries';
import { MEDIA_LIBRARY_KINDS } from '@/shared/mediaLibraries';
import type { PhotoRoot } from '@/shared/photoLibrary';
import type { SidebarNavItemId, SidebarOrderItem } from '@/pages/Settings.helpers';
import type { LibraryFolderSection, LibraryFolderStatus } from '@/pages/Settings.types';
import { normalizeOtherFolderIcon, otherFolderIconStorageKey, type OtherFolderIconId } from '@/components/OtherFolderIcons';
import { otherFolderGroupForFolder, type OtherFolderGroups } from '@/lib/otherFolderGroups';
import AddLibraryWizard, { type WizardFolder } from './AddLibraryWizard';
import OrganizeFilesSection from './OrganizeFilesSection';
import OriginalImportsSection from './OriginalImportsSection';
import LibraryCleanupSection from './LibraryCleanupSection';
import LibraryHealthCard from './LibraryHealthCard';
import {
  VISIBLE_LIBRARY_TYPE_DEFINITIONS,
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
  photos: 'photos',
  music: 'music',
  audiobooks: 'audiobooks',
  books: 'books',
  comics: 'comics',
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

type MediaRoots = Record<MediaLibraryKind, MediaLibraryRoot[]>;

type UnifiedFolder = {
  id: string;
  path: string;
  name: string;
  count: number;
  scanning: boolean;
  state: 'available' | 'degraded' | 'unavailable';
  message: string | null;
  source: 'legacy' | 'media' | 'photo';
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

function emptyMediaRoots(): MediaRoots {
  return Object.fromEntries(MEDIA_LIBRARY_KINDS.map((kind) => [kind, []])) as unknown as MediaRoots;
}

function isMediaLibraryKind(kind: LibraryKind): kind is MediaLibraryKind {
  return (MEDIA_LIBRARY_KINDS as readonly string[]).includes(kind);
}

function folderBaseName(folderPath: string): string {
  return folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || folderPath;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function notifyLibraryRootsChanged(): void {
  window.dispatchEvent(new Event('loomtv:library-roots-changed'));
}

async function waitForScanCompletion(
  readRoots: () => Promise<Array<{ id: string; scanning: boolean; message?: string | null }>>,
  rootId: string,
): Promise<void> {
  while (true) {
    const root = (await readRoots()).find((entry) => entry.id === rootId);
    if (!root) return;
    if (!root.scanning) {
      if (root.message) throw new Error(root.message);
      return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
  }
}

function useMediaLibraryRoots() {
  const api = typeof window !== 'undefined' ? window.desktopApi?.mediaLibraries : undefined;
  const { activeProfile } = useProfiles();
  const canRead = activeProfile?.type === 'owner' && !desktopApi.isRemoteLibraryMode();
  const [roots, setRoots] = useState<MediaRoots>(() => emptyMediaRoots());
  const [loading, setLoading] = useState(Boolean(api));
  const [error, setError] = useState('');

  const refresh = useCallback(async (background = false) => {
    if (!canRead) {
      setRoots(emptyMediaRoots());
      setLoading(false);
      return;
    }
    if (!background) setLoading(true);
    const entries = await Promise.all(MEDIA_LIBRARY_KINDS.map(async (kind) => [kind, await desktopApi.getMediaRoots(kind)] as const));
    setRoots(Object.fromEntries(entries) as MediaRoots);
    setError('');
    setLoading(false);
  }, [canRead]);

  useEffect(() => {
    let active = true;
    void refresh().catch((cause) => {
      if (!active) return;
      setError(errorMessage(cause, 'Media libraries could not be loaded.'));
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  const scanning = MEDIA_LIBRARY_KINDS.some((kind) => roots[kind].some((root) => root.scanning));
  useEffect(() => {
    if (!canRead) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(true).catch(() => setLoading(false));
    }, scanning ? 1200 : 3000);
    return () => window.clearInterval(timer);
  }, [canRead, refresh, scanning]);

  return { api, roots, loading, error, refresh, scanning };
}

function libraryStatusLabel(library: UnifiedLibrary): string {
  if (library.scanning) return 'Scanning';
  if (library.status === 'unavailable') return 'Folder unavailable';
  if (library.status === 'degraded') return 'Scan warning';
  if (library.status === 'empty') return 'Empty';
  return 'Ready';
}

function libraryStatusTone(library: UnifiedLibrary): 'muted' | 'warning' | 'error' | 'ok' {
  if (library.scanning) return 'muted';
  if (library.status === 'unavailable') return 'error';
  if (library.status === 'degraded') return 'warning';
  return 'ok';
}

function folderStatusTone(folder: UnifiedFolder): 'muted' | 'warning' | 'error' | 'ok' {
  if (folder.scanning) return 'muted';
  if (folder.state === 'available') return 'ok';
  if (folder.state === 'degraded') return 'warning';
  return 'error';
}

function folderStatusLabel(folder: UnifiedFolder): string {
  if (folder.scanning) return 'Scanning';
  if (folder.state === 'degraded') return 'Scan incomplete';
  if (folder.state === 'unavailable') return folder.isNetworkLike ? 'Network folder unavailable' : 'Folder unavailable';
  return 'Available';
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
  const photoLibrary = usePhotoLibrary();
  const mediaLibraries = useMediaLibraryRoots();
  const [hideEmpty, setHideEmpty] = useState(false);
  const accordion = useSettingsAccordion();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busyKind, setBusyKind] = useState<LibraryKind | null>(null);
  const [scanningAll, setScanningAll] = useState(false);
  const [actionError, setActionError] = useState('');
  const [editingFolder, setEditingFolder] = useState<EditingFolder | null>(null);
  const [editingError, setEditingError] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [sidebarDropTarget, setSidebarDropTarget] = useState<{ id: SidebarNavItemId; position: 'before' | 'after' } | null>(null);

  // Library rows share the page's accordion, so opening one closes any other.
  const toggleExpandedKind = (kind: LibraryKind) => {
    const id = `library:${kind}`;
    accordion.setOpenId(accordion.openId === id ? null : id);
  };

  const statusByPath = useMemo(() => new Map(folderStatuses.map((status) => [status.path, status])), [folderStatuses]);

  const libraries = useMemo<UnifiedLibrary[]>(() => {
    const sidebarPositions = new Map(sidebarOrderItems.map((item, index) => [item.id, index]));
    return VISIBLE_LIBRARY_TYPE_DEFINITIONS.map((definition) => {
      const legacySection = folderSections.find((section) => section.key === definition.kind);
      let folders: UnifiedFolder[] = [];
      let itemCount: number | null;

      if (definition.kind === 'photos') {
        folders = photoLibrary.roots.map((root: PhotoRoot) => ({
          id: root.id,
          path: root.path,
          name: root.name,
          count: root.count,
          scanning: root.scanning,
          state: root.state,
          message: root.message,
          source: 'photo' as const,
        }));
        itemCount = folders.reduce((total, folder) => total + folder.count, 0);
      } else if (isMediaLibraryKind(definition.kind)) {
        folders = mediaLibraries.roots[definition.kind].map((root) => ({
          id: root.id,
          path: root.path,
          name: root.name,
          count: root.count,
          scanning: root.scanning,
          state: root.message ? 'degraded' : 'available',
          message: root.message,
          source: 'media' as const,
        }));
        itemCount = folders.reduce((total, folder) => total + folder.count, 0);
      } else if (legacySection) {
        folders = legacySection.folders.map((folder) => {
          const status = statusByPath.get(folder);
          return {
            id: folder,
            path: folder,
            name: customFolderNames[folder] || folderBaseName(folder),
            count: 0,
            scanning: isScanning,
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
  }, [animeCount, customFolderNames, folderSections, isScanning, mediaLibraries.roots, movieCount, photoLibrary.roots, sidebarOrderItems, statusByPath, tvShowCount]);

  const filteredLibraries = useMemo(() => {
    return hideEmpty ? libraries.filter((library) => library.status !== 'empty') : libraries;
  }, [hideEmpty, libraries]);

  const refreshAll = async () => {
    await Promise.all([
      mediaLibraries.refresh(),
      photoLibrary.refresh(),
      refreshLibrary(),
    ]);
  };

  const scanLibraryKind = async (kind: LibraryKind) => {
    if (kind === 'photos') {
      const api = photoLibrary.api;
      if (!api) throw new Error('Photo libraries are available from the Loom desktop host.');
      const roots = await api.roots();
      for (const root of roots) {
        await api.scan(root.id);
        await waitForScanCompletion(() => api.roots(), root.id);
      }
      await photoLibrary.refresh();
      return;
    }
    if (isMediaLibraryKind(kind)) {
      const api = mediaLibraries.api;
      if (!api) throw new Error('Media libraries are available from the Loom desktop host.');
      const roots = await api.roots(kind);
      for (const root of roots) {
        await api.scan(kind, root.id);
        await waitForScanCompletion(() => api.roots(kind), root.id);
      }
      await mediaLibraries.refresh();
      return;
    }
    scanLibrary();
    await refreshLibrary();
  };

  const addFolderForKind = async (kind: LibraryKind, folderPath?: string): Promise<WizardFolder | null> => {
    if (kind === 'photos') {
      if (!photoLibrary.api) throw new Error('Photo libraries are available from the Loom desktop host.');
      const root = await photoLibrary.api.add(folderPath);
      if (!root) return null;
      await photoLibrary.refresh();
      notifyLibraryRootsChanged();
      return { id: root.id, path: root.path, name: root.name, count: root.count, message: root.message };
    }
    if (isMediaLibraryKind(kind)) {
      if (!mediaLibraries.api) throw new Error('Media libraries are available from the Loom desktop host.');
      const root = await mediaLibraries.api.add(kind, folderPath);
      if (!root) return null;
      await mediaLibraries.refresh();
      notifyLibraryRootsChanged();
      return { id: root.id, path: root.path, name: root.name, count: root.count, message: root.message };
    }

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
  };

  const canAddFolder = useCallback((kind: LibraryKind) => {
    if (kind === 'photos') return Boolean(photoLibrary.api);
    if (isMediaLibraryKind(kind)) return Boolean(mediaLibraries.api);
    return !desktopApi.isRemoteLibraryMode();
  }, [mediaLibraries.api, photoLibrary.api]);

  const removeFolder = async (kind: LibraryKind, folder: UnifiedFolder | WizardFolder) => {
    const confirmed = await confirm({
      title: 'Remove this library folder?',
      description: `Remove "${folder.name || folder.path}" from the library. Files on disk will be kept.`,
      confirmLabel: 'Remove folder',
      destructive: true,
    });
    if (!confirmed) return false;
    if (kind === 'photos') {
      if (!photoLibrary.api) throw new Error('Photo libraries are available from the Loom desktop host.');
      await photoLibrary.api.remove(folder.id);
      await photoLibrary.refresh();
      notifyLibraryRootsChanged();
      return;
    }
    if (isMediaLibraryKind(kind)) {
      if (!mediaLibraries.api) throw new Error('Media libraries are available from the Loom desktop host.');
      await mediaLibraries.api.remove(kind, folder.id);
      await mediaLibraries.refresh();
      notifyLibraryRootsChanged();
      return;
    }
    if (folder.path === 'Folder selected') return;
    await removeLibraryFolder(folder.path);
    notifyLibraryRootsChanged();
  };

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
      const folder = await addFolderForKind(kind);
      if (folder && (kind === 'photos' || isMediaLibraryKind(kind))) await scanLibraryKind(kind);
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

  const anyScanning = isScanning || mediaLibraries.scanning || photoLibrary.roots.some((root) => root.scanning);
  const configuredCount = libraries.filter((library) => library.folders.length > 0).length;
  const totalItemCount = libraries.reduce((total, library) => total + (library.itemCount || 0), 0);

  // One scan for every library that has folders, one after another.
  const scanAllLibraries = async () => {
    setScanningAll(true);
    setActionError('');
    try {
      // Movies, TV Shows, Anime, and Other folders share one library scan.
      let sharedScanDone = false;
      for (const library of libraries) {
        if (!library.folders.length || !canAddFolder(library.kind)) continue;
        const shared = library.kind !== 'photos' && !isMediaLibraryKind(library.kind);
        if (shared && sharedScanDone) continue;
        await scanLibraryKind(library.kind);
        if (shared) sharedScanDone = true;
      }
      await refreshAll();
      notifyLibraryRootsChanged();
    } catch (cause) {
      setActionError(errorMessage(cause, 'The libraries could not be scanned.'));
    } finally {
      setScanningAll(false);
    }
  };

  const libraryErrorText = libraryActionError || actionError || mediaLibraries.error || (photoLibrary.error ? errorMessage(photoLibrary.error, 'Photo libraries could not be loaded.') : '');
  const hiddenEmptyCount = libraries.length - filteredLibraries.length;

  return (
    <div>
      <SettingsPageHeader
        title="Library"
        description="The folders Loom watches, how often it syncs them, and how files are named."
      />
      <SettingsGroup
        title="Libraries"
        action={(
          <>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void scanAllLibraries()}
              disabled={anyScanning || scanningAll || configuredCount === 0}
              aria-label={anyScanning || scanningAll ? 'Scanning libraries' : 'Scan all libraries'}
              title={anyScanning || scanningAll ? 'Scanning libraries' : 'Scan all libraries'}
              className="h-9 w-9"
            >
              <RefreshCw className={`h-4 w-4 ${anyScanning || scanningAll ? 'animate-spin' : ''}`} aria-hidden="true" />
            </Button>
            <Button type="button" variant="default" size="sm" onClick={() => setWizardOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New library
            </Button>
          </>
        )}
      >
        {libraryErrorText ? (
          <div role="alert" className="settings-row settings-status-error flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <span>{libraryErrorText}</span>
            {libraryActionError && onRetryLibraryAction ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetryLibraryAction} className="shrink-0">Try again</Button>
            ) : null}
          </div>
        ) : null}

        {mediaLibraries.loading || photoLibrary.loading ? <SettingsNote role="status">Loading library folders…</SettingsNote> : null}

        {filteredLibraries.map((library) => {
          const expanded = accordion.openId === `library:${library.kind}`;
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
          // Ready and empty are already clear from the folder and item counts.
          const showStatus = library.scanning || library.status === 'degraded' || library.status === 'unavailable';
          return (
            <motion.div
              key={library.kind}
              data-library-card
              data-open={expanded || undefined}
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
              className={`settings-row settings-library-card relative ${isDraggingCard ? 'z-10 shadow-2xl shadow-black/35' : ''}`}
            >
              {showDropLine ? (
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-x-3 z-20 h-[2px] rounded-full bg-[var(--loom-accent)] ${sidebarDropTarget?.position === 'before' ? '-top-px' : '-bottom-px'}`}
                />
              ) : null}
              <div
                draggable={Boolean(sidebarItemId)}
                aria-grabbed={sidebarItemId ? isDraggingCard : undefined}
                title={sidebarItemId ? 'Drag to reorder in the sidebar' : undefined}
                onClick={(event) => {
                  if (shouldIgnoreRowToggle(event.target)) return;
                  toggleExpandedKind(library.kind);
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
                className={`settings-library-header group flex min-h-[64px] flex-wrap items-center gap-2.5 px-3 py-2.5 transition-colors sm:flex-nowrap ${isDraggingCard ? 'cursor-grabbing' : 'cursor-pointer'}`}
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
                    className="grid h-10 w-4 shrink-0 place-items-center rounded-md text-[var(--loom-faint)] opacity-60 transition-opacity hover:text-[var(--loom-text)] group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <DotsSixVertical className="h-4 w-4" weight="bold" aria-hidden="true" />
                  </button>
                ) : (
                  <span className="h-10 w-4 shrink-0" aria-hidden="true" />
                )}
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--loom-surface-3)] ${expanded ? 'text-[var(--loom-accent)]' : 'text-[var(--loom-muted)]'}`}>
                  <LibraryTypeIcon kind={library.kind} active={expanded} className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--loom-text)]">{library.label}</span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--loom-muted)]">{folderSummary} · {itemSummary}</span>
                </span>
                {showStatus ? <SettingsBadge tone={libraryStatusTone(library)}>{libraryStatusLabel(library)}</SettingsBadge> : null}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 sm:ml-0">
                  <Button type="button" variant="outline" size="sm" onClick={() => void addFromTable(library.kind)} disabled={busy || !canAddFolder(library.kind)} data-library-card-action className="gap-1.5">
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Add folder
                  </Button>
                  <button type="button" onClick={() => toggleExpandedKind(library.kind)} aria-label={`${expanded ? 'Hide' : 'Show'} ${library.label} folders`} aria-expanded={expanded} data-library-card-action className="grid h-9 w-9 place-items-center rounded-lg text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]">
                    <ChevronRight className={`h-4 w-4 transition-transform duration-200 ${expanded ? 'rotate-90 text-[var(--loom-text)]' : ''}`} aria-hidden="true" />
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
                    className="overflow-hidden"
                  >
                    <div className="px-3 pb-2">
                      {library.folders.length > 0 ? (
                        <ul aria-label={`${library.label} folders`} className="divide-y divide-[var(--loom-settings-divider)]">
                          {library.folders.map((folder) => (
                            <li key={folder.id} className="flex min-h-11 flex-wrap items-center gap-2.5 py-2 text-sm sm:flex-nowrap">
                              <span className="w-4 shrink-0" aria-hidden="true" />
                              <span className="grid h-10 w-10 shrink-0 place-items-center text-[var(--loom-muted)]">
                                <FolderOpen className="h-4 w-4" aria-hidden="true" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="truncate text-[var(--loom-text)]">{folder.name}</span>
                                  <span role="status" aria-label={`Folder status: ${folderStatusLabel(folder)}`}>
                                    <SettingsBadge tone={folderStatusTone(folder)}>{folderStatusLabel(folder)}</SettingsBadge>
                                  </span>
                                </span>
                                <code className="mt-0.5 block break-all text-[11px] leading-4 text-[var(--loom-faint)]">{folder.path}</code>
                                {folder.state !== 'available' && folder.message ? <span className="mt-0.5 block text-xs text-[var(--loom-muted)]">{folder.message}</span> : null}
                              </span>
                              <span className="ml-auto flex shrink-0 items-center gap-1.5 sm:ml-0">
                                {folder.source === 'legacy' ? (
                                  <Button type="button" variant="outline" size="icon" onClick={() => openFolderEditor(folder, library.kind)} aria-label={`Edit ${folder.name}`} title="Edit folder" className="h-9 w-9">
                                    <Pencil className="h-4 w-4" aria-hidden="true" />
                                  </Button>
                                ) : null}
                                <Button type="button" variant="outline" size="icon" onClick={() => void runAction(library.kind, () => removeFolder(library.kind, folder), false)} disabled={busy || folder.scanning} aria-label={`Remove ${folder.name}`} title="Remove folder" className="settings-destructive-text h-9 w-9">
                                  <X className="h-4 w-4" aria-hidden="true" />
                                </Button>
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="py-2 pl-[76px] text-sm text-[var(--loom-muted)]">No folders yet. Use Add folder to choose one from this computer or a mounted NAS share.</p>
                      )}
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </motion.div>
          );
        })}

        {filteredLibraries.length === 0 && !(mediaLibraries.loading || photoLibrary.loading) ? (
          <SettingsNote>No libraries yet. Use New library to add your first folder.</SettingsNote>
        ) : null}

        {hiddenEmptyCount > 0 || !hideEmpty ? (
          <button
            type="button"
            onClick={() => setHideEmpty(!hideEmpty)}
            className="settings-row settings-row-button block w-full px-4 py-2.5 text-left text-xs text-[var(--loom-muted)] transition-colors hover:text-[var(--loom-text)]"
          >
            {hideEmpty
              ? `Show ${hiddenEmptyCount} more library ${hiddenEmptyCount === 1 ? 'type' : 'types'}`
              : 'Hide empty library types'}
          </button>
        ) : null}
      </SettingsGroup>

      <LibraryHealthCard disabled={anyScanning} />

      <SettingsGroup
        title="Sync and organise"
        description={`${configuredCount} ${configuredCount === 1 ? 'library' : 'libraries'} · ${totalItemCount.toLocaleString()} items`}
        action={(
          <Button type="button" variant="outline" size="sm" onClick={() => void runAction('movies', async () => { scanLibrary(); await refreshLibrary(); })} disabled={anyScanning} className="gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${isScanning ? 'animate-spin' : ''}`} aria-hidden="true" />
            {isScanning ? 'Syncing…' : 'Quick sync'}
          </Button>
        )}
      >
        {anyScanning ? (
          <div className="settings-row space-y-2 px-4 py-3.5" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-sm text-[var(--loom-text)]"><span>Scanning library folders</span><span className="text-xs text-[var(--loom-muted)]">{isScanning ? `${scanProgress}%` : 'In progress'}</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--loom-surface-3)]"><div className="h-full rounded-full bg-[var(--loom-accent)] transition-[width] duration-300" style={{ width: `${isScanning ? Math.max(4, scanProgress) : 35}%` }} /></div>
          </div>
        ) : null}
        <SettingsRow title="Automatic sync" description="Runs a quick sync on a schedule.">
          <SettingsSelect
            label="Automatic quick sync interval"
            value={autoSyncIntervalHours}
            options={[{ value: 0, label: 'Off' }, ...AUTO_SYNC_OPTIONS]}
            onChange={(hours) => void setAutoSyncIntervalHours(hours)}
          />
        </SettingsRow>
        <SettingsRow title="Refresh metadata" description="Download titles, artwork, and ratings again for every item.">
          <Button type="button" variant="outline" size="sm" onClick={() => void runAction('movies', async () => { refreshMetadata(); await refreshLibrary(); })} disabled={anyScanning}>Refresh</Button>
        </SettingsRow>
        <SettingsRow title="Full rescan" description="Re-read every file from scratch. Slower than a quick sync.">
          <Button type="button" variant="outline" size="sm" onClick={() => void runAction('movies', async () => { fullRescanLibrary(); await refreshLibrary(); })} disabled={anyScanning}>Rescan</Button>
        </SettingsRow>
        <OrganizeFilesSection disabled={anyScanning} />
      </SettingsGroup>

      <SettingsGroup
        title="Advanced"
        description="Cleanup, original file names, backups, and local app data."
        collapsible
        storageKey="library-advanced"
      >
        <LibraryCleanupSection disabled={anyScanning} />
        <OriginalImportsSection disabled={anyScanning} />
        <SettingsRow title="Back up database" description={backupStatus || 'Save a copy of library metadata, artwork, progress, and settings.'}>
          <Button type="button" onClick={onBackupDatabase} variant="outline" size="sm" className="gap-1.5"><Download className="h-3.5 w-3.5" aria-hidden="true" />Back up</Button>
        </SettingsRow>
        <SettingsRow
          title="Clear local app data"
          tone="danger"
          description={clearDataStatus
            ? <span role={clearDataStatus.startsWith('Clear failed') ? 'alert' : 'status'} className={clearDataStatus.startsWith('Clear failed') ? 'settings-status-error' : undefined}>{clearDataStatus}</span>
            : 'Remove saved folders, metadata, artwork, progress, and settings. Media files stay on disk.'}
        >
          <Button type="button" onClick={onClearAppData} disabled={isClearingData} variant="destructive" size="sm" className="gap-1.5"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{isClearingData ? 'Clearing…' : 'Clear data'}</Button>
        </SettingsRow>
      </SettingsGroup>

      <AddLibraryWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        canAddFolder={canAddFolder}
        onAddFolder={addFolderForKind}
        onRemoveFolder={removeFolder}
        onScan={async (kind) => { await scanLibraryKind(kind); await refreshAll(); }}
      />

      <SettingsDialog
        open={Boolean(editingFolder)}
        onClose={() => setEditingFolder(null)}
        busy={isSavingEdit}
        size="sm"
        title="Edit folder"
        description="Change the name Loom shows or point it at a new location."
        footer={(
          <>
            <Button size="sm" type="button" variant="outline" onClick={() => setEditingFolder(null)} disabled={isSavingEdit}>Cancel</Button>
            <Button size="sm" type="submit" form="settings-edit-folder" disabled={isSavingEdit}>{isSavingEdit ? 'Saving…' : 'Save'}</Button>
          </>
        )}
      >
        {editingFolder ? (
          <form id="settings-edit-folder" className="space-y-4" onSubmit={(event) => void saveFolderEditor(event)}>
            <SettingsDialogField label="Name" htmlFor="settings-edit-folder-name">
              <input id="settings-edit-folder-name" value={editingFolder.name} onChange={(event) => setEditingFolder((current) => current ? { ...current, name: event.target.value } : current)} disabled={isSavingEdit} className={SETTINGS_INPUT_CLASS} />
            </SettingsDialogField>
            <SettingsDialogField label="Location" htmlFor="settings-edit-folder-path">
              <div className="flex items-center gap-2">
                <input id="settings-edit-folder-path" value={editingFolder.path} onChange={(event) => setEditingFolder((current) => current ? { ...current, path: event.target.value } : current)} disabled={isSavingEdit} spellCheck={false} className={`${SETTINGS_INPUT_CLASS} flex-1 font-mono text-xs`} />
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  disabled={isSavingEdit}
                  className="shrink-0 gap-1.5"
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
              </div>
            </SettingsDialogField>
            {editingError ? <SettingsDialogMessage>{editingError}</SettingsDialogMessage> : null}
          </form>
        ) : null}
      </SettingsDialog>
    </div>
  );
}

export type { LibrarySettingsSectionProps };
