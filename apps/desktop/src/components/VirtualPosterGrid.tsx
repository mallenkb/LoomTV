import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  virtualGridCardHeightDiverges,
  virtualGridItemAttributes,
  virtualGridLayout,
  virtualGridRange,
} from '@/lib/virtualGrid';

const IS_DEVELOPMENT = (
  import.meta as ImportMeta & { env?: { DEV?: boolean } }
).env?.DEV === true;

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
  minColumnWidth = 176,
  maxColumnWidth = 200,
  rowHeight = 340,
  gap = 24,
}: VirtualPosterGridProps<T>) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const itemsLayerRef = useRef<HTMLDivElement | null>(null);
  const warnedAboutCardHeightRef = useRef(false);
  const [viewport, setViewport] = useState({ width: 0, scrollTop: 0, height: 720 });
  const layout = virtualGridLayout({
    containerWidth: viewport.width,
    minColumnWidth,
    maxColumnWidth,
    rowHeight,
    gap,
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const parent = scrollParentFor(root);

    let animationFrame: number | null = null;
    const measure = () => {
      animationFrame = null;
      const metrics = scrollMetrics(parent, root);
      const width = root.clientWidth;
      setViewport((current) => (
        current.width === width
        && current.scrollTop === metrics.scrollTop
        && current.height === metrics.viewportHeight
          ? current
          : { width, scrollTop: metrics.scrollTop, height: metrics.viewportHeight }
      ));
    };
    const update = () => {
      if (animationFrame !== null) return;
      animationFrame = requestAnimationFrame(measure);
    };

    measure();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(root);
    const scrollTarget = parent instanceof Window ? window : parent;
    scrollTarget.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);

    return () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      scrollTarget.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    setViewport((current) => current.width === root.clientWidth
      ? current
      : { ...current, width: root.clientWidth });
  }, [items.length]);

  const range = virtualGridRange({
    itemCount: items.length,
    containerWidth: viewport.width,
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height,
    minColumnWidth: layout.minColumnWidth,
    maxColumnWidth: layout.maxColumnWidth,
    rowHeight: layout.rowHeight,
    gap: layout.gap,
    overscanRows: 2,
  });
  const visibleItems = items.slice(range.startIndex, range.endIndex);
  const visibleItemIds = visibleItems.map((item) => item.id).join('\u0000');

  useEffect(() => {
    if (!IS_DEVELOPMENT || warnedAboutCardHeightRef.current) return undefined;
    const itemsLayer = itemsLayerRef.current;
    if (!itemsLayer) return undefined;

    const renderedCards: HTMLElement[] = [];
    for (const wrapper of itemsLayer.children) {
      const card = wrapper.firstElementChild;
      if (card instanceof HTMLElement) renderedCards.push(card);
    }
    if (renderedCards.length === 0) return undefined;

    const warnIfCardHeightDiverges = (card: HTMLElement) => {
      if (warnedAboutCardHeightRef.current) return true;
      const measuredHeight = card.getBoundingClientRect().height;
      if (!virtualGridCardHeightDiverges(range.itemHeight, measuredHeight)) return false;
      warnedAboutCardHeightRef.current = true;
      console.warn(
        `[VirtualPosterGrid] Rendered card height (${measuredHeight}px) differs from the expected `
        + `${range.itemHeight}px item height. Keep cards pinned to the row pitch minus its gap.`,
      );
      return true;
    };

    for (const card of renderedCards) {
      if (warnIfCardHeightDiverges(card)) return undefined;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (warnIfCardHeightDiverges(entry.target as HTMLElement)) {
          resizeObserver.disconnect();
          break;
        }
      }
    });
    renderedCards.forEach((card) => resizeObserver.observe(card));
    return () => resizeObserver.disconnect();
  }, [range.endIndex, range.itemHeight, range.startIndex, visibleItemIds]);

  return (
    <div ref={rootRef} className="relative w-full" style={{ height: range.totalHeight }}>
      <div
        ref={itemsLayerRef}
        className="absolute left-0 right-0 top-0 grid justify-start"
        role="list"
        aria-label="Media items"
        style={{
          gap: layout.gap,
          gridTemplateColumns: `repeat(${range.columns}, minmax(0, ${range.columnWidth}px))`,
          transform: `translateY(${range.offsetY}px)`,
        }}
      >
        {visibleItems.map((item, visibleIndex) => (
          <div
            key={item.id}
            className="h-full"
            {...virtualGridItemAttributes(range, visibleIndex, items.length)}
          >
            {renderItem(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
