import { Children, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export default function VirtualEpisodeList({ id, children }: { id: string; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rows = Children.toArray(children);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let parent = root.parentElement;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
    if (!parent) return;
    const target = parent;
    setScroller(target);
    const measure = () => setMargin(root.getBoundingClientRect().top - target.getBoundingClientRect().top + target.scrollTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    if (root.parentElement) observer.observe(root.parentElement);
    return () => observer.disconnect();
  }, []);
  const virtual = useVirtualizer({
    count: rows.length, getScrollElement: () => scroller, estimateSize: () => 112,
    scrollMargin: margin, overscan: 3,
    getItemKey: index => {
      const row = rows[index];
      return typeof row === 'object' && row && 'key' in row && row.key !== null ? String(row.key) : index;
    },
  });
  const virtualRows = virtual.getVirtualItems();
  useLayoutEffect(() => {
    if (focusIndex === null) return;
    const button = rootRef.current?.querySelector<HTMLButtonElement>(`[data-index="${focusIndex}"] button`);
    if (button) { button.focus({ preventScroll: true }); setFocusIndex(null); }
  }, [focusIndex, virtualRows]);
  return <div id={id} ref={rootRef} className="relative" style={{ height: virtual.getTotalSize() }} onKeyDown={event => {
    if (!['Tab', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const row = (event.target as Element).closest<HTMLElement>('[data-index]');
    if (!row) return;
    const current = Number(row.dataset.index);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : current + (event.key === 'ArrowUp' || event.key === 'Tab' && event.shiftKey ? -1 : 1);
    if (next < 0 || next >= rows.length) return;
    event.preventDefault();
    virtual.scrollToIndex(next, { align: 'auto' });
    setFocusIndex(next);
  }}>
    {virtualRows.map(row => <div
      key={row.key} data-index={row.index} ref={virtual.measureElement}
      className="absolute left-0 top-0 w-full border-b border-[var(--loom-panel-border)]"
      style={{ transform: `translateY(${row.start - margin}px)` }}
    >{rows[row.index]}</div>)}
  </div>;
}
