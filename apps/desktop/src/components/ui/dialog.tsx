import * as React from 'react';
import { cn } from '@/lib/utils';

const DialogLabelContext = React.createContext<string | undefined>(undefined);

interface DialogProps extends React.HTMLAttributes<HTMLDivElement> {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClassName?: string;
}

const Dialog = React.forwardRef<HTMLDivElement, DialogProps>(
  ({ className, contentClassName, open, onOpenChange, children, ...props }, forwardedRef) => {
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const titleId = React.useId();

    React.useEffect(() => {
      if (!open) return undefined;
      const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const content = contentRef.current;
      const focusableSelector = [
        'button:not([disabled])',
        '[href]',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
      ].join(',');

      const focusFirst = () => {
        const firstFocusable = content?.querySelector<HTMLElement>(focusableSelector);
        (firstFocusable || content)?.focus();
      };
      const animationFrame = requestAnimationFrame(focusFirst);
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onOpenChange?.(false);
          return;
        }
        if (event.key !== 'Tab' || !content) return;
        const focusable = [...content.querySelectorAll<HTMLElement>(focusableSelector)]
          .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
        if (focusable.length === 0) {
          event.preventDefault();
          content.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        cancelAnimationFrame(animationFrame);
        document.removeEventListener('keydown', handleKeyDown);
        previouslyFocused?.focus();
      };
    }, [onOpenChange, open]);

    if (!open) return null;
    return (
      <div
        ref={forwardedRef}
        className={cn('fixed inset-0 z-50 flex items-center justify-center bg-black/80', className)}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onOpenChange?.(false);
        }}
        {...props}
      >
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onOpenChange?.(false);
          }}
        >
          <div
            ref={contentRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className={cn('relative z-50 max-h-[85vh] w-full max-w-4xl overflow-auto rounded-lg border bg-card p-6 shadow-lg', contentClassName)}
          >
            <DialogLabelContext.Provider value={titleId}>
              {children}
            </DialogLabelContext.Provider>
          </div>
        </div>
      </div>
    );
  }
);
Dialog.displayName = 'Dialog';

const DialogContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('relative', className)} {...props} />
  )
);
DialogContent.displayName = 'DialogContent';

const DialogHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
  )
);
DialogHeader.displayName = 'DialogHeader';

const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, id, ...props }, ref) => {
    const generatedId = React.useContext(DialogLabelContext);
    return (
      <h2
        ref={ref}
        id={id || generatedId}
        className={cn('text-lg font-semibold leading-none tracking-tight', className)}
        {...props}
      />
    );
  }
);
DialogTitle.displayName = 'DialogTitle';

export { Dialog, DialogContent, DialogHeader, DialogTitle };
