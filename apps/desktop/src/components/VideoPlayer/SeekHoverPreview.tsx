import { useEffect, useRef, useState } from 'react';
import SeekPreviewCache from './SeekPreviewCache';
import { formatTime } from './helpers';

export default function SeekHoverPreview({ filePath, duration, sliderRef, visible, playbackPositionRef }: {
  filePath: string;
  visible: boolean;
  playbackPositionRef: React.RefObject<number>;
  duration: number;
  sliderRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [hover, setHover] = useState<{ seconds: number; left: number; width: number } | null>(null);
  const cache = useRef<SeekPreviewCache | null>(null);
  const [, refresh] = useState(0);

  useEffect(() => {
    const previews = new SeekPreviewCache(filePath, duration, () => refresh((value) => value + 1));
    cache.current = previews;
    previews.request(playbackPositionRef.current);
    return () => { previews.dispose(); cache.current = null; };
  }, [filePath, duration, playbackPositionRef]);

  useEffect(() => {
    if (!visible) setHover(null);
  }, [visible]);

  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;
    let animation: number | null = null;
    const hide = () => {
      if (animation !== null) cancelAnimationFrame(animation);
      animation = null;
      setHover(null);
    };
    const move = (event: PointerEvent) => {
      // The slider captures drag events; this preview never issues seek commands.
      if (event.buttons > 1) { hide(); return; }
      if (animation !== null) cancelAnimationFrame(animation);
      animation = requestAnimationFrame(() => {
        animation = null;
        const bounds = slider.getBoundingClientRect();
        if (bounds.width <= 0) return;
        const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
        const width = Math.min(168, bounds.width);
        const seconds = Math.min(Math.max(0, duration - 0.1), x / bounds.width * duration);
        cache.current?.request(seconds);
        setHover({
          seconds,
          left: Math.max(width / 2, Math.min(bounds.width - width / 2, x)),
          width,
        });
      });
    };
    slider.addEventListener('pointermove', move, { passive: true });
    slider.addEventListener('pointerdown', move, { passive: true });
    slider.addEventListener('pointerleave', hide);
    slider.addEventListener('lostpointercapture', hide);
    slider.addEventListener('pointercancel', hide);
    window.addEventListener('blur', hide);
    return () => {
      if (animation !== null) cancelAnimationFrame(animation);
      slider.removeEventListener('pointermove', move);
      slider.removeEventListener('pointerleave', hide);
      slider.removeEventListener('pointerdown', move);
      slider.removeEventListener('lostpointercapture', hide);
      slider.removeEventListener('pointercancel', hide);
      window.removeEventListener('blur', hide);
    };
  }, [duration, sliderRef]);

  if (!hover || !visible) return null;
  const image = cache.current?.nearest(hover.seconds);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full z-20 mb-3 flex -translate-x-1/2 flex-col items-center gap-2"
      style={{ left: hover.left, width: hover.width }}
    >
      <div className="aspect-video w-full overflow-hidden rounded-lg border-2 border-white/80 bg-black/80 shadow-lg">
        {image && (
          <img
            src={image.url}
            alt=""
            draggable={false}
            className="h-full w-full object-contain"
          />
        )}
      </div>
      <div className="rounded-full bg-black/55 px-3 py-1 text-center text-xs font-semibold tabular-nums text-white shadow-md backdrop-blur-md">
        {formatTime(hover.seconds)}
      </div>
    </div>
  );
}
