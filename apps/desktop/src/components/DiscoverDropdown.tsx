import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export type ThemeDropdownOption = {
  value: string;
  label: string;
  logoUrl?: string;
};

function ProviderLogo({ src, label }: { src?: string; label: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => {
    setFailedSrc(null);
  }, [src]);

  if (!src || failedSrc === src) {
    return (
      <span
        aria-hidden="true"
        className="grid h-6 w-6 shrink-0 place-items-center rounded bg-[var(--loom-surface-3)] text-[10px] font-semibold text-[var(--loom-muted)]"
      >
        {label.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className="h-6 w-6 shrink-0 rounded object-contain"
      onError={() => setFailedSrc(src)}
    />
  );
}

export default function ThemeDropdown({
  id,
  label,
  value,
  options,
  onChange,
  buttonClassName,
  searchable = false,
  searchPlaceholder = 'Search',
  emptySearchMessage = 'No matching options',
  multiSelect = false,
}: {
  id: string;
  label: string;
  value: string;
  options: ThemeDropdownOption[];
  onChange: (value: string) => void;
  buttonClassName?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptySearchMessage?: string;
  multiSelect?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{ left: number; top: number; width: number } | null>(null);
  const selectedValues = useMemo(
    () => value.split(',').map((entry) => entry.trim()).filter(Boolean),
    [value],
  );
  const selectedValueSet = useMemo(() => new Set(selectedValues), [selectedValues]);
  const selectedOption = multiSelect && selectedValues.length !== 1
    ? undefined
    : options.find((option) => option.value === (multiSelect ? selectedValues[0] : value));
  const selectedLabel = useMemo(
    () => {
      if (!multiSelect) return options.find((option) => option.value === value)?.label || options[0]?.label || 'Select';
      if (selectedValues.length === 0) return options[0]?.label || 'Select';
      if (selectedValues.length === 1) return options.find((option) => option.value === selectedValues[0])?.label || '1 selected';
      return `${selectedValues.length} genres`;
    },
    [multiSelect, options, selectedValues, value],
  );
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
    const handleReposition = () => computeMenuStyle();
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
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [computeMenuStyle, isOpen]);

  useEffect(() => {
    if (!isOpen) setSearchQuery('');
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative text-sm">
      <button
        type="button"
        id={id}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        ref={buttonRef}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (['Escape', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
            if (event.key === 'Escape') {
              setIsOpen(false);
              return;
            }
            event.preventDefault();
            setIsOpen(true);
          }
        }}
        className={`relative z-10 inline-flex h-8 min-w-[9rem] items-center gap-2 rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 pr-10 text-[var(--loom-text)] text-sm font-normal outline-none transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] ${buttonClassName || ''}`}
      >
        {selectedOption?.logoUrl !== undefined && <ProviderLogo src={selectedOption.logoUrl} label={selectedOption.label} />}
        <span className="truncate whitespace-nowrap">{selectedLabel}</span>
        <ChevronDown className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && menuStyle ? createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          className="fixed z-[9999] w-max max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-1 text-[var(--loom-text)] shadow-[0_18px_40px_rgba(0,0,0,0.30)]"
          style={{ left: menuStyle.left, top: menuStyle.top, minWidth: menuStyle.width }}
        >
          {searchable && (
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
          )}
          <div className={searchable ? 'max-h-52 overflow-y-auto' : 'max-h-64 overflow-y-auto'}>
            {filteredOptions.length === 0 ? (
              <p className="px-3 py-2 text-sm text-[var(--loom-muted)]">{emptySearchMessage}</p>
            ) : filteredOptions.map((option) => {
              const selected = multiSelect
                ? option.value ? selectedValueSet.has(option.value) : selectedValues.length === 0
                : option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    if (!multiSelect) {
                      onChange(option.value);
                      setIsOpen(false);
                      return;
                    }
                    const nextValues = new Set(selectedValues);
                    if (!option.value) nextValues.clear();
                    else if (nextValues.has(option.value)) nextValues.delete(option.value);
                    else nextValues.add(option.value);
                    onChange(Array.from(nextValues).join(','));
                  }}
                  className={`relative z-10 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${selected
                    ? 'bg-[var(--loom-surface-3)] text-[var(--loom-text)]'
                    : 'text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]'
                  }`}
                >
                  {multiSelect && (
                    <span
                      aria-hidden="true"
                      className={`grid h-4 w-4 shrink-0 place-items-center rounded border text-[11px] leading-none ${selected
                        ? 'border-[var(--loom-text)] bg-[var(--loom-text)] text-[var(--loom-bg)]'
                        : 'border-[var(--loom-muted)]'
                      }`}
                    >
                      {selected ? '✓' : null}
                    </span>
                  )}
                  {option.logoUrl !== undefined && <ProviderLogo src={option.logoUrl} label={option.label} />}
                  <span className="truncate whitespace-nowrap">{option.label}</span>
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

