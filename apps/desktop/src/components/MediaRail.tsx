import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router';

/** Pointer travel before a press is treated as a drag rather than a click. */
const DRAG_THRESHOLD = 12;

export type RailVariant = 'classic' | 'modern';

/**
 * Horizontal drag-to-scroll plus end detection for a poster rail.
 *
 * Both home styles shared a hand-rolled copy of this; keeping one implementation
 * means the drag threshold, the click suppression, and the arrow enablement stay
 * in sync between them.
 */
export function useRailScroll() {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, dragged: false, startScrollLeft: 0, startX: 0, startY: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const syncOverflow = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const maxScrollLeft = rail.scrollWidth - rail.clientWidth;
    setOverflow({
      left: rail.scrollLeft > 1,
      // A fractional gap of a pixel is normal at the end of a scroll, so treat
      // anything under 1px of remaining travel as fully scrolled.
      right: maxScrollLeft - rail.scrollLeft > 1,
    });
  }, []);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    syncOverflow();
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(rail);
    for (const child of Array.from(rail.children)) observer.observe(child);
    rail.addEventListener('scroll', syncOverflow, { passive: true });
    return () => {
      observer.disconnect();
      rail.removeEventListener('scroll', syncOverflow);
    };
  }, [syncOverflow]);

  const scrollByPage = useCallback((direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollLeft += direction * Math.max(240, rail.clientWidth * 0.8);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const rail = railRef.current;
    if (!rail || rail.scrollWidth <= rail.clientWidth) return;
    dragRef.current = {
      active: true,
      dragged: false,
      startScrollLeft: rail.scrollLeft,
      startX: event.clientX,
      startY: event.clientY,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rail = railRef.current;
    if (!drag.active || !rail) return;
    const distance = event.clientX - drag.startX;
    const verticalDistance = event.clientY - drag.startY;
    // Hold off until the gesture is clearly horizontal, so a vertical page
    // scroll that starts on a rail is not captured.
    if (!drag.dragged && (Math.abs(distance) < DRAG_THRESHOLD || Math.abs(distance) <= Math.abs(verticalDistance) * 1.2)) return;
    if (!drag.dragged) {
      drag.dragged = true;
      setIsDragging(true);
      rail.setPointerCapture(event.pointerId);
    }
    rail.scrollLeft = drag.startScrollLeft - distance;
    event.preventDefault();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    setIsDragging(false);
    if (railRef.current?.hasPointerCapture(event.pointerId)) {
      railRef.current.releasePointerCapture(event.pointerId);
    }
  };

  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!dragRef.current.dragged) return;
    // Pointer capture ends before the browser dispatches the synthetic click.
    // Suppress only that click so a real tap still follows the card link, while
    // a drag never opens the card underneath the pointer.
    event.preventDefault();
    event.stopPropagation();
    dragRef.current.dragged = false;
  };

  return {
    railRef,
    isDragging,
    canScrollLeft: overflow.left,
    canScrollRight: overflow.right,
    scrollByPage,
    railHandlers: {
      onClickCapture,
      onDragStart: (event: ReactDragEvent<HTMLDivElement>) => event.preventDefault(),
      onPointerCancel: onPointerUp,
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
  };
}

const ARROW_CLASS: Record<RailVariant, string> = {
  classic: 'h-10 w-10 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] text-[var(--loom-text)] shadow-lg backdrop-blur-md',
  modern: 'h-9 w-9 rounded-full bg-[var(--loom-control-veil)] text-[var(--loom-text)] backdrop-blur-[12px]',
};

const TITLE_CLASS: Record<RailVariant, string> = {
  classic: 'loom-section-title text-2xl font-bold text-[var(--loom-text)]',
  modern: 'text-xl font-semibold text-[var(--loom-text)]',
};

const GAP_CLASS: Record<RailVariant, string> = {
  classic: 'gap-6 pb-3 pr-6',
  modern: 'gap-4 pb-2',
};

function RailArrow({
  direction,
  label,
  variant,
  disabled,
  onClick,
}: {
  direction: -1 | 1;
  label: string;
  variant: RailVariant;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = direction === -1 ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`grid place-items-center transition-[color,background-color,opacity] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)] disabled:pointer-events-none disabled:opacity-30 ${ARROW_CLASS[variant]}`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

export type MediaRailProps = {
  title: string;
  /** Makes the heading row open the full library section. */
  titleHref?: string;
  /** Rendered between the title and the scroll arrows, e.g. a "See All" link. */
  action?: ReactNode;
  variant?: RailVariant;
  className?: string;
  children: ReactNode;
};

/**
 * A titled, horizontally scrollable rail. The arrows are the keyboard- and
 * screen-reader-reachable way to page the rail; drag scrolling is a mouse
 * convenience layered on top of it, never the only way through.
 */
export default function MediaRail({ title, titleHref, action, variant = 'classic', className = '', children }: MediaRailProps) {
  const { railRef, isDragging, canScrollLeft, canScrollRight, scrollByPage, railHandlers } = useRailScroll();
  const headingId = useId();
  const scrollable = canScrollLeft || canScrollRight;

  return (
    <section className={`min-w-0 w-full ${className}`} aria-labelledby={headingId}>
      <div className="mb-2 flex items-center justify-between gap-4">
        {titleHref ? (
          <Link
            to={titleHref}
            className="flex min-w-0 flex-1 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
            aria-label={`Open ${title}`}
          >
            <h2 id={headingId} className={TITLE_CLASS[variant]}>{title}</h2>
          </Link>
        ) : (
          <h2 id={headingId} className={TITLE_CLASS[variant]}>{title}</h2>
        )}
        <div className="flex items-center gap-1">
          {action}
          {/* Arrows stay out of the tab order entirely when everything already
              fits, rather than sitting there as permanently dead controls. */}
          {scrollable && (
            <>
              <RailArrow direction={-1} label={`Scroll ${title} left`} variant={variant} disabled={!canScrollLeft} onClick={() => scrollByPage(-1)} />
              <RailArrow direction={1} label={`Scroll ${title} right`} variant={variant} disabled={!canScrollRight} onClick={() => scrollByPage(1)} />
            </>
          )}
        </div>
      </div>
      <div
        ref={railRef}
        {...railHandlers}
        className={`flex w-full min-w-0 select-none overflow-x-auto overflow-y-hidden scroll-smooth [scrollbar-gutter:stable] [touch-action:pan-y] ${GAP_CLASS[variant]} ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        {children}
      </div>
    </section>
  );
}
