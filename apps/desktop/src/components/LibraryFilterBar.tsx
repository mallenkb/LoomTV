import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { FilterFunnelIcon } from '@/components/LoomIcons';
import {
  libraryFilterOptions,
  primaryLibraryFilterOptions,
  type LibraryFilter,
} from '@/lib/libraryFilters';

interface LibraryFilterBarProps {
  activeFilter: LibraryFilter;
  onChange: (filter: LibraryFilter) => void;
}

export default function LibraryFilterBar({ activeFilter, onChange }: LibraryFilterBarProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeOption = libraryFilterOptions.find((option) => option.id === activeFilter);

  useEffect(() => {
    if (!filterOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFilterOpen(false);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [filterOpen]);

  const chooseFilter = (filter: LibraryFilter) => {
    onChange(filter);
    setFilterOpen(false);
  };

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={filterOpen}
        aria-label={`Filter library, ${activeOption?.label || 'All'}`}
        title={`Filter: ${activeOption?.label || 'All'}`}
        onClick={() => setFilterOpen((open) => !open)}
        className={`inline-flex h-12 w-12 items-center justify-center rounded-lg border p-0 shadow-[0_16px_42px_rgba(0,0,0,0.34)] backdrop-blur-md transition-[border-color,background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]/70 ${
          activeFilter === 'all'
            ? 'border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-muted)] hover:bg-white/10 hover:text-white'
            : 'border-[var(--loom-accent)] bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]'
        }`}
      >
        <FilterFunnelIcon className="h-4 w-4" />
      </button>

      {filterOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-surface)] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.38)]"
        >
          <FilterMenuGroup
            label="Watch status"
            activeFilter={activeFilter}
            options={primaryLibraryFilterOptions}
            onChoose={chooseFilter}
          />
        </div>
      )}
    </div>
  );
}

function FilterMenuGroup({
  label,
  activeFilter,
  options,
  onChoose,
}: {
  label: string;
  activeFilter: LibraryFilter;
  options: typeof primaryLibraryFilterOptions;
  onChoose: (filter: LibraryFilter) => void;
}) {
  return (
    <div className="border-b border-[var(--loom-panel-border)] py-1 last:border-b-0">
      <div className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--loom-faint)]">
        {label}
      </div>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="menuitem"
          onClick={() => onChoose(option.id)}
          className={`flex w-full items-center justify-between rounded px-2.5 py-2 text-left text-xs transition-colors ${
            activeFilter === option.id
              ? 'bg-white/10 text-white'
              : 'text-[var(--loom-muted)] hover:bg-white/10 hover:text-white'
          }`}
        >
          <span>{option.label}</span>
          {activeFilter === option.id && <Check className="h-3.5 w-3.5 text-[var(--loom-accent)]" />}
        </button>
      ))}
    </div>
  );
}
