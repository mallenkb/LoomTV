import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { virtualGridRange } from '@/lib/virtualGrid';

type VirtualPosterGridProps<T extends { id: string }> = {
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  minColumnWidth?: number;
  maxColumnWidth?: number;
  rowHeight?: number;
  gap?: number;
};

function scrollParentFor(element: HTMLElement): HTMLElement | Window {
  let current: HTMLElement | null = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll)/.test(`${style.overflowY}${style.overflow}`)) return current;
    current = current.parentElement;
  }
  return window;
}

function scrollMetrics(parent: HTMLElement | Window, element: HTMLElement) {
  const parentRect = parent instanceof Window
    ? { top: 0, height: window.innerHeight }
    : parent.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return {
    scrollTop: Math.max(0, parentRect.top - rect.top),
    viewportHeight: parentRect.height,
  };
}

export default function VirtualPosterGrid<T extends { id: string }>({
  items,
  renderItem,
  minColumnWidth = 140,
  maxColumnWidth = 200,
  rowHeight = 340,
  gap = 24,
}: VirtualPosterGridProps<T>) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, scrollTop: 0, height: 720 });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const parent = scrollParentFor(root);

    const update = () => {
      const metrics = scrollMetrics(parent, root);
      setViewport({
        width: root.clientWidth,
        scrollTop: metrics.scrollTop,
        height: metrics.viewportHeight,
      });
    };

    update();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(root);
    const scrollTarget = parent instanceof Window ? window : parent;
    scrollTarget.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);

    return () => {
      resizeObserver.disconnect();
      scrollTarget.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    setViewport((current) => ({ ...current, width: root.clientWidth }));
  }, [items.length]);

  const range = virtualGridRange({
    itemCount: items.length,
    containerWidth: viewport.width,
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height,
    minColumnWidth,
    maxColumnWidth,
    rowHeight,
    gap,
    overscanRows: 2,
  });
  const visibleItems = items.slice(range.startIndex, range.endIndex);

  return (
    <div ref={rootRef} className="relative w-full" style={{ height: range.totalHeight }}>
      <div
        className="absolute left-0 right-0 top-0 grid justify-start"
        style={{
          gap,
          gridTemplateColumns: `repeat(${range.columns}, minmax(0, ${range.columnWidth}px))`,
          transform: `translateY(${range.offsetY}px)`,
        }}
      >
        {visibleItems.map((item) => (
          <div key={item.id} style={{ width: range.columnWidth }}>
            {renderItem(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
