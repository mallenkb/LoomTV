import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export type ThemeFilterOption = {
  value: string;
  label: string;
};

type ThemeFilterDropdownProps = {
  id: string;
  label: string;
  value: string;
  options: readonly ThemeFilterOption[];
  onChange: (value: string) => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptySearchMessage?: string;
  buttonClassName?: string;
};

/** Single-select filter that matches the controls used by Discover. */
export default function ThemeFilterDropdown({
  id,
  label,
  value,
  options,
  onChange,
  searchable = false,
  searchPlaceholder = 'Search',
  emptySearchMessage = 'No matching options',
  buttonClassName = '',
}: ThemeFilterDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{ left: number; top: number; width: number } | null>(null);
  const selectedLabel = options.find((option) => option.value === value)?.label || options[0]?.label || 'Select';
  const filteredOptions = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) => option.label.toLowerCase().includes(normalizedQuery));
  }, [options, searchQuery]);

  const computeMenuStyle = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const buttonRect = button.getBoundingClientRect();
    const estimatedMenuHeight = searchable ? 280 : 272;
    const openAbove = window.innerHeight - buttonRect.bottom < estimatedMenuHeight && buttonRect.top > estimatedMenuHeight;
    setMenuStyle({
      left: buttonRect.left,
      top: openAbove ? buttonRect.top - estimatedMenuHeight - 6 : buttonRect.bottom + 6,
      width: buttonRect.width,
    });
  }, [searchable]);

  useEffect(() => {
    if (!isOpen) return;
    computeMenuStyle();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', computeMenuStyle);
    window.addEventListener('scroll', computeMenuStyle, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', computeMenuStyle);
      window.removeEventListener('scroll', computeMenuStyle, true);
    };
  }, [computeMenuStyle, isOpen]);

  useEffect(() => {
    if (!isOpen) setSearchQuery('');
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative text-sm">
      <button
        ref={buttonRef}
        id={id}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className={`relative z-10 inline-flex h-8 min-w-[9rem] items-center gap-2 rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 pr-10 text-sm font-normal text-[var(--loom-text)] outline-none transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] ${buttonClassName}`}
      >
        <span className="truncate whitespace-nowrap">{selectedLabel}</span>
        <ChevronDown
          className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {isOpen && menuStyle ? createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          className="fixed z-[9999] w-max max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-1 text-[var(--loom-text)] shadow-[0_18px_40px_rgba(0,0,0,0.30)]"
          style={{ left: menuStyle.left, top: menuStyle.top, minWidth: menuStyle.width }}
        >
          {searchable ? (
            <div className="relative z-20 mb-1 bg-[var(--loom-surface-2)] p-1 pb-2">
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setIsOpen(false);
                  }
                }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                autoFocus
                className="loom-dropdown-search-input h-9 w-full rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-surface-3)] px-2.5 text-sm text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)]"
              />
            </div>
          ) : null}
          <div className={searchable ? 'max-h-52 overflow-y-auto' : 'max-h-64 overflow-y-auto'}>
            {filteredOptions.length === 0 ? (
              <p className="px-3 py-2 text-sm text-[var(--loom-muted)]">{emptySearchMessage}</p>
            ) : filteredOptions.map((option) => {
              const selected = option.value === value;
              return (
                <button
                  key={option.value || 'all'}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(option.value);
                    setIsOpen(false);
                  }}
                  className={`relative z-10 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${selected
                    ? 'bg-[var(--loom-surface-3)] text-[var(--loom-text)]'
                    : 'text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate whitespace-nowrap">{option.label}</span>
                  {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
