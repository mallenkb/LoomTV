import { useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { useModalLayer } from '@/components/ui/dialog';
import { youtubeEmbedUrl, youtubeVideoId } from '../shared/externalPlayback.ts';

interface TrailerDialogProps {
  open: boolean;
  title: string;
  trailerUrl?: string;
  /** Accessible name; defaults to "<title> trailer". */
  label?: string;
  onClose: () => void;
}

export default function TrailerDialog({ open, title, trailerUrl, label, onClose }: TrailerDialogProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const videoId = useMemo(() => youtubeVideoId(trailerUrl), [trailerUrl]);
  const isOpen = open && Boolean(videoId);

  useModalLayer({ open: isOpen, contentRef, onClose });

  if (!isOpen) return null;

  const embedUrl = youtubeEmbedUrl(videoId);

  return (
    <div
      className="loom-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-label={label || `${title} trailer`}
        tabIndex={-1}
        className="relative aspect-video w-full max-w-5xl overflow-hidden rounded-2xl border border-[var(--loom-panel-border)] bg-black shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close trailer"
          className="absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white/80 transition-colors hover:bg-black/85 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>
        <iframe
          title={`${title} trailer`}
          src={embedUrl}
          className="absolute inset-0 h-full w-full border-0"
          allow="autoplay; encrypted-media; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </div>
  );
}
