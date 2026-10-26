import type { KeyboardEventHandler, ReactNode, Ref } from 'react';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** Shared floating search surface for local content, catalogs, and settings. */
export function SearchPaletteFrame({ open, onOpenChange, title, description, query, onQueryChange, onKeyDown, controls, activeDescendant, children, wide = false, popupRole, inputRef }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string;
  query: string; onQueryChange: (query: string) => void; onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  controls: string; activeDescendant?: string; children: ReactNode; wide?: boolean; popupRole?: 'grid' | 'listbox';
  inputRef?: Ref<HTMLInputElement>;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange} contentClassName={cn('loom-search-surface loom-settings-search max-w-none overflow-visible border-[var(--loom-panel-border)] text-[var(--loom-text)]', wide ? 'loom-title-search w-[min(1040px,calc(100vw-32px))]' : 'w-[min(560px,calc(100vw-32px))]')}>
    <DialogContent className="flex max-h-[80dvh] min-h-0 flex-col">
      <DialogHeader className="sr-only"><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-[color-mix(in_srgb,var(--loom-text)_8%,transparent)] px-3.5">
        <Search className="h-4 w-4 shrink-0 text-[var(--loom-muted)]" aria-hidden="true" />
        <input ref={inputRef} type="search" value={query} onChange={event => onQueryChange(event.target.value)} onKeyDown={onKeyDown}
          placeholder={title} aria-label={title} aria-controls={controls} aria-activedescendant={activeDescendant}
          autoComplete="off"
          role={popupRole ? 'combobox' : undefined} aria-haspopup={popupRole} aria-expanded={popupRole ? open : undefined} aria-autocomplete={popupRole ? 'list' : undefined}
          className="h-full min-w-0 flex-1 !rounded-none !border-0 bg-transparent !p-0 text-[15px] text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)] [&::-webkit-search-cancel-button]:hidden" />
      </div>
      {children}
    </DialogContent>
  </Dialog>;
}
