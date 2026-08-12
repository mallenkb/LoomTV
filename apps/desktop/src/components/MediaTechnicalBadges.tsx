import { AudioLines, Captions } from 'lucide-react';
import type { MediaItem } from '@/contexts/LibraryContext';

type TechnicalMediaItem = Pick<MediaItem, 'type' | 'localMetadata' | 'episodeFiles' | 'subtitles'>;

function mediaDetails(item: TechnicalMediaItem): MediaItem['localMetadata'] {
  if (item.type === 'movie') return item.localMetadata;
  const episodeDetails = item.episodeFiles?.find((episode) => Boolean(episode.localMetadata))?.localMetadata;
  if (!episodeDetails) return item.localMetadata;
  return { ...episodeDetails, ...item.localMetadata };
}

function resolutionLabel(width?: number, height?: number): string {
  if (!width || !height) return '';
  if (width >= 3840 || height >= 2160) return '4K';
  if (width >= 1280 || height >= 720) return 'HD';
  return 'SD';
}

function audioLabel(audioCodec?: string): string {
  return audioCodec?.trim().replace(/[._-]+/g, ' ').toUpperCase() || '';
}

export function mediaTechnicalMetadata(item: TechnicalMediaItem) {
  const details = mediaDetails(item);
  return {
    resolution: resolutionLabel(details?.width, details?.height),
    audio: audioLabel(details?.audioCodec),
    hasSubtitles: Boolean((details?.subtitleTracks || 0) > 0 || item.subtitles?.length),
  };
}

export default function MediaTechnicalBadges({ item }: { item: TechnicalMediaItem }) {
  const metadata = mediaTechnicalMetadata(item);

  return (
    <>
      {metadata.resolution && (
        <span className="rounded bg-white/90 px-1.5 py-px text-[0.6875rem] font-bold leading-4 text-black shadow-none [text-shadow:none]">
          {metadata.resolution}
        </span>
      )}
      {metadata.audio && (
        <span className="inline-flex items-center gap-1 text-xs leading-4 [text-shadow:none]">
          <AudioLines className="h-3 w-3" />
          {metadata.audio}
        </span>
      )}
      {metadata.hasSubtitles && (
        <span className="inline-flex items-center gap-1 rounded-md border border-[var(--loom-muted)]/80 bg-[var(--loom-surface-3)] px-1.5 py-px text-[0.6875rem] font-medium leading-4 text-[var(--loom-text)] shadow-none backdrop-blur-[12px] [text-shadow:none]">
          <Captions className="h-3 w-3" />
          CC
        </span>
      )}
    </>
  );
}
