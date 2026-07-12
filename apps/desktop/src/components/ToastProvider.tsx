import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

type ToastTone = 'info' | 'success' | 'warning' | 'error';

type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
};

type ToastItem = ToastInput & {
  id: number;
  tone: ToastTone;
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
    setToasts((current) => [
      ...current.slice(-2),
      { ...toast, id, tone: toast.tone || 'info' },
    ]);
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) =>
      window.setTimeout(() => dismissToast(toast.id), 5000),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [dismissToast, toasts]);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-5 top-5 z-[100] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-3">
        {toasts.map((toast) => {
          const tone = TOAST_TONE_STYLES[toast.tone];
          const Icon = tone.icon;
          return (
            <div
              key={toast.id}
              className="pointer-events-auto flex gap-3 rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-surface)]/95 p-3 text-[var(--loom-text)] shadow-2xl backdrop-blur-md"
            >
              <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${tone.accent}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold leading-5">{toast.title}</div>
                {toast.description && (
                  <div className="mt-0.5 text-xs leading-5 text-[var(--loom-muted)]">{toast.description}</div>
                )}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
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
