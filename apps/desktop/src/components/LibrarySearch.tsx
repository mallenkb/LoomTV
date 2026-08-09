import { X } from 'lucide-react';
import { SearchSmIcon } from '@/components/LoomIcons';
import { useState, type ReactNode } from 'react';
import { useTheme } from '@/components/ThemeProvider';

interface LibrarySearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rightSlot?: ReactNode;
  /** Hide the floating search trigger when search is available from navigation. */
  showModernSearchTrigger?: boolean;
  placement?: 'floating' | 'inline';
}

export default function LibrarySearch({
  value,
  onChange,
  placeholder = 'Search library',
  rightSlot,
  showModernSearchTrigger = true,
  placement = 'floating',
}: LibrarySearchProps) {
  const { theme } = useTheme();
  const [isModernSearchOpen, setIsModernSearchOpen] = useState(Boolean(value));

  if (placement === 'inline') {
    return (
      <div className="w-[min(22rem,100%)] min-w-0 shrink-0">
        <div className="loom-library-search-control loom-no-drag pointer-events-auto flex h-10 min-w-0 items-center gap-3 rounded-full border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] px-3 text-[var(--loom-text)] shadow-[0_12px_30px_rgba(0,0,0,0.16)] backdrop-blur-md transition-colors">
          <SearchSmIcon className="h-4 w-4 shrink-0 text-[var(--loom-muted)]" />
          <input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-sm font-medium text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)]"
          />
          {value && (
            <button
              type="button"
              onClick={() => onChange('')}
              aria-label="Clear search"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    );
  }

  if (theme.homeStyle === 'modern') {
    return (
      <div className="loom-library-search loom-library-search-modern loom-no-drag pointer-events-none fixed left-24 right-5 top-6 z-[55] flex justify-end">
        <div className="loom-library-search-inner flex items-center justify-end gap-2">
          {isModernSearchOpen ? (
            <div className="loom-library-search-control loom-no-drag pointer-events-auto flex h-12 w-[min(22rem,calc(100vw-9rem))] items-center gap-3 rounded-full border border-[var(--loom-panel-border)] bg-black/55 px-4 text-white shadow-[0_16px_42px_rgba(0,0,0,0.34)] backdrop-blur-xl transition-colors">
              <SearchSmIcon className="h-5 w-5 shrink-0 text-white/60" />
              <input
                type="text"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                autoComplete="off"
                autoFocus
                className="h-full min-w-0 flex-1 bg-transparent text-sm font-medium text-white outline-none placeholder:text-white/38"
              />
              <button
                type="button"
                onClick={() => {
                  onChange('');
                  setIsModernSearchOpen(false);
                }}
                aria-label="Close search"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/55 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : showModernSearchTrigger ? (
            <button
              type="button"
              onClick={() => setIsModernSearchOpen(true)}
              aria-label={placeholder}
              title={placeholder}
              className="loom-no-drag pointer-events-auto grid h-12 w-12 place-items-center rounded-full border border-white/12 bg-black/55 text-white/70 shadow-[0_16px_42px_rgba(0,0,0,0.34)] backdrop-blur-xl transition-[background-color,color,transform] hover:scale-105 hover:bg-white/12 hover:text-white"
            >
              <SearchSmIcon className="h-5 w-5" />
            </button>
          ) : null}
          {rightSlot && (
            <div className="loom-library-search-slot loom-no-drag pointer-events-auto shrink-0">
              {rightSlot}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="loom-library-search pointer-events-none fixed left-48 right-0 top-4 z-40 flex justify-center px-4">
      <div className="loom-library-search-inner flex w-full max-w-3xl items-center justify-center gap-2">
        <div className="loom-library-search-control loom-no-drag pointer-events-auto flex h-12 min-w-0 flex-1 items-center gap-3 rounded-full border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] px-4 text-[var(--loom-text)] shadow-[0_16px_42px_rgba(0,0,0,0.18)] backdrop-blur-md transition-colors">
          <SearchSmIcon className="h-5 w-5 shrink-0 text-[var(--loom-muted)]" />
          <input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-sm font-medium text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)]"
          />
          {value && (
            <button
              type="button"
              onClick={() => onChange('')}
              aria-label="Clear search"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {rightSlot && (
          <div className="loom-library-search-slot loom-no-drag pointer-events-auto shrink-0">
            {rightSlot}
          </div>
        )}
      </div>
    </div>
  );
}
