import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

type ToastTone = 'info' | 'success' | 'warning' | 'error';
type ToastVariant = 'default' | 'confirmation';

type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
  variant?: ToastVariant;
};

type ToastItem = Omit<ToastInput, 'tone' | 'durationMs' | 'variant'> & {
  id: number;
  tone: ToastTone;
  variant: ToastVariant;
  durationMs: number;
  expiresAt: number;
};

type ToastContextValue = {
  showToast: (toast: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_TONE_STYLES: Record<ToastTone, { icon: React.ComponentType<{ className?: string }>; accent: string }> = {
  info: { icon: Info, accent: 'text-[var(--loom-accent)]' },
  success: { icon: CheckCircle2, accent: 'text-emerald-300' },
  warning: { icon: AlertCircle, accent: 'text-[var(--loom-accent)]' },
  error: { icon: AlertCircle, accent: 'text-red-300' },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((toast: ToastInput) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const durationMs = Math.max(1500, Math.min(10_000, toast.durationMs || 5000));
    setToasts((current) => [
      ...current.slice(-2),
      {
        ...toast,
        id,
        durationMs,
        expiresAt: Date.now() + durationMs,
        tone: toast.tone || 'info',
        variant: toast.variant || 'default',
      },
    ]);
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) =>
      window.setTimeout(() => dismissToast(toast.id), Math.max(0, toast.expiresAt - Date.now())),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [dismissToast, toasts]);

  const value = useMemo(() => ({ showToast }), [showToast]);
  const defaultToasts = toasts.filter((toast) => toast.variant === 'default');
  const confirmationToasts = toasts.filter((toast) => toast.variant === 'confirmation');

  const renderToast = (toast: ToastItem) => {
    const tone = TOAST_TONE_STYLES[toast.tone];
    const Icon = tone.icon;
    const isConfirmation = toast.variant === 'confirmation';
    const confirmationColor = toast.tone === 'success'
      ? 'border-emerald-200/45 bg-emerald-500 text-white shadow-[0_14px_45px_rgba(16,185,129,0.45)]'
      : 'border-sky-200/45 bg-sky-500 text-white shadow-[0_14px_45px_rgba(14,165,233,0.45)]';

    return (
      <div
        key={toast.id}
        className={isConfirmation
          ? `loom-toast loom-toast-confirmation pointer-events-auto flex items-center gap-2.5 rounded-full border px-5 py-3 font-semibold ${confirmationColor}`
          : 'loom-toast pointer-events-auto flex gap-3 rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-surface)]/95 p-3 text-[var(--loom-text)] shadow-2xl backdrop-blur-md'}
        style={{ animationDuration: `${toast.durationMs}ms` }}
      >
        <Icon className={`${isConfirmation ? 'h-5 w-5 text-white' : `mt-0.5 h-5 w-5 ${tone.accent}`} shrink-0`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-5">{toast.title}</div>
          {!isConfirmation && toast.description && (
            <div className="mt-0.5 text-xs leading-5 text-[var(--loom-muted)]">{toast.description}</div>
          )}
        </div>
        {!isConfirmation && (
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(toast.id)}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-5 top-5 z-[100] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-3">
        {defaultToasts.map(renderToast)}
      </div>
      <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex w-[min(360px,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-3">
        {confirmationToasts.map(renderToast)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    return { showToast: () => undefined };
  }
  return context;
}
