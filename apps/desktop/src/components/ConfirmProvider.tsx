import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export type ConfirmOptions = {
  title: string;
  description: string;
  /** Defaults to "Continue". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Styles the confirm action as destructive and shows a warning icon. */
  destructive?: boolean;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Promise-based replacement for `window.confirm`.
 *
 * The native dialog is an unthemed OS sheet in the middle of an app that styles
 * every other surface, and it blocks the renderer thread while it is open. This
 * keeps the same `await confirm(...)` ergonomics at the call site.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    resolveRef.current?.(confirmed);
    resolveRef.current = null;
    setRequest(null);
  }, []);

  const confirm = useCallback<ConfirmFn>((options) => {
    // A second request while one is open would strand the first promise, so
    // resolve the outstanding one as cancelled before taking over.
    resolveRef.current?.(false);
    setRequest(options);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Dialog
        open={request !== null}
        onOpenChange={(open) => { if (!open) settle(false); }}
        contentClassName="max-w-md rounded-2xl border-[var(--loom-border)] bg-[var(--loom-surface)] p-6"
      >
        {request && (
          <DialogContent>
            <DialogHeader className="text-left">
              <div className="flex items-start gap-3">
                {request.destructive && (
                  <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-red-500/15 text-red-400">
                    <AlertTriangle className="h-4.5 w-4.5" />
                  </span>
                )}
                <div className="min-w-0">
                  <DialogTitle className="text-base font-semibold text-[var(--loom-text)]">{request.title}</DialogTitle>
                  <p className="mt-2 text-sm leading-6 text-[var(--loom-muted)]">{request.description}</p>
                </div>
              </div>
            </DialogHeader>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => settle(false)}
                className="h-10 rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-5 text-sm font-medium text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-surface-3)]"
              >
                {request.cancelLabel || 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => settle(true)}
                className={`h-10 rounded-full px-5 text-sm font-semibold transition-colors ${
                  request.destructive
                    ? 'bg-red-500/90 text-white hover:bg-red-500'
                    : 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)] hover:bg-[var(--loom-accent-hover)]'
                }`}
              >
                {request.confirmLabel || 'Continue'}
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside a ConfirmProvider.');
  return confirm;
}
