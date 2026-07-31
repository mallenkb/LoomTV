import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

type HighlightRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SharedListHighlightProps = {
  activeId?: string | null;
  children: ReactNode;
  className?: string;
  followPointer?: boolean;
};

const itemSelector = '[data-shared-highlight-item]';

function isAvailableItem(item: HTMLElement): boolean {
  return !item.matches(':disabled, [aria-disabled="true"]');
}

export default function SharedListHighlight({
  activeId = null,
  children,
  className,
  followPointer = true,
}: SharedListHighlightProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const highlightedItemRef = useRef<HTMLElement | null>(null);
  const [rect, setRect] = useState<HighlightRect | null>(null);

  const showItem = useCallback((item: HTMLElement | null) => {
    const container = containerRef.current;
    if (!container || !item || !isAvailableItem(item)) {
      highlightedItemRef.current = null;
      setRect(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    highlightedItemRef.current = item;
    setRect({
      x: itemRect.left - containerRect.left + container.scrollLeft,
      y: itemRect.top - containerRect.top + container.scrollTop,
      width: itemRect.width,
      height: itemRect.height,
    });
  }, []);

  const showActiveItem = useCallback(() => {
    const container = containerRef.current;
    if (!container || activeId === null) {
      showItem(null);
      return;
    }

    const activeItem = Array.from(container.querySelectorAll<HTMLElement>(itemSelector))
      .find((item) => item.closest('.loom-shared-highlight-group') === container
        && item.dataset.sharedHighlightId === activeId
        && item.getClientRects().length > 0);
    showItem(activeItem || null);
  }, [activeId, showItem]);

  useLayoutEffect(() => {
    showActiveItem();
  }, [showActiveItem]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const highlightedItem = highlightedItemRef.current;
      if (highlightedItem?.getClientRects().length) showItem(highlightedItem);
      else showActiveItem();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [showActiveItem, showItem]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof MutationObserver === 'undefined') return;

    const observer = new MutationObserver(() => {
      const highlightedItem = highlightedItemRef.current;
      if (highlightedItem?.isConnected && highlightedItem.getClientRects().length) showItem(highlightedItem);
      else showActiveItem();
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [showActiveItem, showItem]);

  const findEventItem = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const item = target.closest<HTMLElement>(itemSelector);
    return item?.closest('.loom-shared-highlight-group') === containerRef.current ? item : null;
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const item = findEventItem(event.target);
    if (item && item !== highlightedItemRef.current) showItem(item);
  };

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const item = findEventItem(event.target);
    if (item) showItem(item);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextItem = findEventItem(event.relatedTarget);
    if (nextItem) showItem(nextItem);
    else showActiveItem();
  };

  const style = rect ? ({
    '--shared-highlight-x': `${rect.x}px`,
    '--shared-highlight-y': `${rect.y}px`,
    '--shared-highlight-width': `${rect.width}px`,
    '--shared-highlight-height': `${rect.height}px`,
  } as CSSProperties) : undefined;

  return (
    <div
      ref={containerRef}
      className={cn('loom-shared-highlight-group', rect && 'loom-shared-highlight-visible', className)}
      style={style}
      onPointerMove={followPointer ? handlePointerMove : undefined}
      onPointerLeave={followPointer ? showActiveItem : undefined}
      onFocusCapture={followPointer ? handleFocus : undefined}
      onBlurCapture={followPointer ? handleBlur : undefined}
    >
      {children}
    </div>
  );
}
