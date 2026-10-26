import { useEffect, type RefObject } from 'react';
import type { PlaybackControlBackdrop } from '@/shared/playbackProtocol';

export function useNativeControlBackdrops({
  containerRef, enabled, showControls, showTopControls, onChange,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  showControls: boolean;
  showTopControls: boolean;
  onChange: (regions: PlaybackControlBackdrop[]) => void;
}) {
  useEffect(() => {
    const root = containerRef.current;
    if (!enabled || !root) {
      onChange([]);
      return;
    }
    let frame: number | null = null;
    let lastKey = '';
    const measure = () => {
      frame = null;
      const buttonSelector = root.classList.contains('loom-player-pill')
        ? '.loom-player-controls button'
        : '.loom-player-controls button:not(.loom-player-time)';
      const candidates = Array.from(root.querySelectorAll<HTMLElement>([
        ...(showControls ? [buttonSelector, '.loom-player-pill .loom-player-volume'] : []),
        ...(showTopControls ? ['.loom-player-top-controls .loom-player-top-control'] : []),
      ].join(',') || ':not(*)'));
      // A grouped volume pill needs one backdrop, not overlapping blur layers.
      const regions = candidates.filter(element => !candidates.some(parent => parent !== element && parent.contains(element)))
        .flatMap(element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return [];
          const round = (value: number) => Math.round(value * 2) / 2;
          return [{ x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height),
            cornerRadius: Math.min(parseFloat(style.borderTopLeftRadius) || 0, rect.width / 2, rect.height / 2) }];
        }).filter(region => region.width > 0 && region.height > 0).slice(0, 64);
      const key = JSON.stringify(regions);
      if (key === lastKey) return;
      lastKey = key;
      onChange(regions);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    root.querySelectorAll<HTMLElement>([
      '.loom-player-controls', '.loom-player-controls button', '.loom-player-volume',
      '.loom-player-top-controls', '.loom-player-top-control',
    ].join(','))
      .forEach(element => resize.observe(element));
    // Dynamic source buttons and episode labels can change the pill positions.
    const mutation = new MutationObserver(schedule);
    mutation.observe(root, { attributes: true, attributeFilter: ['class'] });
    root.querySelectorAll('.loom-player-controls, .loom-player-top-controls')
      .forEach(element => mutation.observe(element, { childList: true, subtree: true }));
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [containerRef, enabled, onChange, showControls, showTopControls]);
}
