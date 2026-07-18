import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, Image, Loader2, MoreHorizontal, RefreshCw, Search, Star, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { saveCustomArtwork } from '@/lib/customArtwork';
import { useToast } from '@/components/ToastProvider';
import type { OfficialMetadataCandidate } from '@/lib/desktopApi';

type ArtworkTarget = 'cover' | 'thumbnail';
export type CustomArtworkState = Partial<Record<ArtworkTarget | 'poster', string>>;

type ArtworkPreview = {
  target: ArtworkTarget;
  url: string;
  name: string;
  width: number;
  height: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
};

type ArtworkPrepareState = {
  target: ArtworkTarget;
  name: string;
};

export type OfficialArtworkResult = {
  thumbnail?: string;
  cover?: string;
  summary?: string;
  rating?: number;
  posterCandidates?: string[];
  backdropCandidates?: string[];
};

type ArtworkTargetConfig = {
  label: string;
  menuLabel: string;
  aspectClass: string;
  outputWidth: number;
  outputHeight: number;
};

const ARTWORK_TARGETS: Record<ArtworkTarget, ArtworkTargetConfig> = {
  thumbnail: {
    label: 'Thumbnail / poster',
    menuLabel: 'Update thumbnail / poster',
    aspectClass: 'mx-auto aspect-[2/3] w-56 max-w-full',
    outputWidth: 800,
    outputHeight: 1200,
  },
  cover: {
    label: 'Cover photo',
    menuLabel: 'Update cover photo',
    aspectClass: 'aspect-[16/6] w-full',
    outputWidth: 1600,
    outputHeight: 600,
  },
};

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function cropArtworkToDataUrl(preview: ArtworkPreview): Promise<string> {
  const target = ARTWORK_TARGETS[preview.target];
  const targetAspect = target.outputWidth / target.outputHeight;

  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = target.outputWidth;
      canvas.height = target.outputHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Unable to prepare artwork crop.'));
        return;
      }

      const imageAspect = image.naturalWidth / image.naturalHeight;
      const baseCropWidth = imageAspect > targetAspect ? image.naturalHeight * targetAspect : image.naturalWidth;
      const baseCropHeight = imageAspect > targetAspect ? image.naturalHeight : image.naturalWidth / targetAspect;
      const cropWidth = Math.min(image.naturalWidth, baseCropWidth / preview.zoom);
      const cropHeight = Math.min(image.naturalHeight, baseCropHeight / preview.zoom);
      const positionX = clampPercent(50 + preview.offsetX) / 100;
      const positionY = clampPercent(50 + preview.offsetY) / 100;
      const cropX = Math.max(0, Math.min(image.naturalWidth - cropWidth, (image.naturalWidth - cropWidth) * positionX));
      const cropY = Math.max(0, Math.min(image.naturalHeight - cropHeight, (image.naturalHeight - cropHeight) * positionY));

      context.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, target.outputWidth, target.outputHeight);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    image.onerror = () => reject(new Error('Unable to load selected artwork.'));
    image.src = preview.url;
  });
}

interface ArtworkEditorControlsProps {
  mediaId: string;
  legacyStorageKey: string;
  onCustomArtworkChange: React.Dispatch<React.SetStateAction<CustomArtworkState>>;
  onOpenFolderPath?: () => Promise<void> | void;
  onSaved?: () => Promise<void> | void;
  officialThumbnailSources?: string[];
  officialCoverSources?: string[];
  fallbackFrameSource?: string;
  onFetchOfficialArtwork?: () => Promise<OfficialArtworkResult>;
  onFetchOfficialArtworkCandidates?: () => Promise<OfficialMetadataCandidate[]>;
  onApplyOfficialArtworkCandidate?: (candidate: OfficialMetadataCandidate) => Promise<OfficialArtworkResult>;
}

export default function ArtworkEditorControls({
  mediaId,
  legacyStorageKey,
  onCustomArtworkChange,
  onOpenFolderPath,
  onSaved,
  officialThumbnailSources = [],
  officialCoverSources = [],
  fallbackFrameSource = '',
  onFetchOfficialArtwork,
  onFetchOfficialArtworkCandidates,
  onApplyOfficialArtworkCandidate,
}: ArtworkEditorControlsProps) {
  const [artworkMenuOpen, setArtworkMenuOpen] = useState(false);
  const [artworkPreview, setArtworkPreview] = useState<ArtworkPreview | null>(null);
  const [artworkPrepareState, setArtworkPrepareState] = useState<ArtworkPrepareState | null>(null);
  const [isSavingArtwork, setIsSavingArtwork] = useState(false);
  const [isFetchingArtwork, setIsFetchingArtwork] = useState(false);
  const [metadataCandidates, setMetadataCandidates] = useState<OfficialMetadataCandidate[]>([]);
  const [metadataDialogOpen, setMetadataDialogOpen] = useState(false);
  const [applyingCandidateId, setApplyingCandidateId] = useState('');
  const [metadataError, setMetadataError] = useState('');
  const [artworkSaveError, setArtworkSaveError] = useState('');
  const [isPageScrolled, setIsPageScrolled] = useState(false);
  const artworkMenuRef = useRef<HTMLDivElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const thumbnailInputRef = useRef<HTMLInputElement | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (!artworkMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!artworkMenuRef.current?.contains(event.target as Node)) {
        setArtworkMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setArtworkMenuOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [artworkMenuOpen]);

  useEffect(() => {
    setArtworkMenuOpen(false);
    setArtworkPreview(null);
    setArtworkPrepareState(null);
    setArtworkSaveError('');
    setIsSavingArtwork(false);
    setMetadataCandidates([]);
    setMetadataDialogOpen(false);
    setApplyingCandidateId('');
    setMetadataError('');
  }, [mediaId]);

  useEffect(() => {
    const scrollContainer = artworkMenuRef.current?.closest('.overflow-y-auto');
    if (!scrollContainer) return;

    const updateScrolledState = () => {
      setIsPageScrolled(scrollContainer.scrollTop > 24);
    };

    updateScrolledState();
    scrollContainer.addEventListener('scroll', updateScrolledState, { passive: true });
    return () => {
      scrollContainer.removeEventListener('scroll', updateScrolledState);
    };
  }, [mediaId]);

  const openArtworkPicker = (target: ArtworkTarget) => {
    const input = target === 'cover' ? coverInputRef.current : thumbnailInputRef.current;
    input?.click();
    setArtworkMenuOpen(false);
  };

  const saveOfficialArtwork = async (refreshedArtwork: OfficialArtworkResult | null) => {
    const thumbnailSource =
      refreshedArtwork?.thumbnail
      || refreshedArtwork?.posterCandidates?.find(Boolean)
      || officialThumbnailSources.find(Boolean)
      || fallbackFrameSource;
    const coverSource =
      refreshedArtwork?.cover
      || refreshedArtwork?.backdropCandidates?.find(Boolean)
      || refreshedArtwork?.thumbnail
      || officialCoverSources.find(Boolean)
      || officialThumbnailSources.find(Boolean)
      || fallbackFrameSource;

    if (!thumbnailSource && !coverSource) {
      setArtworkMenuOpen(false);
      await onSaved?.();
      return true;
    }

    if (thumbnailSource) await saveCustomArtwork(mediaId, 'thumbnail', thumbnailSource, legacyStorageKey);
    if (coverSource) await saveCustomArtwork(mediaId, 'cover', coverSource, legacyStorageKey);
    onCustomArtworkChange((current) => ({
      ...current,
      ...(thumbnailSource ? { thumbnail: thumbnailSource, poster: thumbnailSource } : {}),
      ...(coverSource ? { cover: coverSource } : {}),
    }));
    setArtworkMenuOpen(false);
    await onSaved?.();
    return true;
  };

  const openMetadataCandidates = async () => {
    if (!mediaId || isFetchingArtwork) return;

    setIsFetchingArtwork(true);
    setArtworkSaveError('');
    setMetadataError('');
    try {
      if (onFetchOfficialArtworkCandidates) {
        const candidates = await onFetchOfficialArtworkCandidates();
        setMetadataCandidates(candidates);
        setMetadataDialogOpen(true);
        if (candidates.length === 0) {
          showToast({
            title: 'No metadata matches found',
            description: 'I could not find matching metadata from the connected metadata APIs.',
            tone: 'warning',
          });
        }
        return;
      }

      const refreshedArtwork = onFetchOfficialArtwork ? await onFetchOfficialArtwork() : null;
      const hasFreshOfficialArtwork = Boolean(refreshedArtwork?.thumbnail || refreshedArtwork?.cover);
      if (onFetchOfficialArtwork && !hasFreshOfficialArtwork) {
        showToast({
          title: 'Official artwork was not found',
          description: fallbackFrameSource
            ? 'I could not get a matching poster or cover from the metadata APIs, so I used a video frame for now.'
            : 'I could not get a matching poster or cover from the metadata APIs. Check your metadata keys and try again.',
          tone: 'warning',
        });
      }
      await saveOfficialArtwork(refreshedArtwork);
    } catch (error) {
      setMetadataError(error instanceof Error ? error.message : 'Unable to refresh metadata.');
      setMetadataDialogOpen(true);
    } finally {
      setIsFetchingArtwork(false);
    }
  };

  const refreshOfficialMetadata = async () => {
    if (!mediaId || isFetchingArtwork || !onFetchOfficialArtwork) return;

    setIsFetchingArtwork(true);
    setArtworkSaveError('');
    setMetadataError('');
    try {
      const refreshedArtwork = await onFetchOfficialArtwork();
      const hasFreshOfficialArtwork = Boolean(refreshedArtwork?.thumbnail || refreshedArtwork?.cover);
      if (!hasFreshOfficialArtwork) {
        showToast({
          title: 'Metadata refreshed',
          description: 'No new official artwork was found, but available metadata was checked.',
          tone: 'warning',
        });
      }
      await saveOfficialArtwork(refreshedArtwork);
      showToast({
        title: 'Metadata refreshed',
        description: 'This item was refreshed from the connected metadata APIs.',
        tone: 'success',
      });
    } catch (error) {
      setArtworkSaveError(error instanceof Error ? error.message : 'Unable to refresh metadata.');
    } finally {
      setIsFetchingArtwork(false);
    }
  };

  const openFolderPath = () => {
    if (!onOpenFolderPath) return;
    setArtworkMenuOpen(false);
    void Promise.resolve()
      .then(onOpenFolderPath)
      .catch((error) => {
        showToast({
          title: 'Could not open folder',
          description: error instanceof Error ? error.message : 'Unable to locate this folder.',
          tone: 'error',
        });
      });
  };

  const applyMetadataCandidate = async (candidate: OfficialMetadataCandidate) => {
    if (!onApplyOfficialArtworkCandidate || applyingCandidateId) return;
    setApplyingCandidateId(candidate.id);
    setMetadataError('');
    try {
      const refreshedArtwork = await onApplyOfficialArtworkCandidate(candidate);
      await saveOfficialArtwork(refreshedArtwork);
      setMetadataDialogOpen(false);
      showToast({
        title: 'Metadata updated',
        description: `${candidate.title} from ${candidate.source} was applied.`,
        tone: 'success',
      });
    } catch (error) {
      setMetadataError(error instanceof Error ? error.message : 'Unable to apply metadata.');
    } finally {
      setApplyingCandidateId('');
    }
  };

  const handleArtworkFileChange = (target: ArtworkTarget, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;

    setArtworkPreview(null);
    setArtworkPrepareState({ target, name: file.name });
    setArtworkSaveError('');

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) {
        setArtworkPrepareState(null);
        setArtworkSaveError('Unable to read selected artwork.');
        return;
      }

      const image = new window.Image();
      image.onload = () => {
        setArtworkPreview({
          target,
          url: dataUrl,
          name: file.name,
          width: image.naturalWidth,
          height: image.naturalHeight,
          zoom: 1,
          offsetX: 0,
          offsetY: 0,
        });
        setArtworkPrepareState(null);
      };
      image.onerror = () => {
        setArtworkPrepareState(null);
        setArtworkSaveError('Unable to load selected artwork. Try a JPG, PNG, or WebP image.');
      };
      image.src = dataUrl;
    };
    reader.onerror = () => {
      setArtworkPrepareState(null);
      setArtworkSaveError('Unable to read selected artwork.');
    };
    reader.readAsDataURL(file);
  };

  const closeArtworkPreview = () => {
    setArtworkPreview(null);
    setArtworkPrepareState(null);
    setArtworkSaveError('');
    setIsSavingArtwork(false);
  };

  const updateArtworkPreview = (updates: Partial<Pick<ArtworkPreview, 'zoom' | 'offsetX' | 'offsetY'>>) => {
    setArtworkPreview((current) => current ? { ...current, ...updates } : current);
  };

  const applyArtworkPreview = async () => {
    if (!artworkPreview || !mediaId) return;
    setIsSavingArtwork(true);
    setArtworkSaveError('');
    try {
      const { target } = artworkPreview;
      const croppedArtwork = await cropArtworkToDataUrl(artworkPreview);
      await saveCustomArtwork(mediaId, target, croppedArtwork, legacyStorageKey);
      onCustomArtworkChange((current) => {
        if (target === 'thumbnail') {
          return { ...current, thumbnail: croppedArtwork, poster: croppedArtwork };
        }
        return { ...current, cover: croppedArtwork };
      });
      await onSaved?.();
      closeArtworkPreview();
    } catch (error) {
      setArtworkSaveError(error instanceof Error ? error.message : 'Unable to save artwork.');
      setIsSavingArtwork(false);
    }
  };

  const activeArtworkTarget = artworkPreview?.target || artworkPrepareState?.target || 'thumbnail';
  const previewConfig = ARTWORK_TARGETS[activeArtworkTarget];
  const artworkDialogOpen = Boolean(artworkPreview || artworkPrepareState || artworkSaveError);

  return (
    <>
      <div
        ref={artworkMenuRef}
        className="loom-no-drag fixed right-[max(1rem,calc(((100vw-12rem-1440px)/2)+1rem))] top-4 z-50 flex items-center gap-2"
      >
        <Button
          type="button"
          variant="ghost"
          aria-label="Fix metadata match"
          title="Fix metadata match"
          onClick={openMetadataCandidates}
          disabled={isFetchingArtwork}
          className={`${isPageScrolled ? 'h-10 w-10 px-0' : 'h-10 px-3'} rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] text-[var(--loom-text)] shadow-lg backdrop-blur-md transition-all duration-200 hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)] disabled:cursor-wait disabled:opacity-70`}
        >
          {isFetchingArtwork ? (
            <Loader2 className={`${isPageScrolled ? '' : 'mr-2'} h-4 w-4 animate-spin text-[var(--loom-accent)]`} />
          ) : (
            <Search className={`${isPageScrolled ? '' : 'mr-2'} h-4 w-4`} />
          )}
          {!isPageScrolled && <span className="text-sm font-medium">Fix Match</span>}
        </Button>
        <div className="relative">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="More artwork options"
            aria-haspopup="menu"
            aria-expanded={artworkMenuOpen}
            onClick={() => setArtworkMenuOpen((open) => !open)}
            className="h-10 w-10 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] text-[var(--loom-text)] shadow-lg backdrop-blur-md transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
          >
            {isFetchingArtwork ? (
              <Loader2 className="h-5 w-5 animate-spin text-[var(--loom-accent)]" />
            ) : (
              <MoreHorizontal className="h-5 w-5" />
            )}
          </Button>
          {artworkMenuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-2 w-60 overflow-hidden rounded-lg bg-[var(--loom-panel)] py-1 shadow-2xl backdrop-blur-md"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setArtworkMenuOpen(false);
                  void refreshOfficialMetadata();
                }}
                disabled={!onFetchOfficialArtwork || isFetchingArtwork}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh metadata
              </button>
              {onOpenFolderPath && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={openFolderPath}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
                >
                  <FolderOpen className="h-4 w-4" />
                  Open folder
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => openArtworkPicker('thumbnail')}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
              >
                <Image className="h-4 w-4" />
                {ARTWORK_TARGETS.thumbnail.menuLabel}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => openArtworkPicker('cover')}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
              >
                <Image className="h-4 w-4" />
                {ARTWORK_TARGETS.cover.menuLabel}
              </button>
            </div>
          )}
        </div>
        <input
          ref={thumbnailInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => handleArtworkFileChange('thumbnail', event)}
        />
        <input
          ref={coverInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => handleArtworkFileChange('cover', event)}
        />
      </div>

      <Dialog
        open={artworkDialogOpen}
        onOpenChange={(open) => { if (!open) closeArtworkPreview(); }}
        contentClassName={activeArtworkTarget === 'cover' ? 'max-w-[min(1440px,calc(100vw-2rem))]' : 'max-w-3xl'}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{previewConfig.label}</DialogTitle>
          </DialogHeader>
          <div className="mt-5 space-y-5">
            {artworkPreview ? (
              <div
                className={`${previewConfig.aspectClass} overflow-hidden rounded-lg border border-white/10 bg-black`}
              >
                <img
                  src={artworkPreview.url}
                  alt={artworkPreview.name}
                  className="h-full w-full object-cover transition-transform"
                  style={{
                    objectPosition: `${clampPercent(50 + artworkPreview.offsetX)}% ${clampPercent(50 + artworkPreview.offsetY)}%`,
                    transform: `scale(${artworkPreview.zoom})`,
                  }}
                />
              </div>
            ) : (
              <div
                className={`${previewConfig.aspectClass} grid place-items-center overflow-hidden rounded-lg border border-white/10 bg-black/40`}
              >
                <div className="px-6 text-center">
                  <p className="text-sm font-medium text-white">
                    {artworkPrepareState ? 'Preparing crop preview...' : 'Artwork preview unavailable'}
                  </p>
                  {artworkPrepareState && (
                    <p className="mt-1 max-w-md truncate text-xs text-[var(--loom-muted)]">{artworkPrepareState.name}</p>
                  )}
                </div>
              </div>
            )}
            {artworkPreview && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--loom-muted)]">
                  <span className="min-w-0 truncate">{artworkPreview.name}</span>
                  <span>{artworkPreview.width} x {artworkPreview.height}</span>
                </div>
                <div className="grid gap-4 rounded-lg bg-[var(--loom-surface-3)] p-4">
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">
                    Zoom
                    <input
                      type="range"
                      min={1}
                      max={3}
                      step={0.01}
                      value={artworkPreview.zoom}
                      onChange={(event) => updateArtworkPreview({ zoom: Number(event.target.value) })}
                      className="w-full accent-[var(--loom-accent)]"
                    />
                  </label>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="grid gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">
                      Horizontal
                      <input
                        type="range"
                        min={-50}
                        max={50}
                        step={1}
                        value={artworkPreview.offsetX}
                        onChange={(event) => updateArtworkPreview({ offsetX: Number(event.target.value) })}
                        className="w-full accent-[var(--loom-accent)]"
                      />
                    </label>
                    <label className="grid gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">
                      Vertical
                      <input
                        type="range"
                        min={-50}
                        max={50}
                        step={1}
                        value={artworkPreview.offsetY}
                        onChange={(event) => updateArtworkPreview({ offsetY: Number(event.target.value) })}
                        className="w-full accent-[var(--loom-accent)]"
                      />
                    </label>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => updateArtworkPreview({ zoom: 1, offsetX: 0, offsetY: 0 })}
                      className="h-8 px-3 text-xs text-[var(--loom-muted)] hover:bg-[var(--loom-surface-2)] hover:text-[var(--loom-text)]"
                    >
                      Reset Crop
                    </Button>
                  </div>
                </div>
              </>
            )}
            {artworkSaveError && (
              <p className="loom-status-error rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">
                {artworkSaveError}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={closeArtworkPreview}
                disabled={isSavingArtwork}
                className="border-[var(--loom-border)] bg-transparent text-[var(--loom-text)] hover:bg-[var(--loom-surface-3)]"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={applyArtworkPreview}
                disabled={!artworkPreview || isSavingArtwork}
                className="bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)] hover:bg-[var(--loom-accent-hover)]"
              >
                {isSavingArtwork ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={metadataDialogOpen}
        onOpenChange={(open) => {
          if (!open && !applyingCandidateId) setMetadataDialogOpen(false);
        }}
        contentClassName="max-w-[560px] border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-0 text-[var(--loom-text)] shadow-none"
      >
        <DialogContent>
          <DialogHeader className="border-b border-[var(--loom-panel-border)] px-5 py-4 pr-14">
            <DialogTitle className="text-base text-[var(--loom-text)]">Choose Metadata</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setMetadataDialogOpen(false)}
              disabled={Boolean(applyingCandidateId)}
              aria-label="Close metadata picker"
              className="absolute right-3 top-3 h-9 w-9 rounded-lg text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]"
            >
              <X className="h-4 w-4" />
            </Button>
          </DialogHeader>
          <div className="space-y-4 p-5">
            <p className="text-sm text-[var(--loom-muted)]">
              Select the result you want to apply. LoomTV will update the poster, cover, summary, rating, genres, and episode names from that source.
            </p>
            {metadataCandidates.length === 0 ? (
              <div className="rounded-lg bg-[var(--loom-surface-2)] p-6 text-sm text-[var(--loom-muted)]">
                No matching metadata was found from the connected metadata APIs.
              </div>
            ) : (
              <div className="grid max-h-[62vh] gap-2 overflow-y-auto pr-1">
                {metadataCandidates.map((candidate) => {
                  const posterImage = candidate.thumbnail || candidate.posterCandidates?.[0] || '';
                  const coverImage = candidate.cover || candidate.backdropCandidates?.[0] || posterImage;
                  const isApplying = applyingCandidateId === candidate.id;
                  return (
                    <div
                      key={candidate.id}
                      className="grid gap-3 rounded-lg bg-[var(--loom-surface-2)] p-3"
                    >
                      <div className="grid min-w-0 grid-cols-[58px_1fr] gap-3">
                        <div className="h-[86px] w-[58px] overflow-hidden rounded-md bg-[var(--loom-surface)]">
                          {posterImage ? (
                            <img src={posterImage} alt={candidate.title} className="h-full w-full object-cover" />
                          ) : (
                            <div className="grid h-full place-items-center text-white/30">
                              <Image className="h-5 w-5" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 space-y-2">
                          <div className="flex min-w-0 items-start justify-between gap-2">
                            <div className="min-w-0">
                              <h3 className="truncate text-sm font-semibold text-[var(--loom-text)]">{candidate.title}</h3>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                {candidate.year ? <span className="text-xs text-[var(--loom-muted)]">{candidate.year}</span> : null}
                                <span className="rounded-full border border-[var(--loom-panel-border)] px-2 py-0.5 text-[11px] text-[var(--loom-muted)]">{candidate.source}</span>
                                {candidate.rating ? (
                                  <span className="loom-rating inline-flex items-center gap-1 rounded-full bg-[#f5c451]/15 px-2 py-0.5 text-[11px] font-medium">
                                    <Star className="h-3 w-3 fill-current" />
                                    {candidate.rating.toFixed(1)}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </div>
                          {candidate.summary ? (
                            <p className="line-clamp-1 text-xs leading-5 text-[var(--loom-muted)]">{candidate.summary}</p>
                          ) : (
                            <p className="text-xs text-[var(--loom-muted)]">No summary provided.</p>
                          )}
                          <div className="h-12 overflow-hidden rounded-md bg-[var(--loom-surface)]">
                            {coverImage ? (
                              <img src={coverImage} alt={`${candidate.title} cover`} className="h-full w-full object-cover" />
                            ) : (
                              <div className="grid h-full place-items-center text-[11px] text-white/30">No cover</div>
                            )}
                          </div>
                          {candidate.episodePreview?.length ? (
                            <div className="rounded-md bg-[var(--loom-surface)] px-2.5 py-2">
                              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--loom-faint)]">
                                {candidate.episodeCount || candidate.episodePreview.length} episodes
                              </p>
                              <div className="space-y-0.5">
                                {candidate.episodePreview.slice(0, 3).map((episodeName) => (
                                  <p key={episodeName} className="truncate text-xs text-[var(--loom-muted)]">{episodeName}</p>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        {candidate.genres?.length ? (
                          <p className="min-w-0 flex-1 truncate text-[11px] text-[var(--loom-faint)]">{candidate.genres.slice(0, 3).join(' • ')}</p>
                        ) : <span />}
                        <Button
                          type="button"
                          onClick={() => applyMetadataCandidate(candidate)}
                          disabled={Boolean(applyingCandidateId)}
                          className="h-8 bg-[var(--loom-accent)] px-3 text-xs text-[var(--loom-accent-foreground)] hover:bg-[var(--loom-accent-hover)]"
                        >
                          {isApplying ? 'Applying...' : 'Apply'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {metadataError && (
              <p className="loom-status-error rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">
                {metadataError}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
