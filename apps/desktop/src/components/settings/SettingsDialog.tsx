import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const WIDTHS = {
  sm: 'w-[min(420px,calc(100vw-32px))]',
  md: 'w-[min(520px,calc(100vw-32px))]',
  lg: 'w-[min(720px,calc(100vw-32px))]',
} as const;

/**
 * One layout for every settings dialog: title and close button on one row,
 * a scrolling body, and a footer with an optional note on the left and the
 * actions on the right.
 */
export function SettingsDialog({ open, onClose, title, description, size = 'md', children, footer, footerStart, busy = false, hideHeader = false, fullWidthFooter = false, headerContent, closeOnOutsideClick = true }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  size?: keyof typeof WIDTHS;
  children?: ReactNode;
  footer?: ReactNode;
  footerStart?: ReactNode;
  fullWidthFooter?: boolean;
  headerContent?: ReactNode;
  closeOnOutsideClick?: boolean;
  /** Blocks closing while work is in progress. */
  busy?: boolean;
  /** For dialogs whose content already has its own heading. */
  hideHeader?: boolean;
}) {
  const close = () => { if (!busy) onClose(); };
  return (
    <Dialog
      open={open}
      closeOnOutsideClick={closeOnOutsideClick}
      onOpenChange={(next) => { if (!next) close(); }}
      contentClassName={cn('loom-settings-dialog-surface flex max-h-[min(86dvh,780px)] max-w-none flex-col overflow-hidden border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]', WIDTHS[size])}
    >
      <DialogContent className="flex min-h-0 flex-1 flex-col">
        <div className={hideHeader && !headerContent ? 'absolute right-5 top-5 z-10 flex items-start' : 'flex shrink-0 items-start gap-3 px-5 pb-4 pt-5'}>
          {headerContent ? <div className="min-w-0 flex-1">{headerContent}</div> : null}
          <DialogHeader className={cn('min-w-0 flex-1 text-left', hideHeader && 'sr-only')}>
            <DialogTitle className="text-[15px] font-semibold leading-6 text-[var(--loom-text)]">{title}</DialogTitle>
            {description ? <DialogDescription className="mt-0.5 text-[13px] leading-5 text-[var(--loom-muted)]">{description}</DialogDescription> : null}
          </DialogHeader>
          <Button type="button" variant="ghost" size="icon" onClick={close} disabled={busy} aria-label={`Close ${title}`} className={cn('-mr-1.5 -mt-0.5 h-8 w-8 shrink-0 text-[var(--loom-muted)]', hideHeader && 'ml-auto')}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-5', hideHeader && !headerContent && 'pt-5')}>{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-5 pt-4">
            {footerStart || !fullWidthFooter ? <div className="min-w-0 text-xs text-[var(--loom-muted)]">{footerStart}</div> : null}
            <div className={cn('ml-auto flex flex-wrap items-center gap-2', fullWidthFooter && 'w-full')}>{footer}</div>
          </div>
        ) : <div className="h-5 shrink-0" aria-hidden="true" />}
      </DialogContent>
    </Dialog>
  );
}

/** A label above its control inside a settings dialog. */
export function SettingsDialogField({ label, htmlFor, hint, children, className }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-[var(--loom-muted)]">{label}</label>
      {children}
      {hint ? <p className="text-xs leading-5 text-[var(--loom-faint)]">{hint}</p> : null}
    </div>
  );
}

/** Inline error or warning inside a dialog body. */
export function SettingsDialogMessage({ tone = 'error', children }: { tone?: 'error' | 'warning' | 'ok'; children: ReactNode }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-lg px-3 py-2 text-[13px] leading-5',
        tone === 'error' && 'settings-status-error bg-red-500/10',
        tone === 'warning' && 'settings-status-warning bg-amber-400/10',
        tone === 'ok' && 'settings-status-available bg-emerald-400/10',
      )}
    >
      {children}
    </p>
  );
}

/** The shared look for text inputs and selects inside settings dialogs. */
export const SETTINGS_INPUT_CLASS = 'h-9 w-full min-w-0 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)] disabled:cursor-not-allowed disabled:opacity-60';
