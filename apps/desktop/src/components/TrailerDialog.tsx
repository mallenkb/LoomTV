import { useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { useModalLayer } from '@/components/ui/dialog';

function youtubeVideoId(value?: string): string {
  if (!value) return '';

  try {
    const rawValue = value.trim();
    if (/^[A-Za-z0-9_-]{6,}$/.test(rawValue)) return rawValue;
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let candidate = '';

    if (host === 'youtu.be') {
      candidate = url.pathname.split('/').filter(Boolean)[0] || '';
    } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') candidate = url.searchParams.get('v') || '';
      else if (url.pathname.startsWith('/embed/')) candidate = url.pathname.split('/').filter(Boolean)[1] || '';
      else if (url.pathname.startsWith('/shorts/')) candidate = url.pathname.split('/').filter(Boolean)[1] || '';
      else if (url.pathname.startsWith('/live/')) candidate = url.pathname.split('/').filter(Boolean)[1] || '';
    }

    return /^[A-Za-z0-9_-]{6,}$/.test(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

interface TrailerDialogProps {
  open: boolean;
  title: string;
  trailerUrl?: string;
  onClose: () => void;
}

export default function TrailerDialog({ open, title, trailerUrl, onClose }: TrailerDialogProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const videoId = useMemo(() => youtubeVideoId(trailerUrl), [trailerUrl]);
  const isOpen = open && Boolean(videoId);

  useModalLayer({ open: isOpen, contentRef, onClose });

  if (!isOpen) return null;

  const embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;

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
        aria-label={`${title} trailer`}
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
