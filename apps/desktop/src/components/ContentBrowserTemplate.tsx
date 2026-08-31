import { useState, type ReactNode } from 'react';
import { ImageIcon } from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import LibrarySearch from '@/components/LibrarySearch';
import SafeArtwork from '@/components/SafeArtwork';
import { LandscapeGridShimmer } from '@/components/ContentShimmer';

export type ContentBrowserTemplateItem = {
  id: string;
  title: string;
  subtitle?: string;
  metadata?: string;
  artworkUrl?: string;
  badge?: string;
  indicator?: string;
};

type ContentBrowserTemplateProps<TItem extends ContentBrowserTemplateItem> = {
  title: string;
  description: string;
  items: readonly TItem[];
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (item: TItem) => void;
  searchPlaceholder?: string;
  filters?: ReactNode;
  loading?: boolean;
  error?: string;
  emptyMessage?: string;
};

/**
 * Provider-neutral browse shell for future catalog integrations. Data loading,
 * filtering, and playback decisions stay with the consumer so this component
 * never contacts a remote service on its own.
 */
export default function ContentBrowserTemplate<TItem extends ContentBrowserTemplateItem>({
  title,
  description,
  items,
  query,
  onQueryChange,
  onSelect,
  searchPlaceholder = 'Search content',
  filters,
  loading = false,
  error = '',
  emptyMessage = 'No content is available.',
}: ContentBrowserTemplateProps<TItem>) {
  const { theme } = useTheme();
  const [isHeaderScrolled, setIsHeaderScrolled] = useState(false);
  const isModern = theme.homeStyle === 'modern';
  const frameClass = isModern ? 'loom-modern-content-frame' : 'loom-frame';
  const topPaddingClass = isModern ? 'pt-6' : 'loom-discover-page-frame';

  return (
    <div
      className="loom-page loom-library-page h-full overflow-y-auto bg-[var(--loom-bg)]"
      onScroll={(event) => setIsHeaderScrolled(event.currentTarget.scrollTop > 4)}
    >
      <div className={`${frameClass} loom-library-page-frame page-bottom-safe page-list-bottom-safe ${topPaddingClass}`}>
        <header className={`loom-library-page-heading sticky top-0 z-40 isolate mb-6 flex min-h-8 shrink-0 flex-wrap items-start justify-between gap-4 border-b bg-[var(--loom-bg)] py-3 backdrop-blur-xl transition-[border-color,box-shadow] duration-150 ${isHeaderScrolled ? 'border-[var(--loom-border)] shadow-[0_12px_24px_-22px_rgb(0_0_0_/_0.9)]' : 'border-transparent'}`}>
          <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold text-[var(--loom-text)]">{title}</h1>
              <p className="mt-1 truncate text-sm text-[var(--loom-muted)]">{description}</p>
            </div>
            <LibrarySearch
              value={query}
              onChange={onQueryChange}
              placeholder={searchPlaceholder}
              placement="inline"
            />
          </div>
          {filters ? <div className="flex w-full items-center gap-2 overflow-x-auto overflow-y-visible pb-1">{filters}</div> : null}
        </header>

        {error ? (
          <div role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {loading ? (
          <LandscapeGridShimmer />
        ) : items.length === 0 ? (
          <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed border-[var(--loom-panel-border)] px-6 text-center text-sm text-[var(--loom-muted)]">
            {emptyMessage}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-x-4 gap-y-7">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item)}
                className="group relative min-w-0 w-full overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--loom-bg)]"
              >
                <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-[var(--loom-panel-border)] bg-[var(--loom-surface-2)] transition-[border-color,transform] duration-200 group-hover:-translate-y-0.5 group-hover:border-[var(--loom-accent)]">
                  {item.artworkUrl ? (
                    <SafeArtwork
                      src={item.artworkUrl}
                      alt=""
                      className="h-full w-full"
                      imgClassName="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                      fallback={<div className="grid h-full place-items-center"><ImageIcon className="h-10 w-10 text-[var(--loom-faint)]" aria-hidden="true" /></div>}
                    />
                  ) : (
                    <div className="grid h-full place-items-center bg-gradient-to-br from-[var(--loom-surface-3)] to-[var(--loom-panel)]">
                      <ImageIcon className="h-10 w-10 text-[var(--loom-faint)]" aria-hidden="true" />
                    </div>
                  )}
                  {item.badge ? (
                    <span className="absolute left-4 top-4 rounded-lg bg-[var(--loom-accent)] px-3 py-1.5 text-xs font-bold tracking-wide text-[var(--loom-accent-foreground)] shadow-lg">
                      {item.badge}
                    </span>
                  ) : null}
                  {item.indicator ? (
                    <span className="absolute right-4 top-4 rounded-lg bg-black/70 px-3 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur-md">
                      {item.indicator}
                    </span>
                  ) : null}
                </div>
                <div className="min-w-0 px-1 pt-3">
                  <p className="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold leading-tight text-[var(--loom-text)]" title={item.title}>
                    {item.title}
                  </p>
                  {item.subtitle ? <p className="mt-1 text-sm text-[var(--loom-muted)]">{item.subtitle}</p> : null}
                  {item.metadata ? <p className="mt-1 text-xs text-[var(--loom-faint)]">{item.metadata}</p> : null}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
