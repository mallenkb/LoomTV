import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { FolderOpen, FolderPlus } from 'lucide-react';
import { PencilSimple } from '@phosphor-icons/react';
import { libraryMutationMessage, useLibrary, MediaItem, TVShow } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import MediaPosterCard from '@/components/MediaPosterCard';
import { desktopApi } from '@/lib/desktopApi';
import {
  normalizeOtherFolderIcon,
  OTHER_FOLDER_ICON_OPTIONS,
  otherFolderIconStorageKey,
  type OtherFolderIconId,
} from '@/components/OtherFolderIcons';
import { useProgressSnapshot } from '@/lib/progress';
import { useProfiles } from '@/contexts/ProfileContext';
import { createLibraryListState, matchesLibraryFilter, type LibraryFilter } from '@/lib/libraryFilters';
import LibraryPageLayout from '@/components/LibraryPageLayout';
import { assignOtherFolderToGroup, createOtherFolderGroup, normalizeOtherFolderGroups, otherFolderGroupForFolder, type OtherFolderGroups } from '@/lib/otherFolderGroups';

type OthersProps = {
  onPlay: (
    filePath: string,
    title: string,
    subtitles?: MediaItem['subtitles'],
    episodes?: MediaItem['episodes'],
    episodeFiles?: MediaItem['episodeFiles'],
    currentSeason?: number,
    currentEpisode?: number,
    mediaId?: string,
  ) => void;
};

export default function Others({ onPlay }: OthersProps) {
  const { state, addLibraryFolderPath, updateLibraryFolder } = useLibrary();
  const { isLoading, libraryFolderGroups } = state;
  const { lists } = useProfiles();
  const othersFolders = useMemo(() => libraryFolderGroups.others || [], [libraryFolderGroups.others]);
  const location = useLocation();
  const navigate = useNavigate();
  const routeParams = new URLSearchParams(location.search);
  const selectedFolder = routeParams.get('folder');
  const selectedGroupId = routeParams.get('group') || '';
  const [otherFolderGroups, setOtherFolderGroups] = useState<OtherFolderGroups>({});
  const selectedGroup = otherFolderGroups[selectedGroupId];
  const visibleFolders = useMemo(
    () => selectedGroup
      ? selectedGroup.folders.filter((folder) => othersFolders.includes(folder))
      : selectedFolder && othersFolders.includes(selectedFolder) ? [selectedFolder] : othersFolders,
    [othersFolders, selectedFolder, selectedGroup],
  );
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('all');
  const [isFolderEditorOpen, setIsFolderEditorOpen] = useState(false);
  const [customFolderNames, setCustomFolderNames] = useState<Record<string, string>>({});
  const [fallbackFolderIcon, setFallbackFolderIcon] = useState<OtherFolderIconId>('folder');
  const [editorName, setEditorName] = useState('');
  const [editorPath, setEditorPath] = useState('');
  const [editorIcon, setEditorIcon] = useState<OtherFolderIconId>('folder');
  const [editorGroupId, setEditorGroupId] = useState('');
  const [editorNewGroupName, setEditorNewGroupName] = useState('');
  const [editorError, setEditorError] = useState('');
  const [isSavingEditor, setIsSavingEditor] = useState(false);
  const [isGroupCreatorOpen, setIsGroupCreatorOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupIcon, setNewGroupIcon] = useState<OtherFolderIconId>('folder');
  const [libraryActionError, setLibraryActionError] = useState('');
  const progress = useProgressSnapshot();
  const listState = useMemo(() => createLibraryListState(lists), [lists]);
  const editableFolder = visibleFolders.length === 1 ? visibleFolders[0] : null;
  const visibleTitle = selectedGroup?.name || (editableFolder
    ? customFolderNames[editableFolder] || folderNameFromPath(editableFolder)
    : 'Others');

  useEffect(() => {
    let mounted = true;
    void desktopApi.getSettings().then((settings) => {
      if (!mounted) return;
      setCustomFolderNames(settings.customFolderNames || {});
      setFallbackFolderIcon(normalizeOtherFolderIcon(settings.otherFolderIcon));
      setOtherFolderGroups(normalizeOtherFolderGroups(settings.otherFolderGroups));
    });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    const handleGroupsChanged = (event: Event) => setOtherFolderGroups(normalizeOtherFolderGroups((event as CustomEvent<OtherFolderGroups>).detail));
    window.addEventListener('loomtv:other-folder-groups-changed', handleGroupsChanged);
    return () => window.removeEventListener('loomtv:other-folder-groups-changed', handleGroupsChanged);
  }, []);
  const normalizedQuery = searchQuery(query);
  const items = useMemo(
    () => otherFolderItems([...state.movies, ...state.tvShows, ...state.animeShows], visibleFolders),
    [state.animeShows, state.movies, state.tvShows, visibleFolders],
  );
  const filteredItems = useMemo(
    () => items
      .filter((item) => matchesMediaItem(item, normalizedQuery))
      .filter((item) => matchesLibraryFilter(item, activeFilter, progress, listState)),
    [activeFilter, items, listState, normalizedQuery, progress],
  );
  const handleAddFolder = async () => {
    setNewGroupName('');
    setNewGroupIcon('folder');
    setLibraryActionError('');
    setIsGroupCreatorOpen(true);
  };
  const addFolderToSelectedGroup = async () => {
    if (!selectedGroupId || !selectedGroup) return;
    setLibraryActionError('');
    try {
      const folder = await desktopApi.pickLibraryFolder();
      if (!folder) return;
      await addLibraryFolderPath('others', folder);
      const assigned = assignOtherFolderToGroup(otherFolderGroups, '', folder, { groupId: selectedGroupId, icon: selectedGroup.icon });
      await desktopApi.saveSettings({ otherFolderGroups: assigned.groups });
      setOtherFolderGroups(assigned.groups);
      window.dispatchEvent(new CustomEvent('loomtv:other-folder-groups-changed', { detail: assigned.groups }));
    } catch (error) {
      setLibraryActionError(libraryMutationMessage(error));
    }
  };
  const handlePlayItem = (item: MediaItem) => {
    if (item.format?.toLowerCase() === 'image') return;
    if (item.type === 'movie') {
      if (item.filePath) onPlay(item.filePath, item.title, item.subtitles, undefined, undefined, undefined, undefined, item.id);
      return;
    }
    const firstEpisode = (item.episodeFiles || [])
      .slice()
      .sort((a, b) => a.season - b.season || a.episode - b.episode)[0];
    const filePath = firstEpisode?.filePath || item.filePath;
    if (!filePath) return;
    onPlay(
      filePath,
      item.title,
      firstEpisode?.subtitles || item.subtitles,
      item.episodes,
      item.episodeFiles,
      firstEpisode?.season,
      firstEpisode?.episode,
      item.id,
    );
  };
  const openFolderEditor = () => {
    if (!editableFolder) return;
    setEditorName(customFolderNames[editableFolder] || folderNameFromPath(editableFolder));
    setEditorPath(editableFolder);
    setEditorIcon(normalizeOtherFolderIcon(
      customFolderNames[otherFolderIconStorageKey(editableFolder)] || fallbackFolderIcon,
    ));
    setEditorGroupId(otherFolderGroupForFolder(otherFolderGroups, editableFolder));
    setEditorNewGroupName('');
    setEditorError('');
    setIsFolderEditorOpen(true);
  };
  const saveFolderEditor = async () => {
    if (!editableFolder) return;
    const previousFolder = editableFolder;
    const nextFolder = editorPath.trim();
    if (!nextFolder) {
      setEditorError('Folder path is required.');
      return;
    }
    if (editorGroupId === '__new__' && !editorNewGroupName.trim()) {
      setEditorError('Group name is required.');
      return;
    }
    setIsSavingEditor(true);
    setEditorError('');
    try {
      if (nextFolder !== previousFolder) {
        await updateLibraryFolder(previousFolder, nextFolder, 'others');
      }
    const nextNames = { ...customFolderNames };
    delete nextNames[previousFolder];
    delete nextNames[otherFolderIconStorageKey(previousFolder)];
    const name = editorName.trim();
    if (name && name !== folderNameFromPath(nextFolder)) nextNames[nextFolder] = name;
    else delete nextNames[nextFolder];
    nextNames[otherFolderIconStorageKey(nextFolder)] = editorIcon;
    const groupUpdate = assignOtherFolderToGroup(otherFolderGroups, previousFolder, nextFolder, {
      groupId: editorGroupId === '__new__' ? '' : editorGroupId,
      newGroupName: editorGroupId === '__new__' ? editorNewGroupName : '',
      icon: editorIcon,
    });
    await desktopApi.saveSettings({ customFolderNames: nextNames, otherFolderGroups: groupUpdate.groups });
    setCustomFolderNames(nextNames);
    setOtherFolderGroups(groupUpdate.groups);
    window.dispatchEvent(new CustomEvent('loomtv:custom-folder-names-changed', { detail: nextNames }));
    window.dispatchEvent(new CustomEvent('loomtv:other-folder-groups-changed', { detail: groupUpdate.groups }));
    setIsFolderEditorOpen(false);
      if (groupUpdate.groupId) {
        navigate(`/others?group=${encodeURIComponent(groupUpdate.groupId)}`, { replace: true });
      } else if (nextFolder !== previousFolder) {
        navigate(`/others?folder=${encodeURIComponent(nextFolder)}`, { replace: true });
      }
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : 'The folder could not be updated.');
    } finally {
      setIsSavingEditor(false);
    }
  };

  return (
    <LibraryPageLayout
      title={visibleTitle}
      subtitle={visibleFolders.length > 0
        ? `${visibleFolders.length} custom ${visibleFolders.length === 1 ? 'folder' : 'folders'}`
        : undefined}
      headerAction={selectedGroup ? (
        <Button type="button" variant="outline" onClick={() => void addFolderToSelectedGroup()} className="h-10 gap-2 rounded-full px-4"><FolderPlus className="h-4 w-4" />Add folder</Button>
      ) : editableFolder ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Edit ${visibleTitle} folder`}
          title="Edit folder"
          onClick={openFolderEditor}
          className="h-10 w-10 rounded-full border border-[var(--loom-control-border)] bg-[var(--loom-panel)] text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)]"
        >
          <PencilSimple className="h-5 w-5" weight="regular" />
        </Button>
      ) : (
        <Button type="button" variant="outline" onClick={() => void handleAddFolder()} className="h-10 gap-2 rounded-full px-4"><FolderPlus className="h-4 w-4" />Add group</Button>
      )}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search custom folders"
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
    >
        {isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(132px,160px))] justify-start gap-5">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[16/10] w-full max-w-[160px] rounded-md" />
            ))}
          </div>
        ) : othersFolders.length === 0 && !selectedGroup ? (
          <EmptyOthersState error={libraryActionError} onAddFolder={handleAddFolder} />
        ) : (
          <>
            <VirtualPosterGrid
              items={filteredItems}
              minColumnWidth={132}
              maxColumnWidth={160}
              rowHeight={176}
              gap={20}
              renderItem={(item) => (
                <div className="relative h-full">
                  <MediaPosterCard item={item} from={currentRoute} variant="others" onPlay={handlePlayItem} />
                </div>
              )}
            />
            {items.length === 0 && (
              <div className="py-12 text-center text-[var(--loom-muted)]">
                No media found in your Others folders yet.
              </div>
            )}
            {items.length > 0 && filteredItems.length === 0 && (
              <div className="py-12 text-center text-[var(--loom-muted)]">
                {activeFilter === 'all' ? 'No local matches found' : 'No custom-folder titles match this filter'}
              </div>
            )}
          </>
        )}
        <Dialog
          open={isFolderEditorOpen}
          onOpenChange={(open) => { if (!isSavingEditor) setIsFolderEditorOpen(open); }}
          contentClassName="max-w-md border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]"
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit folder</DialogTitle>
              <DialogDescription className="text-[var(--loom-muted)]">Change this folder's name, file path, and sidebar icon.</DialogDescription>
            </DialogHeader>
            <form className="mt-6 space-y-5" onSubmit={(event) => { event.preventDefault(); void saveFolderEditor(); }}>
              <label className="flex flex-col gap-1.5 text-sm text-[var(--loom-text)]">
                Folder name
                <input
                  autoFocus
                  value={editorName}
                  onChange={(event) => setEditorName(event.target.value)}
                  disabled={isSavingEditor}
                  className="h-11 w-full rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] outline-none transition-colors focus:border-[var(--loom-accent)]"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm text-[var(--loom-text)]">
                Folder path
                <span className="flex gap-2">
                  <input
                    value={editorPath}
                    onChange={(event) => setEditorPath(event.target.value)}
                    disabled={isSavingEditor}
                    spellCheck={false}
                    className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-bg)] px-3 font-mono text-xs text-[var(--loom-text)] outline-none transition-colors focus:border-[var(--loom-accent)]"
                  />
                  <Button type="button" variant="outline" disabled={isSavingEditor} aria-label="Choose folder from computer" title="Browse folders" className="h-11 shrink-0 gap-2 px-3" onClick={() => {
                    void desktopApi.pickLibraryFolder(editorPath).then((path) => {
                      if (path) setEditorPath(path);
                    }).catch((error) => setEditorError(error instanceof Error ? error.message : 'The folder picker could not be opened.'));
                  }}>
                    <FolderOpen className="h-4 w-4" />
                    Browse
                  </Button>
                </span>
              </label>
              <label className="flex flex-col gap-1.5 text-sm text-[var(--loom-text)]">
                Group
                <select value={editorGroupId} onChange={(event) => {
                  const groupId = event.target.value;
                  setEditorGroupId(groupId);
                  if (groupId && groupId !== '__new__') setEditorIcon(normalizeOtherFolderIcon(otherFolderGroups[groupId]?.icon));
                }} disabled={isSavingEditor} className="h-11 w-full rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] outline-none focus:border-[var(--loom-accent)]">
                  <option value="">No group</option>
                  <option value="__new__">Create a new group</option>
                  {Object.entries(otherFolderGroups).map(([id, group]) => <option key={id} value={id}>{group.name}</option>)}
                </select>
              </label>
              {editorGroupId === '__new__' ? (
                <label className="flex flex-col gap-1.5 text-sm text-[var(--loom-text)]">
                  Group name
                  <input value={editorNewGroupName} onChange={(event) => setEditorNewGroupName(event.target.value)} disabled={isSavingEditor} className="h-11 w-full rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] outline-none focus:border-[var(--loom-accent)]" />
                </label>
              ) : null}
              <fieldset disabled={isSavingEditor}>
                <legend className="mb-3 text-sm font-medium text-[var(--loom-text)]">Folder icon</legend>
                <div className="grid grid-cols-6 gap-2">
                  {OTHER_FOLDER_ICON_OPTIONS.map((option) => {
                    const selected = option.id === editorIcon;
                    const Icon = selected ? option.solid : option.outline;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-label={option.label}
                        aria-pressed={selected}
                        title={option.label}
                        onClick={() => setEditorIcon(option.id)}
                        className={`grid aspect-square place-items-center rounded-xl border transition-colors ${selected
                          ? 'border-[var(--loom-accent)] bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]'
                          : 'border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] text-[var(--loom-muted)] hover:text-[var(--loom-text)]'}`}
                      >
                        <Icon className="h-6 w-6" />
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              {editorError ? <p role="alert" className="text-sm text-red-300">{editorError}</p> : null}
              <div className="flex justify-end gap-3">
                <button type="button" disabled={isSavingEditor} onClick={() => setIsFolderEditorOpen(false)} className="rounded-lg border border-[var(--loom-surface-3)] px-4 py-2.5 text-sm text-[var(--loom-muted)] hover:text-[var(--loom-text)] disabled:opacity-60">
                  Cancel
                </button>
                <button type="submit" disabled={isSavingEditor} className="rounded-lg bg-[var(--loom-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--loom-accent-foreground)] disabled:opacity-60">
                  {isSavingEditor ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog open={isGroupCreatorOpen} onOpenChange={setIsGroupCreatorOpen} contentClassName="max-w-md border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]">
          <DialogContent>
            <DialogHeader><DialogTitle>Create custom library</DialogTitle><DialogDescription className="text-[var(--loom-muted)]">Create the group first, then add multiple folders from your computer.</DialogDescription></DialogHeader>
            <form className="mt-6 space-y-5" onSubmit={(event) => {
              event.preventDefault();
              if (!newGroupName.trim()) { setLibraryActionError('Group name is required.'); return; }
              const created = createOtherFolderGroup(otherFolderGroups, newGroupName, newGroupIcon);
              void desktopApi.saveSettings({ otherFolderGroups: created.groups }).then(() => {
                setOtherFolderGroups(created.groups);
                window.dispatchEvent(new CustomEvent('loomtv:other-folder-groups-changed', { detail: created.groups }));
                setIsGroupCreatorOpen(false);
                navigate(`/others?group=${encodeURIComponent(created.groupId)}`);
              }).catch((error) => setLibraryActionError(error instanceof Error ? error.message : 'The group could not be created.'));
            }}>
              <label className="flex flex-col gap-1.5 text-sm">Group name<input autoFocus value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="Children's Videos" className="h-11 rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-bg)] px-3 outline-none focus:border-[var(--loom-accent)]" /></label>
              <fieldset><legend className="mb-3 text-sm font-medium">Group icon</legend><div className="grid grid-cols-6 gap-2">{OTHER_FOLDER_ICON_OPTIONS.map((option) => { const selected = option.id === newGroupIcon; const Icon = selected ? option.solid : option.outline; return <button key={option.id} type="button" aria-label={option.label} title={option.label} aria-pressed={selected} onClick={() => setNewGroupIcon(option.id)} className={`grid aspect-square place-items-center rounded-xl border ${selected ? 'border-[var(--loom-accent)] bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] text-[var(--loom-muted)]'}`}><Icon className="h-5 w-5" /></button>; })}</div></fieldset>
              {libraryActionError ? <p role="alert" className="text-sm text-red-300">{libraryActionError}</p> : null}
              <div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setIsGroupCreatorOpen(false)}>Cancel</Button><Button type="submit">Create group</Button></div>
            </form>
          </DialogContent>
        </Dialog>
    </LibraryPageLayout>
  );
}

function folderNameFromPath(folder: string): string {
  return folder.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || 'Others';
}

function EmptyOthersState({ error, onAddFolder }: { error?: string; onAddFolder: () => Promise<void> }) {
  return (
    <div className="flex min-h-[calc(100vh-260px)] items-center justify-center px-4">
      <div className="w-full max-w-[520px] text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] bg-[var(--loom-panel)]">
          <FolderPlus className="h-9 w-9 text-[var(--loom-accent)]" />
        </div>
        <h3 className="text-2xl font-semibold text-white">Add an Others folder</h3>
        <p className="mx-auto mt-3 max-w-[420px] text-sm leading-6 text-[var(--loom-muted)]">
          Videos added here stay in Others. LoomTV still detects series and anime structure so every file remains easy to browse and play.
        </p>
        {error ? <p role="alert" className="mt-4 text-sm text-red-200">{error}</p> : null}
        <Button onClick={onAddFolder} className="mt-8 h-12 gap-2 px-5">
          <FolderPlus className="h-4 w-4" />
          Add Others Folder
        </Button>
      </div>
    </div>
  );
}

function otherFolderItems(items: MediaItem[], folders: string[]): MediaItem[] {
  const normalizedFolders = folders.map(normalizePathPrefix).filter(Boolean);
  if (normalizedFolders.length === 0) return [];
  return items.filter((item) => itemBelongsToFolders(item, normalizedFolders));
}

function itemBelongsToFolders(item: MediaItem, folders: string[]): boolean {
  if (item.type === 'movie') return pathBelongsToFolders(item.filePath, folders);
  const episodeFiles = (item as TVShow).episodeFiles || [];
  // Loose episode-looking files in a mixed root are retained as playable
  // catalog items even when no series structure could be formed. Fall back to
  // the item's own path so Others never hides a file the scanner indexed.
  return episodeFiles.length > 0
    ? episodeFiles.some((file) => pathBelongsToFolders(file.filePath, folders))
    : pathBelongsToFolders(item.filePath, folders);
}

function pathBelongsToFolders(filePath: string | undefined, folders: string[]): boolean {
  const normalizedPath = normalizePathPrefix(filePath || '');
  return folders.some((folder) => normalizedPath === folder || normalizedPath.startsWith(`${folder}/`));
}

function normalizePathPrefix(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}
