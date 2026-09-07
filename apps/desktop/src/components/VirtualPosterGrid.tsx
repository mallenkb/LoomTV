import React, { useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { virtualGridLayout, virtualGridRange } from '@/lib/virtualGrid';

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
  const grid = virtualGridRange({ ...layout, itemCount: items.length, containerWidth: geometry.width, scrollTop: 0, viewportHeight: 0 });
  const virtual = useVirtualizer({
    count: grid.totalRows,
    getScrollElement: () => container,
    estimateSize: () => layout.rowHeight,
    getItemKey: index => items[index * grid.columns]?.id || index,
    scrollMargin: geometry.margin,
    overscan: 2,
  });
  return (
    <div ref={rootRef} className="relative w-full" role="list" aria-label="Media items" style={{ height: Math.max(0, virtual.getTotalSize() - layout.gap) }}>
      {virtual.getVirtualItems().map(row => (
        <div key={row.key} className="absolute left-0 top-0 grid" style={{
          transform: `translateY(${row.start - virtual.options.scrollMargin}px)`,
          gridTemplateColumns: `repeat(${grid.columns}, ${grid.columnWidth}px)`, gap: layout.gap,
        }}>
          {items.slice(row.index * grid.columns, (row.index + 1) * grid.columns).map((item, column) => (
            <div key={item.id} role="listitem" aria-posinset={row.index * grid.columns + column + 1} aria-setsize={items.length}
              style={{ width: grid.columnWidth, height: grid.itemHeight }}>
              {renderItem(item)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
