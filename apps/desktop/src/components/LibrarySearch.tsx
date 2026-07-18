import { X } from 'lucide-react';
import { SearchSmIcon } from '@/components/LoomIcons';
import type { ReactNode } from 'react';

interface LibrarySearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rightSlot?: ReactNode;
}

export default function LibrarySearch({ value, onChange, placeholder = 'Search library', rightSlot }: LibrarySearchProps) {
  return (
    <div className="loom-library-search pointer-events-none fixed left-48 right-0 top-4 z-40 flex justify-center px-4">
      <div className="loom-library-search-inner flex w-full max-w-3xl items-center justify-center gap-2">
        <div className="loom-library-search-control loom-no-drag pointer-events-auto flex h-12 min-w-0 flex-1 items-center gap-3 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] px-4 text-[var(--loom-text)] shadow-[0_16px_42px_rgba(0,0,0,0.18)] backdrop-blur-md transition-colors">
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
