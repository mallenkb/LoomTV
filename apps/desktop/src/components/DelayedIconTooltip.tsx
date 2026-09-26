import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

type DelayedIconTooltipProps = {
  children: ReactNode;
  label: string;
  side?: 'left' | 'right';
  className?: string;
};

export default function DelayedIconTooltip({
  children,
  label,
  side = 'right',
  className,
}: DelayedIconTooltipProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLSpanElement | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: side === 'left' ? rect.left - 8 : rect.right + 8, top: rect.top + rect.height / 2 });
    setVisible(true);
  };

  const hide = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = null;
    setVisible(false);
  };

  useEffect(() => () => {
    if (showTimer.current) clearTimeout(showTimer.current);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const dismiss = () => setVisible(false);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [visible]);

  return (
    <span
      ref={trigger}
      className={cn('relative inline-flex shrink-0', className)}
      onMouseEnter={() => {
        if (showTimer.current) clearTimeout(showTimer.current);
        showTimer.current = setTimeout(() => {
          showTimer.current = null;
          show();
        }, 650);
      }}
      onMouseLeave={hide}
      onFocusCapture={() => {
        if (showTimer.current) clearTimeout(showTimer.current);
        showTimer.current = null;
        show();
      }}
      onBlurCapture={hide}
      onClickCapture={hide}
    >
      {children}
      {visible && createPortal(
        <span
          role="tooltip"
          className={cn(
            'pointer-events-none fixed z-[1000] -translate-y-1/2 whitespace-nowrap rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-3)] px-3 py-2 text-sm font-medium text-[var(--loom-text)] shadow-[0_8px_24px_rgba(0,0,0,0.35)]',
            side === 'left' && '-translate-x-full',
          )}
          style={position}
        >
          {label}
        </span>,
        document.body,
      )}
    </span>
  );
}
