import type { ReactNode } from 'react';
import LibraryFilterBar from '@/components/LibraryFilterBar';
import LibrarySearch from '@/components/LibrarySearch';
import { useTheme } from '@/components/ThemeProvider';
import type { LibraryFilter } from '@/lib/libraryFilters';

interface LibraryPageLayoutProps {
  title: string;
  subtitle?: string;
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  activeFilter: LibraryFilter;
  onFilterChange: (filter: LibraryFilter) => void;
  children: ReactNode;
}

/** Shared frame for every library route so its controls and scroll clearance
 * stay aligned with Home as the individual page content changes. */
export default function LibraryPageLayout({
  title,
  subtitle,
  query,
  onQueryChange,
  placeholder,
  activeFilter,
  onFilterChange,
  children,
}: LibraryPageLayoutProps) {
  const { theme } = useTheme();
  const isModern = theme.homeStyle === 'modern';
  const frameClass = isModern ? 'loom-modern-content-frame' : 'loom-frame';
  const topPaddingClass = isModern ? 'pt-28' : 'pt-24';

  return (
    <div className="loom-page loom-library-page h-full overflow-y-auto">
      <LibrarySearch
        value={query}
        onChange={onQueryChange}
        placeholder={placeholder}
        showModernSearchTrigger={false}
        rightSlot={<LibraryFilterBar activeFilter={activeFilter} onChange={onFilterChange} />}
      />
      <div className={`${frameClass} loom-library-page-frame page-bottom-safe page-list-bottom-safe ${topPaddingClass}`}>
        <header className="loom-library-page-heading mb-6 flex min-h-8 items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-[var(--loom-text)]">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-[var(--loom-muted)]">{subtitle}</p> : null}
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
