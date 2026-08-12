import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Image, Loader2, MoreHorizontal, PanelsTopLeft, RefreshCw, Search, Star, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { saveCustomArtwork } from '@/lib/customArtwork';
import { useToast } from '@/components/ToastProvider';
import { desktopApi, type OfficialArtworkRefreshTarget, type OfficialMetadataApplyTarget, type OfficialMetadataCandidate } from '@/lib/desktopApi';

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

type MetadataArtworkChoice = {
  id: string;
  imageUrl: string;
  candidate: OfficialMetadataCandidate;
};

type ArtworkDimensions = {
  width: number;
  height: number;
};

const ARTWORK_PROVIDER_PRIORITY: Record<OfficialMetadataCandidate['source'], number> = {
  AniList: 0,
  TMDB: 1,
  Jikan: 2,
  TVmaze: 3,
  OMDb: 4,
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

function artworkResolutionTag(
  dimensions: ArtworkDimensions | undefined,
  target: OfficialMetadataApplyTarget,
): 'High-res' | 'HD' | null {
  if (!dimensions) return null;

  if (target === 'cover') {
    if (dimensions.width >= 1920 && dimensions.height >= 1080) return 'High-res';
    if (dimensions.width >= 1280 && dimensions.height >= 720) return 'HD';
    return null;
  }

  if (dimensions.width >= 1000 && dimensions.height >= 1500) return 'High-res';
  if (dimensions.width >= 800 && dimensions.height >= 1200) return 'HD';
  return null;
}

function fileManagerActionLabel(): string {
  const platform = typeof navigator === 'undefined'
    ? ''
    : `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
  if (platform.includes('mac')) return 'Reveal in Finder';
  if (platform.includes('win')) return 'Show in Explorer';
  return 'Show in File Manager';
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
  revealPath?: string;
  onFetchOfficialArtwork?: (target?: OfficialArtworkRefreshTarget) => Promise<OfficialArtworkResult>;
  onFetchOfficialArtworkCandidates?: () => Promise<OfficialMetadataCandidate[]>;
  onApplyOfficialArtworkCandidate?: (candidate: OfficialMetadataCandidate, target?: OfficialMetadataApplyTarget) => Promise<OfficialArtworkResult>;
  refreshMetadataState?: 'idle' | 'loading' | 'success' | 'error';
  onRefreshIncompleteMetadata?: () => Promise<void> | void;
}

export default function ArtworkEditorControls({
  mediaId,
  legacyStorageKey,
  onCustomArtworkChange,
  onSaved,
  officialThumbnailSources = [],
  officialCoverSources = [],
  fallbackFrameSource = '',
  revealPath = '',
  onFetchOfficialArtwork,
  onFetchOfficialArtworkCandidates,
  onApplyOfficialArtworkCandidate,
  refreshMetadataState = 'idle',
  onRefreshIncompleteMetadata,
}: ArtworkEditorControlsProps) {
  const [artworkMenuOpen, setArtworkMenuOpen] = useState(false);
  const [artworkPreview, setArtworkPreview] = useState<ArtworkPreview | null>(null);
  const [artworkPrepareState, setArtworkPrepareState] = useState<ArtworkPrepareState | null>(null);
  const [isSavingArtwork, setIsSavingArtwork] = useState(false);
  const [isFetchingArtwork, setIsFetchingArtwork] = useState(false);
  const [metadataCandidates, setMetadataCandidates] = useState<OfficialMetadataCandidate[]>([]);
  const [metadataDialogOpen, setMetadataDialogOpen] = useState(false);
  const [metadataApplyTarget, setMetadataApplyTarget] = useState<OfficialMetadataApplyTarget>('all');
  const [applyingCandidateId, setApplyingCandidateId] = useState('');
  const [metadataError, setMetadataError] = useState('');
  const [failedMetadataArtwork, setFailedMetadataArtwork] = useState<Set<string>>(() => new Set());
  const [metadataArtworkDimensions, setMetadataArtworkDimensions] = useState<Record<string, ArtworkDimensions>>({});
  const [artworkSaveError, setArtworkSaveError] = useState('');
  const [isPageScrolled, setIsPageScrolled] = useState(false);
  const artworkMenuRef = useRef<HTMLDivElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const thumbnailInputRef = useRef<HTMLInputElement | null>(null);
  const { showToast } = useToast();
  const revealLabel = fileManagerActionLabel();
  const canRevealLocalFile = Boolean(
    revealPath.trim()
    && typeof window !== 'undefined'
    && window.desktopApi?.openFolderPath,
  );

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
    setMetadataApplyTarget('all');
    setApplyingCandidateId('');
    setMetadataError('');
    setFailedMetadataArtwork(new Set());
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

  const revealLocalFile = async () => {
    if (!canRevealLocalFile) return;
    setArtworkMenuOpen(false);
    try {
      await desktopApi.openFolderPath(revealPath);
    } catch (error) {
      showToast({
        title: 'Unable to open file location',
        description: error instanceof Error ? error.message : 'The local file location could not be opened.',
        tone: 'error',
      });
    }
  };

  const saveOfficialArtwork = async (
    refreshedArtwork: OfficialArtworkResult | null,
    target: OfficialArtworkRefreshTarget = 'all',
  ) => {
    const thumbnailSource = target !== 'cover' ? (
      refreshedArtwork?.thumbnail
      || refreshedArtwork?.posterCandidates?.find(Boolean)
      || officialThumbnailSources.find(Boolean)
      || fallbackFrameSource
    ) : '';
    const coverSource = target !== 'poster' ? (
      refreshedArtwork?.cover
      || refreshedArtwork?.backdropCandidates?.find(Boolean)
      || refreshedArtwork?.thumbnail
      || officialCoverSources.find(Boolean)
      || officialThumbnailSources.find(Boolean)
      || fallbackFrameSource
    ) : '';

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

  const openMetadataCandidates = async (target: OfficialMetadataApplyTarget = 'all') => {
    if (!mediaId || isFetchingArtwork) return;

    setArtworkMenuOpen(false);
    setMetadataApplyTarget(target);
    setIsFetchingArtwork(true);
    setArtworkSaveError('');
    setMetadataError('');
    setFailedMetadataArtwork(new Set());
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

      const artworkTarget = target === 'poster' || target === 'cover' ? target : 'all';
      const refreshedArtwork = onFetchOfficialArtwork ? await onFetchOfficialArtwork(artworkTarget) : null;
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
      await saveOfficialArtwork(refreshedArtwork, artworkTarget);
    } catch (error) {
      setMetadataError(error instanceof Error ? error.message : 'Unable to refresh metadata.');
      setMetadataDialogOpen(true);
    } finally {
      setIsFetchingArtwork(false);
    }
  };

  const applyMetadataCandidate = async (candidate: OfficialMetadataCandidate) => {
    if (!onApplyOfficialArtworkCandidate || applyingCandidateId) return;
    setApplyingCandidateId(candidate.id);
    setMetadataError('');
    try {
      const refreshedArtwork = await onApplyOfficialArtworkCandidate(candidate, metadataApplyTarget);
      if (metadataApplyTarget === 'episodes') {
        await onSaved?.();
      } else {
        await saveOfficialArtwork(refreshedArtwork, metadataApplyTarget);
      }
      setMetadataDialogOpen(false);
      const appliedLabel = metadataApplyTarget === 'poster'
        ? 'Poster'
        : metadataApplyTarget === 'cover'
          ? 'Cover'
          : metadataApplyTarget === 'episodes'
            ? 'Episode names'
            : 'Metadata';
      showToast({
        title: `${appliedLabel} updated`,
        description: `${appliedLabel} from ${candidate.title} on ${candidate.source} was applied.`,
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
  const metadataDialogTitle = metadataApplyTarget === 'poster'
    ? 'Choose Poster'
    : metadataApplyTarget === 'cover'
      ? 'Choose Cover'
      : metadataApplyTarget === 'episodes'
        ? 'Choose Episode Names'
        : 'Choose Metadata';
  const metadataDialogDescription = metadataApplyTarget === 'poster'
    ? 'Choose any poster returned by the connected metadata providers. Only the poster and thumbnail will change, and your selection will be saved to the library database.'
    : metadataApplyTarget === 'cover'
      ? 'Choose any cover returned by the connected metadata providers. Only the cover will change, and your selection will be saved to the library database.'
      : metadataApplyTarget === 'episodes'
        ? 'Choose a match to replace only the episode names. Artwork and the rest of the show metadata will stay unchanged.'
        : 'Select the result you want to apply. LoomTV will update the poster, cover, summary, rating, genres, and episode names from that source.';
  const isArtworkTarget = metadataApplyTarget === 'cover' || metadataApplyTarget === 'poster';
  const metadataArtworkChoices = useMemo<MetadataArtworkChoice[]>(() => {
    if (!isArtworkTarget) return [];

    const seen = new Set<string>();
    const choices = metadataCandidates.flatMap((candidate) => {
      const urls = metadataApplyTarget === 'cover'
        ? [candidate.cover, ...(candidate.backdropCandidates || [])]
        : [candidate.thumbnail, ...(candidate.posterCandidates || [])];
      const availableUrls = [...new Set(
        urls.filter((url): url is string => Boolean(url && !failedMetadataArtwork.has(url))),
      )];

      return availableUrls.flatMap((imageUrl) => {
        const key = `${candidate.source}:${imageUrl}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ candidate, imageUrl }];
      });
    }).sort((left, right) => (
      ARTWORK_PROVIDER_PRIORITY[left.candidate.source] - ARTWORK_PROVIDER_PRIORITY[right.candidate.source]
    ));
    const positions = new Map<OfficialMetadataCandidate['source'], number>();

    return choices.map(({ candidate, imageUrl }) => {
      const providerIndex = (positions.get(candidate.source) || 0) + 1;
      positions.set(candidate.source, providerIndex);
      const id = `${candidate.id}:${metadataApplyTarget}:${providerIndex}`;
      const selectedArtwork = metadataApplyTarget === 'cover'
        ? { cover: imageUrl, backdropCandidates: [imageUrl] }
        : { thumbnail: imageUrl, posterCandidates: [imageUrl] };
      return {
        id,
        imageUrl,
        candidate: {
          ...candidate,
          id,
          ...selectedArtwork,
        },
      };
    });
  }, [failedMetadataArtwork, isArtworkTarget, metadataApplyTarget, metadataCandidates]);
  const visibleMetadataCandidates = useMemo(() => {
    if (metadataApplyTarget === 'episodes') return metadataCandidates;

    return metadataCandidates.filter((candidate) => {
      const posterImages = [candidate.thumbnail, ...(candidate.posterCandidates || [])];
      const coverImages = [candidate.cover, ...(candidate.backdropCandidates || [])];
      return [...posterImages, ...coverImages].some((url) => (
        Boolean(url && !failedMetadataArtwork.has(url))
      ));
    });
  }, [failedMetadataArtwork, metadataApplyTarget, metadataCandidates]);
  const metadataApplyLabel = metadataApplyTarget === 'poster'
    ? 'Use poster'
    : metadataApplyTarget === 'cover'
      ? 'Use cover'
      : metadataApplyTarget === 'episodes'
        ? 'Use names'
        : 'Apply';

  return (
    <>
      <div
        ref={artworkMenuRef}
        className="loom-artwork-editor-controls loom-no-drag fixed top-6 z-50 flex items-center gap-2"
      >
        <Button
          type="button"
          variant="ghost"
          aria-label="Update metadata"
          title="Update metadata"
          onClick={() => void openMetadataCandidates('all')}
          disabled={isFetchingArtwork}
          className={`loom-artwork-fix-button ${isPageScrolled ? 'h-10 w-10 px-0' : 'h-10 px-3'} rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] text-[var(--loom-text)] shadow-lg backdrop-blur-md transition-all duration-200 hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)] disabled:cursor-wait disabled:opacity-70`}
        >
          {isFetchingArtwork ? (
            <Loader2 className={`${isPageScrolled ? '' : 'mr-2'} h-4 w-4 animate-spin text-[var(--loom-accent)]`} />
          ) : (
            <Search className={`${isPageScrolled ? '' : 'mr-2'} h-4 w-4`} />
          )}
          {!isPageScrolled && <span className="text-sm font-medium">Update Metadata</span>}
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
            className="loom-artwork-more-button h-10 w-10 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] text-[var(--loom-text)] shadow-lg backdrop-blur-md transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
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
              className="absolute right-0 top-full mt-2 w-72 overflow-hidden rounded-lg bg-[var(--loom-panel)] py-1 shadow-2xl backdrop-blur-md"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => void openMetadataCandidates('all')}
                disabled={!onFetchOfficialArtworkCandidates || isFetchingArtwork}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)] disabled:cursor-wait disabled:opacity-70"
              >
                <Search className="h-4 w-4" />
                Update Metadata
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void openMetadataCandidates('poster')}
                disabled={!onFetchOfficialArtworkCandidates || isFetchingArtwork}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)] disabled:cursor-wait disabled:opacity-70"
              >
                <Image className="h-4 w-4" />
                Choose poster image
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void openMetadataCandidates('cover')}
                disabled={!onFetchOfficialArtworkCandidates || isFetchingArtwork}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)] disabled:cursor-wait disabled:opacity-70"
              >
                <PanelsTopLeft className="h-4 w-4" />
                Choose cover / banner image
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setArtworkMenuOpen(false);
                  void onRefreshIncompleteMetadata?.();
                }}
                disabled={!onRefreshIncompleteMetadata || refreshMetadataState === 'loading'}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)] disabled:cursor-wait disabled:opacity-70"
              >
                {refreshMetadataState === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {refreshMetadataState === 'loading'
                  ? 'Refreshing missing…'
                  : refreshMetadataState === 'success'
                    ? 'Missing metadata refreshed'
                    : refreshMetadataState === 'error'
                      ? 'Refresh failed'
                      : 'Refresh Missing'}
              </button>
              <div role="separator" className="my-1 border-t border-[var(--loom-control-border)]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => void revealLocalFile()}
                disabled={!canRevealLocalFile}
                title={canRevealLocalFile ? revealLabel : 'No local file is available for this title'}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FolderOpen className="h-4 w-4" />
                {revealLabel}
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
            <DialogDescription className="sr-only">Preview and adjust the selected artwork before saving it.</DialogDescription>
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
        contentClassName="max-h-[calc(100vh-8rem)] max-w-[min(944px,calc(100vw-2rem))] overflow-hidden border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-0 text-[var(--loom-text)] shadow-none"
      >
        <DialogContent>
          <DialogHeader className="border-b border-[var(--loom-panel-border)] px-5 py-4 pr-14">
            <DialogTitle className="text-base text-[var(--loom-text)]">{metadataDialogTitle}</DialogTitle>
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
          <div className="space-y-4 p-4 sm:p-5">
            <DialogDescription className={isArtworkTarget ? 'sr-only' : 'text-[var(--loom-muted)]'}>
              {metadataDialogDescription}
            </DialogDescription>
            {(isArtworkTarget ? metadataArtworkChoices.length : visibleMetadataCandidates.length) === 0 ? (
              <div className="rounded-lg bg-[var(--loom-surface-2)] p-6 text-sm text-[var(--loom-muted)]">
                {isArtworkTarget
                  ? `None of the matching results provide a ${metadataApplyTarget === 'cover' ? 'cover' : 'poster'} image.`
                  : 'No matching metadata was found from the connected metadata APIs.'}
              </div>
            ) : (
              <div className={`grid max-h-[calc(100vh-18rem)] gap-3 overflow-y-auto pr-1 ${isArtworkTarget ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : ''}`}>
                {isArtworkTarget ? metadataArtworkChoices.map((choice) => {
                  const { candidate, imageUrl } = choice;
                  const isApplying = applyingCandidateId === candidate.id;
                  const artworkLabel = metadataApplyTarget === 'cover' ? 'cover' : 'poster';
                  const dimensions = metadataArtworkDimensions[imageUrl];
                  const resolutionTag = artworkResolutionTag(dimensions, metadataApplyTarget);
                  return (
                    <div
                      key={choice.id}
                      className={`group relative overflow-hidden rounded-xl border border-[var(--loom-panel-border)] bg-[var(--loom-surface-2)] shadow-sm ${metadataApplyTarget === 'cover' ? 'aspect-[16/10]' : 'aspect-[2/3]'}`}
                    >
                      <img
                        src={imageUrl}
                        alt={`${candidate.title} ${artworkLabel} from ${candidate.source}`}
                        onLoad={(event) => {
                          const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                          setMetadataArtworkDimensions((current) => {
                            const existing = current[imageUrl];
                            if (existing?.width === width && existing.height === height) return current;
                            return { ...current, [imageUrl]: { width, height } };
                          });
                        }}
                        onError={() => setFailedMetadataArtwork((current) => {
                          const next = new Set(current);
                          next.add(imageUrl);
                          return next;
                        })}
                        className="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                      />
                      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
                        <span className="rounded-full border border-white/15 bg-black/75 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm">
                          {candidate.source}
                        </span>
                        {resolutionTag ? (
                          <span
                            title={`${dimensions?.width} × ${dimensions?.height}`}
                            className="rounded-full border border-white/20 bg-black/80 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white shadow-sm"
                          >
                            {resolutionTag}
                          </span>
                        ) : null}
                      </div>
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-2 bg-black/75 p-3 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                        <Button
                          type="button"
                          onClick={() => applyMetadataCandidate(candidate)}
                          disabled={Boolean(applyingCandidateId)}
                          aria-label={`${metadataApplyLabel} ${candidate.title} from ${candidate.source}`}
                          className="h-9 rounded-lg border border-white/20 bg-white px-3 text-xs font-semibold text-black shadow-sm transition-colors hover:bg-white/90 disabled:bg-white/70"
                        >
                          {isApplying ? 'Applying...' : metadataApplyLabel}
                        </Button>
                      </div>
                    </div>
                  );
                }) : visibleMetadataCandidates.map((candidate) => {
                  const posterImage = [candidate.thumbnail, ...(candidate.posterCandidates || [])]
                    .find((url) => Boolean(url && !failedMetadataArtwork.has(url))) || '';
                  const candidateCoverImage = [candidate.cover, ...(candidate.backdropCandidates || [])]
                    .find((url) => Boolean(url && !failedMetadataArtwork.has(url))) || '';
                  const coverImage = candidateCoverImage || posterImage;
                  const isApplying = applyingCandidateId === candidate.id;
                  const candidateSupportsTarget = metadataApplyTarget === 'all'
                    || (metadataApplyTarget === 'episodes' && Boolean(candidate.episodes?.length));
                  return (
                    <div
                      key={candidate.id}
                      className="grid gap-4 rounded-xl border border-[var(--loom-panel-border)] bg-[var(--loom-surface-2)] p-4"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <h3 className="min-w-0 text-lg font-semibold leading-tight text-[var(--loom-text)]">{candidate.title}</h3>
                        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                          {candidate.year ? <span className="text-xs text-[var(--loom-muted)]">{candidate.year}</span> : null}
                          <span className="rounded-full border border-[var(--loom-panel-border)] px-2 py-0.5 text-[11px] text-[var(--loom-muted)]">{candidate.source}</span>
                          {candidate.rating ? (
                            <span className="loom-rating inline-flex items-center gap-1 rounded-full bg-[var(--loom-rating-surface)] px-2 py-0.5 text-[11px] font-medium">
                              <Star className="h-3 w-3 fill-current" />
                              {candidate.rating.toFixed(1)}
                            </span>
                          ) : null}
                        </div>
                        </div>
                        {candidate.summary ? (
                          <p className="mt-3 truncate text-sm leading-5 text-[var(--loom-muted)]">{candidate.summary}</p>
                        ) : (
                          <p className="mt-3 truncate text-sm text-[var(--loom-muted)]">No summary provided.</p>
                        )}
                      </div>
                      <div className="grid min-w-0 grid-cols-1 items-stretch gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(220px,1fr)]">
                        <div className="grid min-w-0 grid-cols-1 items-stretch gap-4 md:h-[254px] md:grid-cols-[169px_minmax(0,1fr)]">
                        <div className="mx-auto h-[254px] w-[169px] shrink-0 overflow-hidden rounded-lg bg-[var(--loom-surface)] shadow-lg md:mx-0">
                          {posterImage ? (
                            <img
                              src={posterImage}
                              alt={candidate.title}
                              onError={() => setFailedMetadataArtwork((current) => {
                                const next = new Set(current);
                                next.add(posterImage);
                                return next;
                              })}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="grid h-full place-items-center text-white/30">
                              <Image className="h-5 w-5" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 self-stretch">
                          <div className="aspect-video h-[254px] max-w-full overflow-hidden rounded-lg bg-black/40">
                            {coverImage ? (
                              <img
                                src={coverImage}
                                alt={`${candidate.title} cover`}
                                onError={() => setFailedMetadataArtwork((current) => {
                                  const next = new Set(current);
                                  next.add(coverImage);
                                  return next;
                                })}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="grid h-full place-items-center text-[11px] text-white/30">No cover</div>
                            )}
                          </div>
                        </div>
                        </div>
                        {candidate.episodePreview?.length ? (
                          <aside className="hidden h-[254px] min-h-0 min-w-0 w-full self-stretch overflow-y-auto rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-surface)] p-4 xl:col-span-1 xl:block">
                              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--loom-faint)]">
                                {candidate.episodeCount || candidate.episodePreview.length} episodes
                              </p>
                              <div className="space-y-2">
                                {candidate.episodePreview.slice(0, 4).map((episodeName) => (
                                  <p key={episodeName} className="line-clamp-2 border-b border-[var(--loom-panel-border)] pb-2 text-xs leading-5 text-[var(--loom-muted)] last:border-b-0 last:pb-0">{episodeName}</p>
                                ))}
                              </div>
                          </aside>
                        ) : (
                          <div className="hidden xl:block" />
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        {candidate.genres?.length ? (
                          <p className="min-w-0 flex-1 truncate text-[11px] text-[var(--loom-faint)]">{candidate.genres.slice(0, 3).join(' • ')}</p>
                        ) : <span />}
                        <Button
                          type="button"
                          onClick={() => applyMetadataCandidate(candidate)}
                          disabled={Boolean(applyingCandidateId) || !candidateSupportsTarget}
                          className="h-8 rounded-lg border border-white bg-white px-3 text-xs font-semibold text-black shadow-sm transition-colors hover:bg-white/90 disabled:border-white/40 disabled:bg-white/40 disabled:text-black/60"
                        >
                          {isApplying ? 'Applying...' : candidateSupportsTarget ? metadataApplyLabel : 'Unavailable'}
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
