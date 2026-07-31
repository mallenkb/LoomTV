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
  preserveActiveOnHover?: boolean;
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
  preserveActiveOnHover = false,
}: SharedListHighlightProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const highlightedItemRef = useRef<HTMLElement | null>(null);
  const hoveredItemRef = useRef<HTMLElement | null>(null);
  const [rect, setRect] = useState<HighlightRect | null>(null);
  const [hoverRect, setHoverRect] = useState<HighlightRect | null>(null);

  const showItem = useCallback((item: HTMLElement | null, layer: 'active' | 'hover' = 'active') => {
    const container = containerRef.current;
    if (!container || !item || !isAvailableItem(item)) {
      if (layer === 'hover') {
        hoveredItemRef.current = null;
        setHoverRect(null);
      } else {
        highlightedItemRef.current = null;
        setRect(null);
      }
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const nextRect = {
      x: itemRect.left - containerRect.left + container.scrollLeft,
      y: itemRect.top - containerRect.top + container.scrollTop,
      width: itemRect.width,
      height: itemRect.height,
    };
    if (layer === 'hover') {
      hoveredItemRef.current = item;
      setHoverRect(nextRect);
    } else {
      highlightedItemRef.current = item;
      setRect(nextRect);
    }
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

  const clearHoverItem = useCallback(() => {
    hoveredItemRef.current = null;
    setHoverRect(null);
  }, []);

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
      const hoveredItem = hoveredItemRef.current;
      if (hoveredItem?.getClientRects().length) showItem(hoveredItem, 'hover');
      else clearHoverItem();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [clearHoverItem, showActiveItem, showItem]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof MutationObserver === 'undefined') return;

    const observer = new MutationObserver(() => {
      const highlightedItem = highlightedItemRef.current;
      if (highlightedItem?.isConnected && highlightedItem.getClientRects().length) showItem(highlightedItem);
      else showActiveItem();
      const hoveredItem = hoveredItemRef.current;
      if (hoveredItem?.isConnected && hoveredItem.getClientRects().length) showItem(hoveredItem, 'hover');
      else clearHoverItem();
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [clearHoverItem, showActiveItem, showItem]);

  const findEventItem = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const item = target.closest<HTMLElement>(itemSelector);
    return item?.closest('.loom-shared-highlight-group') === containerRef.current ? item : null;
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const item = findEventItem(event.target);
    if (preserveActiveOnHover) {
      if (!item || item.dataset.sharedHighlightId === activeId) {
        clearHoverItem();
        return;
      }
      if (item && item !== hoveredItemRef.current) showItem(item, 'hover');
      return;
    }
    if (item && item !== highlightedItemRef.current) showItem(item);
  };

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const item = findEventItem(event.target);
    if (preserveActiveOnHover) {
      if (!item || item.dataset.sharedHighlightId === activeId) clearHoverItem();
      else showItem(item, 'hover');
      return;
    }
    if (item) showItem(item);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextItem = findEventItem(event.relatedTarget);
    if (preserveActiveOnHover) {
      if (nextItem && nextItem.dataset.sharedHighlightId !== activeId) showItem(nextItem, 'hover');
      else clearHoverItem();
    } else if (nextItem) showItem(nextItem);
    else showActiveItem();
  };

  const style = rect || hoverRect ? ({
    '--shared-highlight-x': `${rect?.x || 0}px`,
    '--shared-highlight-y': `${rect?.y || 0}px`,
    '--shared-highlight-width': `${rect?.width || 0}px`,
    '--shared-highlight-height': `${rect?.height || 0}px`,
    '--shared-highlight-hover-x': `${hoverRect?.x || 0}px`,
    '--shared-highlight-hover-y': `${hoverRect?.y || 0}px`,
    '--shared-highlight-hover-width': `${hoverRect?.width || 0}px`,
    '--shared-highlight-hover-height': `${hoverRect?.height || 0}px`,
  } as CSSProperties) : undefined;

  return (
    <div
      ref={containerRef}
      className={cn(
        'loom-shared-highlight-group',
        (rect || hoverRect) && 'loom-shared-highlight-visible',
        preserveActiveOnHover && 'loom-shared-highlight-preserve-active',
        preserveActiveOnHover && hoverRect && 'loom-shared-highlight-hover-visible',
        className,
      )}
      style={style}
      onPointerMove={followPointer ? handlePointerMove : undefined}
      onPointerLeave={followPointer ? (preserveActiveOnHover ? clearHoverItem : showActiveItem) : undefined}
      onFocusCapture={followPointer ? handleFocus : undefined}
      onBlurCapture={followPointer ? handleBlur : undefined}
    >
      {children}
    </div>
  );
}
