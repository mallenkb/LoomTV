import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Folder, Image as ImageIcon, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useConfirm } from '@/components/ConfirmProvider';
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useProfiles } from '@/contexts/ProfileContext';
import { useTheme } from '@/components/ThemeProvider';
import { desktopApi } from '@/lib/desktopApi';
import type { PhotoEntry, PhotoPage, PhotoRoot } from '@/shared/photoLibrary';

function PhotoPreview({ entry, full = false }: { entry: PhotoEntry; full?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!entry.imageUrl || failed) {
    return <div className="grid h-full min-h-28 place-items-center text-[var(--loom-muted)]">
      {entry.kind === 'folder' ? <Folder className="h-10 w-10" /> : <ImageIcon className="h-9 w-9" />}
    </div>;
  }
  return <img
    src={full ? entry.imageUrl.replace('/thumb?', '/view?') : entry.imageUrl}
    alt={full ? entry.name : ''}
    loading={full ? 'eager' : 'lazy'}
    decoding="async"
    className={full ? 'h-full w-full object-contain' : 'h-full w-full object-cover transition-transform group-hover:scale-105'}
    onError={() => setFailed(true)}
  />;
}

function PhotoViewer({ photos, index, setIndex, close }: {
  photos: PhotoEntry[];
  index: number;
  setIndex: (index: number) => void;
  close: () => void;
}) {
  const photo = photos[index];
  if (!photo) return null;
  const folderPath = photo.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return <Dialog
    open
    onOpenChange={(open) => { if (!open) close(); }}
    className="bg-black/95 p-0"
    contentClassName="!h-[100dvh] !max-h-[100dvh] !w-screen !max-w-none !rounded-none !border-0 !bg-black !p-4 text-white"
    onKeyDown={(event) => {
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault();
        setIndex(index - 1);
      }
      if (event.key === 'ArrowRight' && index < photos.length - 1) {
        event.preventDefault();
        setIndex(index + 1);
      }
    }}
  >
    <div className="flex h-full flex-col gap-4">
      <header className="loom-photo-viewer-header flex shrink-0 items-center justify-between gap-4">
        <div className="min-w-0">
          <DialogTitle title={photo.name} className="truncate text-base text-white">{photo.name}</DialogTitle>
          <DialogDescription title={folderPath || undefined} className={folderPath ? 'truncate text-sm text-white/60' : 'sr-only'}>{folderPath || 'Photo viewer'}</DialogDescription>
        </div>
        <button type="button" onClick={close} aria-label="Close photo viewer" className="shrink-0 rounded-full p-3 text-white hover:bg-white/10"><X className="h-5 w-5" /></button>
      </header>
      <div className="min-h-0 flex-1"><PhotoPreview key={photo.imageUrl} entry={photo} full /></div>
      <footer className="flex items-center justify-center gap-5">
        <button type="button" disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label="Previous photo" className="rounded-full p-3 hover:bg-white/10 disabled:opacity-30"><ChevronLeft className="h-6 w-6" /></button>
        <span className="text-sm text-white/60" aria-live="polite">{index + 1} of {photos.length} on this page</span>
        <button type="button" disabled={index === photos.length - 1} onClick={() => setIndex(index + 1)} aria-label="Next photo" className="rounded-full p-3 hover:bg-white/10 disabled:opacity-30"><ChevronRight className="h-6 w-6" /></button>
      </footer>
    </div>
  </Dialog>;
}

export default function Photos() {
  const confirm = useConfirm();
  const { activeProfile } = useProfiles();
  const { theme } = useTheme();
  const isModern = theme.homeStyle === 'modern';
  const frameClass = isModern ? 'loom-modern-content-frame' : 'loom-frame';
  const topPaddingClass = isModern ? 'pt-28' : 'pt-24';
  const photoApi = !desktopApi.isRemoteLibraryMode() && activeProfile?.type === 'owner' ? window.desktopApi?.photos : undefined;
  const [roots, setRoots] = useState<PhotoRoot[]>([]);
  const [rootId, setRootId] = useState<string>();
  const [folder, setFolder] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<PhotoPage | null>(null);
  const [loadingRoots, setLoadingRoots] = useState(Boolean(photoApi));
  const [loadingPage, setLoadingPage] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState('');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const loadRoots = useCallback(async () => {
    if (!photoApi) return;
    const nextRoots = await photoApi.roots();
    setRoots(nextRoots);
    setRootId((current) => current && nextRoots.some((root) => root.id === current) ? current : nextRoots[0]?.id);
    setLoadingRoots(false);
  }, [photoApi]);

  useEffect(() => {
    let active = true;
    void loadRoots().catch((cause) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : 'Photo folders could not be loaded.');
      setLoadingRoots(false);
    });
    return () => { active = false; };
  }, [loadRoots]);

  const scanning = roots.some((root) => root.scanning);
  useEffect(() => {
    if (!scanning) return undefined;
    const timer = window.setInterval(() => void loadRoots().catch(() => undefined), 1200);
    return () => window.clearInterval(timer);
  }, [loadRoots, scanning]);

  const catalogRevision = roots.map((root) => `${root.id}:${root.scannedAt}:${root.scanning}`).join('|');
  useEffect(() => {
    if (!photoApi || (!showAll && !rootId)) {
      setPage(null);
      return undefined;
    }
    let active = true;
    setLoadingPage(true);
    setError('');
    void photoApi.browse({ rootId: showAll ? undefined : rootId, folder: showAll ? null : folder, offset })
      .then((nextPage) => { if (active) setPage(nextPage); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Photos could not be loaded.'); })
      .finally(() => { if (active) setLoadingPage(false); });
    return () => { active = false; };
  }, [catalogRevision, folder, offset, photoApi, rootId, showAll]);

  const selectedRoot = roots.find((root) => root.id === rootId);
  const breadcrumb = useMemo(() => folder ? folder.split('/').filter(Boolean) : [], [folder]);
  const photoEntries = useMemo(() => page?.entries.filter((entry) => entry.kind === 'photo') ?? [], [page]);

  const addRoot = async () => {
    if (!photoApi) return;
    setActionBusy(true);
    setError('');
    try {
      const root = await photoApi.add();
      if (!root) return;
      window.dispatchEvent(new Event('loomtv:library-roots-changed'));
      await photoApi.scan(root.id);
      await loadRoots();
      setRootId(root.id);
      setFolder('');
      setShowAll(false);
      setOffset(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The photo folder could not be added.');
    } finally {
      setActionBusy(false);
    }
  };

  const scanRoot = async () => {
    if (!photoApi || !rootId) return;
    setActionBusy(true);
    setError('');
    try {
      await photoApi.scan(rootId);
      await loadRoots();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The photo folder could not be scanned.');
    } finally {
      setActionBusy(false);
    }
  };

  const cancelScan = async () => {
    if (!photoApi || !rootId) return;
    await photoApi.cancel(rootId);
    await loadRoots();
  };

  const removeRoot = async () => {
    if (!photoApi || !selectedRoot) return;
    const approved = await confirm({
      title: `Remove ${selectedRoot.name}?`,
      description: 'Loom will remove this folder from Photos. Your original files will stay on disk.',
      confirmLabel: 'Remove folder',
      destructive: true,
    });
    if (!approved) return;
    setActionBusy(true);
    setError('');
    try {
      await photoApi.remove(selectedRoot.id);
      window.dispatchEvent(new Event('loomtv:library-roots-changed'));
      setFolder('');
      setPage(null);
      setOffset(0);
      await loadRoots();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The photo folder could not be removed.');
    } finally {
      setActionBusy(false);
    }
  };

  if (!photoApi) return <main className="loom-page h-full overflow-y-auto"><div className={`${frameClass} loom-library-page-frame ${topPaddingClass} px-8 pb-8`}><h1 className="text-3xl font-semibold">Photos</h1><p className="mt-4 text-[var(--loom-muted)]">Photos are available in the local Electron app with the owner profile.</p></div></main>;

  return <div className="loom-page loom-library-page h-full overflow-y-auto">
    <div className={`${frameClass} loom-library-page-frame page-bottom-safe page-list-bottom-safe ${topPaddingClass} px-6 pb-6 md:px-10 md:pb-10`}>
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="sr-only">Photos</h1>
          {roots.length > 0 ? <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 sm:basis-0 sm:flex-1" aria-label="Photo views">
        {roots.map((root) => <button key={root.id} type="button" onClick={() => { setRootId(root.id); setFolder(''); setShowAll(false); setOffset(0); }} aria-pressed={!showAll && root.id === rootId} className={`rounded-lg px-3 py-2 text-sm ${!showAll && root.id === rootId ? 'bg-[var(--loom-accent)] text-white' : 'bg-[var(--loom-surface)] text-[var(--loom-muted)]'}`}>{root.name}</button>)}
        <button type="button" onClick={() => { setShowAll(true); setFolder(''); setOffset(0); }} aria-pressed={showAll} className={`rounded-lg px-3 py-2 text-sm ${showAll ? 'bg-[var(--loom-accent)] text-white' : 'bg-[var(--loom-surface)] text-[var(--loom-muted)]'}`}>All photos</button>
      </div> : null}
          <div className="flex max-w-full flex-wrap items-center gap-2 sm:ml-auto">
            <button type="button" onClick={() => void addRoot()} disabled={actionBusy || scanning} className="loom-button-primary inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-50"><Plus className="h-4 w-4" /> Add folder</button>
            {!showAll && selectedRoot ? <span className="inline-flex flex-wrap items-center gap-2 text-sm">
          {selectedRoot.scanning ? <><span role="status">Scanning, {selectedRoot.discovered.toLocaleString()} found</span><button type="button" onClick={() => void cancelScan()} className="rounded-lg px-3 py-2 hover:bg-[var(--loom-surface)]">Cancel</button></> : <button type="button" onClick={() => void scanRoot()} disabled={actionBusy || scanning} aria-label={`Scan ${selectedRoot.name}`} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface)] p-2 hover:bg-[var(--loom-surface)] disabled:opacity-40"><RefreshCw className="h-4 w-4" /></button>}
          <button type="button" onClick={() => void removeRoot()} disabled={actionBusy || selectedRoot.scanning} aria-label={`Remove ${selectedRoot.name} from Photos`} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface)] p-2 text-red-300 hover:bg-red-400/10 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
        </span> : null}
          </div>
        </header>

    {error ? <p role="alert" className="mt-5 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error}</p> : null}
    {loadingRoots ? <p role="status" className="mt-8 text-sm text-[var(--loom-muted)]">Loading photo folders…</p> : null}

    {!loadingRoots && roots.length === 0 ? <section className="mt-10 rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-10 text-center">
      <ImageIcon className="mx-auto h-10 w-10 text-[var(--loom-muted)]" />
      <h2 className="mt-4 text-lg font-medium text-[var(--loom-text)]">Add a photo folder</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--loom-muted)]">Loom keeps nested folders and scans JPEG, PNG, and WebP files.</p>
      <button type="button" onClick={() => void addRoot()} disabled={actionBusy} className="loom-button-primary mt-6 rounded-lg px-4 py-2 text-sm disabled:opacity-50">Choose folder</button>
    </section> : null}

    {roots.length > 0 ? <>
      {!showAll && selectedRoot && breadcrumb.length > 0 ? <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-[var(--loom-muted)]">
        <nav aria-label="Photo folder location" className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => { setFolder(''); setOffset(0); }} className="hover:text-[var(--loom-text)]">{selectedRoot.name}</button>
          {breadcrumb.map((part, index) => <span key={breadcrumb.slice(0, index + 1).join('/')} className="inline-flex items-center gap-2"><ChevronRight className="h-3 w-3" /><button type="button" onClick={() => { setFolder(breadcrumb.slice(0, index + 1).join('/')); setOffset(0); }} className="hover:text-[var(--loom-text)]">{part}</button></span>)}
        </nav>
      </div> : null}

      {selectedRoot?.state === 'unavailable' ? <p role="status" className="mt-4 text-sm text-[var(--loom-muted)]">This folder is unavailable. Loom kept its previous catalog. Reconnect it, then scan again.</p> : null}
      {loadingPage ? <p role="status" className="mt-8 text-sm text-[var(--loom-muted)]">Loading photos…</p> : null}
      {!loadingPage && page?.entries.length === 0 ? <p className="mt-10 text-sm text-[var(--loom-muted)]">{scanning ? 'Scanning this folder. Photos will appear when the scan finishes.' : 'No photos in this folder.'}</p> : null}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {page?.entries.map((entry) => <button type="button" key={entry.id} onClick={() => {
          if (entry.kind === 'folder') { setShowAll(false); setFolder(entry.relativePath); setOffset(0); }
          else setViewerIndex(photoEntries.findIndex((photo) => photo.id === entry.id));
        }} className="group min-w-0 overflow-hidden rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--loom-accent)]">
          <div className="relative aspect-square overflow-hidden bg-[var(--loom-surface-2)]"><PhotoPreview entry={entry} />{entry.kind === 'folder' && entry.imageUrl ? <Folder className="absolute bottom-3 left-3 h-6 w-6 text-white drop-shadow" /> : null}</div>
          <span className="block truncate p-3 text-sm text-[var(--loom-text)]">{entry.name}</span>
        </button>)}
      </div>

      {page && page.total > page.pageSize ? <div className="mt-8 flex items-center justify-center gap-4">
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - page.pageSize))} className="rounded-lg border border-[var(--loom-border)] px-4 py-2 text-sm disabled:opacity-40">Previous</button>
        <span className="text-sm text-[var(--loom-muted)]">Page {Math.floor(offset / page.pageSize) + 1} of {Math.ceil(page.total / page.pageSize)}</span>
        <button type="button" disabled={offset + page.pageSize >= page.total} onClick={() => setOffset(offset + page.pageSize)} className="rounded-lg border border-[var(--loom-border)] px-4 py-2 text-sm disabled:opacity-40">Next</button>
      </div> : null}
    </> : null}

    {viewerIndex !== null ? <PhotoViewer photos={photoEntries} index={viewerIndex} setIndex={setViewerIndex} close={() => setViewerIndex(null)} /> : null}
    </div>
  </div>;
}
