import type { MouseEventHandler } from 'react';
import { ChevronDown, Tv } from 'lucide-react';

export const WATCH_PROVIDERS_TRIGGER_ID = 'loom-watch-providers-trigger';
export const WATCH_PROVIDERS_PANEL_ID = 'loom-watch-providers-panel';

export default function DetailWhereToWatch({ onClick, open = false }: { onClick: MouseEventHandler<HTMLButtonElement>; open?: boolean }) {
  return (
    <button
      id={WATCH_PROVIDERS_TRIGGER_ID}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? WATCH_PROVIDERS_PANEL_ID : undefined}
      onClick={onClick}
      className="loom-detail-where-to-watch loom-no-drag pointer-events-auto fixed z-[80] flex h-10 items-center gap-2 rounded-full border border-[var(--loom-control-border)] bg-[var(--loom-panel)] px-3 text-sm text-[var(--loom-text)] shadow-lg transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
    >
      <Tv aria-hidden="true" className="h-5 w-5" />
      <span>Where to watch</span>
      <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}
