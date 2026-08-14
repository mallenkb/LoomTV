import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { FilterFunnelIcon } from '@/components/LoomIcons';
import SharedListHighlight from '@/components/SharedListHighlight';
import { useLibraryFilterVisibility } from '@/contexts/LibraryFilterVisibilityContext';
import {
  libraryFilterOptions,
  issueLibraryFilterOptions,
  personalLibraryFilterOptions,
  primaryLibraryFilterOptions,
  type LibraryFilterOption,
  type LibraryFilter,
} from '@/lib/libraryFilters';

interface LibraryFilterBarProps {
  activeFilter: LibraryFilter;
  onChange: (filter: LibraryFilter) => void;
}

export default function LibraryFilterBar({ activeFilter, onChange }: LibraryFilterBarProps) {
  const isVisible = useLibraryFilterVisibility();
  const [filterOpen, setFilterOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeOption = libraryFilterOptions.find((option) => option.id === activeFilter);

  useEffect(() => {
    if (!isVisible) {
      if (filterOpen) setFilterOpen(false);
      return undefined;
    }
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
  }, [filterOpen, isVisible]);

  const chooseFilter = (filter: LibraryFilter) => {
    onChange(filter);
    setFilterOpen(false);
  };

  if (!isVisible) return null;

  return (
    <div ref={menuRef} className="loom-library-filter relative z-10 shrink-0 pointer-events-auto">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={filterOpen}
        aria-label={`Filter library, ${activeOption?.label || 'All'}`}
        title={`Filter: ${activeOption?.label || 'All'}`}
        onClick={() => setFilterOpen((open) => !open)}
        style={{ borderColor: 'var(--loom-panel-border)' }}
        className={`loom-library-filter-trigger loom-no-drag pointer-events-auto relative z-10 inline-flex h-12 w-12 items-center justify-center rounded-full border p-0 shadow-[0_16px_42px_rgba(0,0,0,0.34)] backdrop-blur-md transition-[border-color,background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]/70 ${
          activeFilter === 'all'
            ? 'bg-[var(--loom-panel)] text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]'
            : 'bg-[var(--loom-active-bg)] text-[var(--loom-active-text)]'
        }`}
      >
        <FilterFunnelIcon className="h-4 w-4" />
      </button>

      {filterOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-lg bg-[var(--loom-surface)] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.38)]"
        >
          <SharedListHighlight activeId={activeFilter} followPointer={false} className="loom-shared-highlight-menu">
            <FilterMenuGroup
              label="Watch status"
              activeFilter={activeFilter}
              options={primaryLibraryFilterOptions}
              onChoose={chooseFilter}
            />
            <FilterMenuGroup
              label="Personal lists"
              activeFilter={activeFilter}
              options={personalLibraryFilterOptions}
              onChoose={chooseFilter}
            />
            <FilterMenuGroup
              label="Library health"
              activeFilter={activeFilter}
              options={issueLibraryFilterOptions}
              onChoose={chooseFilter}
            />
          </SharedListHighlight>
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
  options: LibraryFilterOption[];
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
          aria-current={activeFilter === option.id ? 'true' : undefined}
          onClick={() => onChoose(option.id)}
          data-shared-highlight-item
          data-shared-highlight-id={option.id}
          className={`relative z-10 flex w-full items-center justify-between rounded px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${
            activeFilter === option.id
              ? 'text-[var(--loom-active-text)]'
              : 'text-[var(--loom-muted)] hover:text-[var(--loom-text)]'
          }`}
        >
          <span>{option.label}</span>
          {activeFilter === option.id && <Check className="h-3.5 w-3.5 text-[var(--loom-active-text)]" />}
        </button>
      ))}
    </div>
  );
}
