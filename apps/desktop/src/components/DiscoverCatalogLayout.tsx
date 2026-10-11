import type { ReactNode } from 'react';
import LibrarySearch from '@/components/LibrarySearch';
import StremioPosterCard from '@/components/StremioPosterCard';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import type { StremioPluginCatalogItem } from '@/lib/desktopApi';

export function DiscoverHeader({ title, description, scrolled, query, onQueryChange, children }: {
  title: string;
  description: string;
  scrolled: boolean;
  query?: string;
  onQueryChange?: (value: string) => void;
  children?: ReactNode;
}) {
  return (
    <header className={`loom-library-page-heading sticky top-0 z-40 isolate mb-6 flex min-h-8 shrink-0 flex-wrap items-start justify-between gap-4 border-b bg-[var(--loom-bg)] py-3 backdrop-blur-xl transition-[border-color,box-shadow] duration-150 ${scrolled ? 'border-[var(--loom-border)] shadow-[0_12px_24px_-22px_rgb(0_0_0_/_0.9)]' : 'border-transparent'}`}>
      <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-[var(--loom-text)]">{title}</h1>
          <p className="mt-1 text-sm text-[var(--loom-muted)]">{description}</p>
        </div>
        {query !== undefined && onQueryChange ? (
          <LibrarySearch value={query} onChange={onQueryChange} placeholder="Search titles" placement="inline" />
        ) : null}
      </div>
      {children}
    </header>
  );
}

export type DiscoverGridEntry = { id: string; item: StremioPluginCatalogItem; rank?: number };

export function DiscoverPosterGrid({ entries, metaLine, onSelect, onPlay, onPlayTrailer, playbackStatus }: {
  entries: DiscoverGridEntry[];
  metaLine: (item: StremioPluginCatalogItem) => string;
  onSelect: (item: StremioPluginCatalogItem) => void;
  onPlay?: (item: StremioPluginCatalogItem) => void;
  onPlayTrailer?: (item: StremioPluginCatalogItem) => void;
  playbackStatus?: (item: StremioPluginCatalogItem) => string | undefined;
}) {
  return (
    <VirtualPosterGrid
      items={entries}
      renderItem={({ item, rank }) => (
        <StremioPosterCard
          item={item}
          rank={rank}
          metaLine={metaLine(item)}
          showContentRating={false}
          onSelect={onSelect}
          onPlay={onPlay}
          playbackDisabled={Boolean(playbackStatus?.(item))}
          playbackLabel={playbackStatus?.(item) || 'Play'}
          onPlayTrailer={onPlayTrailer ? () => onPlayTrailer(item) : undefined}
        />
      )}
    />
  );
}

export function discoverFilterChipClass(active: boolean): string {
  return `h-8 shrink-0 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${active
    ? 'border border-[var(--loom-accent)] bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]'
    : 'border border-[var(--loom-border)] bg-[var(--loom-surface-2)] text-[var(--loom-text)] hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)]'}`;
}
