import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { SearchSmIcon } from '@/components/LoomIcons';
import { useTheme } from '@/components/ThemeProvider';
import { useLocation, useNavigate } from '@/lib/navigation';
import { pageSearchFilter, usePageSearch } from '@/lib/pageSearch';
import type { MediaItem } from '@/contexts/LibraryContext';
import { SearchPaletteFrame } from '@/components/SearchPaletteFrame';
import LocalTitleSearch from '@/components/LocalTitleSearch';

interface LibrarySearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rightSlot?: ReactNode;
  showModernSearchTrigger?: boolean;
  placement?: 'floating' | 'inline';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  localItems?: readonly MediaItem[];
  resultContent?: ReactNode;
}

export default function LibrarySearch({ value, onChange, placeholder = 'Search library', rightSlot,
  showModernSearchTrigger = true, placement = 'floating', open, onOpenChange, localItems, resultContent,
}: LibrarySearchProps) {
  const { theme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsId = useId();
  const isModern = theme.homeStyle === 'modern';
  const isInline = placement === 'inline';
  const changeOpen = useCallback((next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  usePageSearch(() => changeOpen(true));

  useEffect(() => {
    const routeState = location.state as { openLibrarySearch?: boolean } | null;
    if (!routeState?.openLibrarySearch) return;
    changeOpen(true);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.pathname, location.search, location.state, navigate, changeOpen]);

  return <>
    <div className={isInline ? 'w-[min(22rem,100%)] min-w-0 shrink-0'
      : isModern ? 'loom-library-search loom-library-search-modern loom-no-drag pointer-events-none fixed left-24 right-5 top-6 z-[55] flex justify-end'
        : 'loom-library-search pointer-events-none fixed left-48 right-0 top-4 z-40 flex justify-center px-4'}>
      <div className={`loom-library-search-inner flex items-center gap-2 ${isModern && !isInline ? 'justify-end' : 'w-full max-w-3xl'}`}>
        {(isInline || !isModern || showModernSearchTrigger) && <button type="button" onClick={() => changeOpen(true)}
          aria-label={placeholder} aria-haspopup="dialog" aria-expanded={isOpen}
          className={`loom-library-search-control loom-modern-category-pill loom-no-drag pointer-events-auto flex min-w-0 flex-1 items-center gap-3 rounded-full border px-4 text-left text-sm text-[var(--loom-muted)] transition-colors hover:text-[var(--loom-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${isInline ? 'h-10' : 'h-12'}`}>
          <SearchSmIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{value || placeholder}</span>
        </button>}
        {!isOpen && rightSlot && <div className="loom-library-search-slot loom-no-drag pointer-events-auto shrink-0">{rightSlot}</div>}
      </div>
    </div>
    {resultContent === undefined ? <LocalTitleSearch key={`${location.pathname}:${isOpen}`} initialFilter={pageSearchFilter(location.pathname)} open={isOpen} onOpenChange={changeOpen} query={value} onQueryChange={onChange}
      items={localItems} title={placeholder} actions={rightSlot} />
      : <SearchPaletteFrame wide open={isOpen} onOpenChange={changeOpen} title={placeholder}
        description="Search the current collection. Use Tab to navigate results and Return to open one."
        query={value} onQueryChange={onChange} controls={resultsId} inputRef={inputRef}
        onKeyDown={event => {
          const first = resultsRef.current?.querySelector<HTMLElement>('a[href], [data-search-result], [role="button"]');
          if (!first) return;
          if (event.key === 'ArrowDown') { event.preventDefault(); first.focus(); }
          if (event.key === 'Enter') { event.preventDefault(); first.click(); }
        }}>
        {rightSlot && <div className="shrink-0 border-b border-[var(--loom-border)] px-5 py-2">{rightSlot}</div>}
        <div ref={resultsRef} id={resultsId} className="min-h-0 overflow-y-auto overscroll-contain p-5"
          onClick={event => { if ((event.target as Element).closest('a[href], [data-search-result], [role="button"]')) changeOpen(false); }}>
          {value.trim() ? resultContent : <p role="status" className="px-3 py-6 text-center text-sm text-[var(--loom-muted)]">Type to search.</p>}
        </div>
        <div className="shrink-0 border-t border-[var(--loom-border)] px-5 py-2 text-xs text-[var(--loom-muted)]">Tab navigates · Return opens · Esc closes</div>
      </SearchPaletteFrame>}
  </>;
}
