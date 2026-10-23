import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

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
        contentClassName="loom-settings-dialog-surface w-[min(420px,calc(100vw-32px))] max-w-none border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]"
      >
        {request && (
          <DialogContent className="px-5 pb-5 pt-5">
            <DialogHeader className="flex items-start gap-3 text-left">
              {request.destructive && (
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-red-500/15 text-red-400" aria-hidden="true">
                  <AlertTriangle className="h-4 w-4" />
                </span>
              )}
              <div className="min-w-0">
                <DialogTitle className="text-[15px] font-semibold leading-6 text-[var(--loom-text)]">{request.title}</DialogTitle>
                <DialogDescription className="mt-0.5 text-[13px] leading-5 text-[var(--loom-muted)]">{request.description}</DialogDescription>
              </div>
            </DialogHeader>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => settle(false)}>
                {request.cancelLabel || 'Cancel'}
              </Button>
              <Button type="button" size="sm" variant={request.destructive ? 'destructive' : 'default'} onClick={() => settle(true)}>
                {request.confirmLabel || 'Continue'}
              </Button>
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
