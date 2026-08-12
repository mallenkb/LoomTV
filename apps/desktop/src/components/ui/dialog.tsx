import * as React from 'react';
import { cn } from '@/lib/utils';

const DialogLabelContext = React.createContext<{ titleId: string; descriptionId: string }>({
  titleId: '',
  descriptionId: '',
});

type ModalLayer = {
  id: string;
  content: HTMLElement | null;
  onEscape?: () => void;
};

type ModalMutation = {
  element: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
  appliedInert: boolean;
  appliedAriaHidden: string;
};

const modalLayers: ModalLayer[] = [];
let modalMutations: ModalMutation[] = [];

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(content: HTMLElement): HTMLElement[] {
  return [...content.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => (
    !element.hidden
    && element.getAttribute('aria-hidden') !== 'true'
    && !element.hasAttribute('disabled')
  ));
}

function isTopmost(id: string): boolean {
  return modalLayers[modalLayers.length - 1]?.id === id;
}

function restoreFocusAfterCommit(target: HTMLElement | null) {
  window.requestAnimationFrame(() => {
    if (!target?.isConnected) return;
    const active = modalLayers[modalLayers.length - 1]?.content;
    if (active && !active.contains(target)) return;
    target.focus();
  });
}

function restoreModalMutations() {
  for (const mutation of modalMutations) {
    const inertElement = mutation.element as HTMLElement & { inert?: boolean };
    // Do not clobber an accessibility state changed by the owner while the
    // layer was open (for example AppShell removing its own aria-hidden when a
    // profile gate closes in the same commit as this cleanup).
    if (Boolean(inertElement.inert) === mutation.appliedInert) inertElement.inert = mutation.inert;
    if (mutation.element.getAttribute('aria-hidden') === mutation.appliedAriaHidden) {
      if (mutation.ariaHidden === null) mutation.element.removeAttribute('aria-hidden');
      else mutation.element.setAttribute('aria-hidden', mutation.ariaHidden);
    }
  }
  modalMutations = [];
}

/**
 * Mark every DOM branch outside the active layer inert. Walking the ancestor
 * path (instead of marking body children wholesale) also works when a modal is
 * rendered inside the app root, and never marks the modal itself inert.
 */
function syncModalUnderlay() {
  restoreModalMutations();
  const active = modalLayers[modalLayers.length - 1];
  const content = active?.content;
  if (!content || !content.isConnected) return;

  let current: HTMLElement | null = content;
  while (current && current !== document.body) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) break;
    for (const sibling of [...parent.children]) {
      if (sibling === current || sibling.contains(content)) continue;
      if (!(sibling instanceof HTMLElement)) continue;
      const inertElement = sibling as HTMLElement & { inert?: boolean };
      modalMutations.push({
        element: sibling,
        inert: Boolean(inertElement.inert),
        ariaHidden: sibling.getAttribute('aria-hidden'),
        appliedInert: true,
        appliedAriaHidden: 'true',
      });
      inertElement.inert = true;
      sibling.setAttribute('aria-hidden', 'true');
    }
    current = parent;
  }
}

/**
 * Shared modal behavior for full-screen surfaces that cannot use the compact
 * Dialog markup (the profile gate, player, and modern search). The hook keeps a
 * single topmost stack so nested Escape handlers never dismiss a lower layer.
 */
export function useModalLayer({
  open = true,
  contentRef,
  onClose,
  onEscape,
  initialFocusRef,
}: {
  open?: boolean;
  contentRef: React.RefObject<HTMLElement | null>;
  onClose?: () => void;
  onEscape?: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const id = React.useId();
  const callbackRef = React.useRef(onEscape || onClose);
  const initialFocusRefValue = React.useRef(initialFocusRef);
  callbackRef.current = onEscape || onClose;
  initialFocusRefValue.current = initialFocusRef;

  React.useLayoutEffect(() => {
    if (!open) return undefined;
    const content = contentRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer: ModalLayer = { id, content, onEscape: () => callbackRef.current?.() };
    modalLayers.push(layer);
    syncModalUnderlay();

    const focusFirst = () => {
      if (!content || !content.isConnected || !isTopmost(id)) return;
      const requested = initialFocusRefValue.current?.current;
      if (requested && content.contains(requested)) {
        requested.focus();
        return;
      }
      const firstFocusable = getFocusable(content)[0];
      (firstFocusable || content).focus();
    };
    const animationFrame = window.requestAnimationFrame(focusFirst);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost(id) || !content) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        modalLayers[modalLayers.length - 1]?.onEscape?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable(content);
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
    const handleFocusIn = (event: FocusEvent) => {
      if (!isTopmost(id) || !content || !(event.target instanceof Node) || content.contains(event.target)) return;
      focusFirst();
    };
    // Capture lets the topmost layer consume Escape before any lower layer or
    // page-level keyboard shortcut can observe it.
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      const index = modalLayers.findIndex((candidate) => candidate.id === id);
      if (index >= 0) modalLayers.splice(index, 1);
      syncModalUnderlay();
      // React tears down layout effects before every removed DOM node is
      // disconnected. Deferring this check prevents a nested layer from
      // restoring focus into a parent that is being removed in the same
      // commit, while still restoring into a surviving parent layer.
      restoreFocusAfterCommit(previouslyFocused);
    };
  }, [contentRef, id, open]);
}

interface DialogProps extends React.HTMLAttributes<HTMLDivElement> {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClassName?: string;
}

const Dialog = React.forwardRef<HTMLDivElement, DialogProps>(
  ({ className, contentClassName, open, onOpenChange, children, ...props }, forwardedRef) => {
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const titleId = React.useId();
    const descriptionId = React.useId();
    useModalLayer({
      open,
      contentRef,
      onEscape: () => onOpenChange?.(false),
    });

    if (!open) return null;
    return (
      <div
        ref={forwardedRef}
        className={cn('loom-no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/80', className)}
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
            aria-describedby={descriptionId}
            tabIndex={-1}
            className={cn('relative z-50 max-h-[85vh] w-full max-w-4xl overflow-auto rounded-lg border bg-card p-6 shadow-lg', contentClassName)}
          >
            <DialogLabelContext.Provider value={{ titleId, descriptionId }}>
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
    const generatedId = React.useContext(DialogLabelContext).titleId;
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

const DialogDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, id, ...props }, ref) => {
    const generatedId = React.useContext(DialogLabelContext).descriptionId;
    return <p ref={ref} id={id || generatedId} className={cn('text-sm text-muted-foreground', className)} {...props} />;
  }
);
DialogDescription.displayName = 'DialogDescription';

export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription };
