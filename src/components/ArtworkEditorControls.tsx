import React, { useEffect, useRef, useState } from 'react';
import { Image, Loader2, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { saveCustomArtwork } from '@/lib/customArtwork';
import { useToast } from '@/components/ToastProvider';

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
  onSaved?: () => Promise<void> | void;
  officialThumbnailSources?: string[];
  officialCoverSources?: string[];
  fallbackFrameSource?: string;
  onFetchOfficialArtwork?: () => Promise<OfficialArtworkResult>;
}

export default function ArtworkEditorControls({
  mediaId,
  legacyStorageKey,
  onCustomArtworkChange,
  onSaved,
  officialThumbnailSources = [],
  officialCoverSources = [],
  fallbackFrameSource = '',
  onFetchOfficialArtwork,
}: ArtworkEditorControlsProps) {
  const [artworkMenuOpen, setArtworkMenuOpen] = useState(false);
  const [artworkPreview, setArtworkPreview] = useState<ArtworkPreview | null>(null);
  const [artworkPrepareState, setArtworkPrepareState] = useState<ArtworkPrepareState | null>(null);
  const [isSavingArtwork, setIsSavingArtwork] = useState(false);
  const [isFetchingArtwork, setIsFetchingArtwork] = useState(false);
  const [artworkSaveError, setArtworkSaveError] = useState('');
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
  }, [mediaId]);

  const openArtworkPicker = (target: ArtworkTarget) => {
    const input = target === 'cover' ? coverInputRef.current : thumbnailInputRef.current;
    input?.click();
    setArtworkMenuOpen(false);
  };

  const applyAutomaticArtwork = async () => {
    if (!mediaId || isFetchingArtwork) return;

    setIsFetchingArtwork(true);
    setArtworkSaveError('');
    try {
      let refreshedArtwork: OfficialArtworkResult | null = null;
      let officialFetchFailed = false;
      try {
        refreshedArtwork = onFetchOfficialArtwork ? await onFetchOfficialArtwork() : null;
      } catch (error) {
        officialFetchFailed = true;
        console.error('Official artwork refresh failed:', error);
      }
      const hasFreshOfficialArtwork = Boolean(refreshedArtwork?.thumbnail || refreshedArtwork?.cover);
      if (onFetchOfficialArtwork && (!hasFreshOfficialArtwork || officialFetchFailed)) {
        showToast({
          title: 'Official artwork was not found',
          description: fallbackFrameSource
            ? 'I could not get a matching poster or cover from the metadata APIs, so I used a video frame for now.'
            : 'I could not get a matching poster or cover from the metadata APIs. Check your metadata keys and try again.',
          tone: officialFetchFailed ? 'error' : 'warning',
        });
      }

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
        setArtworkSaveError('No official artwork or video frame is available yet.');
        setArtworkMenuOpen(false);
        return;
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
    } catch (error) {
      setArtworkSaveError(error instanceof Error ? error.message : 'Unable to update artwork.');
    } finally {
      setIsFetchingArtwork(false);
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
        className="fixed right-[max(1rem,calc(((100vw-12rem-1440px)/2)+1rem))] top-4 z-50"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="More artwork options"
          aria-haspopup="menu"
          aria-expanded={artworkMenuOpen}
          onClick={() => setArtworkMenuOpen((open) => !open)}
          className="h-10 w-10 rounded-lg border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md hover:bg-white/10 hover:text-[var(--loom-accent)]"
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
            className="absolute right-0 mt-2 w-60 overflow-hidden rounded-lg border border-white/10 bg-[var(--loom-surface)]/95 py-1 shadow-2xl backdrop-blur-md"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => openArtworkPicker('thumbnail')}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 hover:text-[var(--loom-accent)]"
            >
              <Image className="h-4 w-4" />
              {ARTWORK_TARGETS.thumbnail.menuLabel}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => openArtworkPicker('cover')}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 hover:text-[var(--loom-accent)]"
            >
              <Image className="h-4 w-4" />
              {ARTWORK_TARGETS.cover.menuLabel}
            </button>
            <div className="my-1 h-px bg-white/10" />
            <button
              type="button"
              role="menuitem"
              onClick={applyAutomaticArtwork}
              disabled={isFetchingArtwork}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 hover:text-[var(--loom-accent)] disabled:cursor-wait disabled:opacity-60"
            >
              {isFetchingArtwork ? (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--loom-accent)]" />
              ) : (
                <Image className="h-4 w-4" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {isFetchingArtwork ? 'Fetching official artwork...' : 'Fetch official artwork'}
              </span>
            </button>
          </div>
        )}
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
                <div className="grid gap-4 rounded-lg bg-white/[0.06] p-4">
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-wide text-white/65">
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
                    <label className="grid gap-2 text-xs font-semibold uppercase tracking-wide text-white/65">
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
                    <label className="grid gap-2 text-xs font-semibold uppercase tracking-wide text-white/65">
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
                      className="h-8 px-3 text-xs text-white/70 hover:bg-white/10 hover:text-white"
                    >
                      Reset Crop
                    </Button>
                  </div>
                </div>
              </>
            )}
            {artworkSaveError && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {artworkSaveError}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={closeArtworkPreview}
                disabled={isSavingArtwork}
                className="border-white/15 bg-transparent text-white hover:bg-white/10"
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
    </>
  );
}
