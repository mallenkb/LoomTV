import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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

export default function VirtualPosterGrid<T extends { id: string }>({
  items, renderItem, minColumnWidth = 176, maxColumnWidth = 200, rowHeight = 384, gap = 24,
}: VirtualPosterGridProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const itemsLayerRef = useRef<HTMLDivElement>(null);
  const warnedAboutCardHeightRef = useRef(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [geometry, setGeometry] = useState({ width: 0, margin: 0 });
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let parent = root.parentElement;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
    const scroller = parent || document.documentElement;
    setContainer(scroller);
    const measure = () => {
      const width = root.clientWidth;
      const margin = root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      setGeometry(current => current.width === width && current.margin === margin ? current : { width, margin });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  const layout = virtualGridLayout({ containerWidth: geometry.width, minColumnWidth, maxColumnWidth, rowHeight, gap });
  const range = virtualGridRange({ ...layout, itemCount: items.length, containerWidth: geometry.width, scrollTop: 0, viewportHeight: 0 });
  const virtual = useVirtualizer({
    count: range.totalRows,
    getScrollElement: () => container,
    estimateSize: () => layout.rowHeight,
    getItemKey: index => items[index * range.columns]?.id || index,
    scrollMargin: geometry.margin,
    overscan: 2,
  });

  const visibleItemIds = virtual.getVirtualItems()
    .flatMap(row => items.slice(row.index * range.columns, (row.index + 1) * range.columns))
    .map(item => item.id)
    .join('\u0000');

  useEffect(() => {
    if (!IS_DEVELOPMENT || warnedAboutCardHeightRef.current) return undefined;
    const itemsLayer = itemsLayerRef.current;
    if (!itemsLayer) return undefined;

    const renderedCards: HTMLElement[] = [];
    for (const row of itemsLayer.children) {
      for (const wrapper of row.children) {
        const card = wrapper.firstElementChild;
        if (card instanceof HTMLElement) renderedCards.push(card);
      }
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
    renderedCards.forEach(card => resizeObserver.observe(card));
    return () => resizeObserver.disconnect();
  }, [range.endIndex, range.itemHeight, range.startIndex, visibleItemIds]);

  return (
    <div ref={rootRef} className="relative w-full" role="list" aria-label="Media items" style={{ height: Math.max(0, virtual.getTotalSize() - layout.gap) }}>
      <div ref={itemsLayerRef} className="absolute left-0 right-0 top-0">
        {virtual.getVirtualItems().map(row => (
          <div key={row.key} className="absolute left-0 top-0 grid" style={{
            transform: `translateY(${row.start - virtual.options.scrollMargin}px)`,
            gridTemplateColumns: `repeat(${range.columns}, ${range.columnWidth}px)`, gap: layout.gap,
          }}>
            {items.slice(row.index * range.columns, (row.index + 1) * range.columns).map((item, column) => {
              const visibleIndex = row.index * range.columns + column;
              return (
                <div key={item.id} className="h-full" {...virtualGridItemAttributes(range, visibleIndex, items.length)}>
                  {renderItem(item)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
