import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type KeyboardEventHandler } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, CornerDownLeft, Info, KeyRound, Library, Palette, Play, Puzzle, Radio, Search, Users, Wifi } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { SettingsSection } from './Settings.helpers';
import { SETTINGS_GROUP_LABELS, SETTINGS_SECTION_LABELS, searchSettingsIndex, type SettingsSearchEntry } from './settingsSearchIndex';

const SECTION_ICONS: Record<SettingsSection, ComponentType<{ className?: string }>> = {
  library: Library,
  playback: Play,
  metadata: KeyRound,
  plugins: Puzzle,
  'live-tv': Radio,
  profiles: Users,
  network: Wifi,
  theme: Palette,
  about: Info,
};

/** Bolds the parts of a title that start with a query word. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((part, index) => {
        const word = words.find((candidate) => part.toLowerCase().startsWith(candidate));
        return word
          ? <span key={index}><mark className="bg-transparent font-semibold text-[var(--loom-text)]">{part.slice(0, word.length)}</mark>{part.slice(word.length)}</span>
          : <span key={index}>{part}</span>;
      })}
    </>
  );
}

type Item = { key: string; section: SettingsSection; title: string; trail: string[]; entry?: SettingsSearchEntry };

/** Command-palette search across every settings tab. */
export default function SettingsSearch({ open, onOpenChange, visibleSections, onSelect, onOpenSection }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  visibleSections: readonly SettingsSection[];
  onSelect: (entry: SettingsSearchEntry) => void;
  onOpenSection: (section: SettingsSection) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const visible = useMemo(() => new Set(visibleSections), [visibleSections]);
  const searching = query.trim().length > 0;

  // With no query the list is a jump list of pages; otherwise results grouped by page.
  const groups = useMemo(() => {
    if (!searching) {
      return [{ label: 'Pages', items: visibleSections.map<Item>((section) => ({ key: section, section, title: SETTINGS_SECTION_LABELS[section], trail: [] })) }];
    }
    const bySection = new Map<SettingsSection, Item[]>();
    for (const entry of searchSettingsIndex(query, visible)) {
      const items = bySection.get(entry.section) ?? [];
      items.push({ key: `${entry.section}:${entry.title}`, section: entry.section, title: entry.title, trail: [SETTINGS_SECTION_LABELS[entry.section], ...(entry.group ? [SETTINGS_GROUP_LABELS[entry.group] ?? 'Advanced'] : [])], entry });
      bySection.set(entry.section, items);
    }
    return [...bySection.entries()].map(([section, items]) => ({ label: SETTINGS_SECTION_LABELS[section], items }));
  }, [query, searching, visible, visibleSections]);
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onOpenChange(false);
    if (item.entry) onSelect(item.entry);
    else onOpenSection(item.section);
  };

  let index = -1;
  return (
    <SearchPaletteFrame open={open} onOpenChange={onOpenChange} title="Search settings" description="Type to find a setting, then press Return to open it." query={query} onQueryChange={setQuery}
      controls="settings-search-results" activeDescendant={items[active] ? `settings-search-${active}` : undefined}
onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((current) => Math.min(items.length - 1, current + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((current) => Math.max(0, current - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(items[active]);
              }
            }}>
        <div ref={listRef} id="settings-search-results" role="listbox" aria-label="Settings" className="max-h-[min(380px,55vh)] overflow-y-auto overscroll-contain p-1.5">
          {searching && items.length === 0 ? (
            <p role="status" className="px-2.5 py-5 text-center text-[13px] text-[var(--loom-muted)]">No settings match "{query.trim()}"</p>
          ) : groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-[var(--loom-faint)] first:pt-1">{group.label}</p>
              {group.items.map((item) => {
                index += 1;
                const itemIndex = index;
                const Icon = SECTION_ICONS[item.section];
                const selected = itemIndex === active;
                return (
                  <button
                    key={item.key}
                    id={`settings-search-${itemIndex}`}
                    data-index={itemIndex}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseMove={() => setActive(itemIndex)}
                    onClick={() => choose(item)}
                    className={cn('flex h-9 w-full items-center gap-2.5 !rounded-lg px-2.5 text-left text-[13px]', selected ? 'bg-[var(--loom-active-bg)]' : '')}
                  >
                    <Icon className={cn('h-4 w-4 shrink-0', selected ? 'text-[var(--loom-text)]' : 'text-[var(--loom-muted)]')} />
                    <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                      {item.trail.map((crumb) => (
                        <span key={crumb} className="flex shrink-0 items-center gap-1 text-[var(--loom-muted)]">
                          {crumb}
                          <ChevronRight className="h-3 w-3 text-[var(--loom-faint)]" aria-hidden="true" />
                        </span>
                      ))}
                      <span className="truncate text-[var(--loom-text)]"><Highlighted text={item.title} query={query} /></span>
                    </span>
                    {selected ? <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-[var(--loom-muted)]" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex h-9 items-center gap-3 border-t border-[color-mix(in_srgb,var(--loom-text)_8%,transparent)] px-3.5 text-[11px] text-[var(--loom-faint)]">
          <span className="flex items-center gap-1"><Kbd><ArrowUp className="h-3 w-3" /></Kbd><Kbd><ArrowDown className="h-3 w-3" /></Kbd>Navigate</span>
          <span className="flex items-center gap-1"><Kbd><CornerDownLeft className="h-3 w-3" /></Kbd>Open</span>
          <span className="flex items-center gap-1"><Kbd>esc</Kbd>Close</span>
          {searching ? <span className="ml-auto tabular-nums">{items.length} {items.length === 1 ? 'result' : 'results'}</span> : null}
        </div>
    </SearchPaletteFrame>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="grid h-[18px] min-w-[18px] place-items-center rounded border border-[color-mix(in_srgb,var(--loom-text)_10%,transparent)] px-1 font-sans text-[10px] text-[var(--loom-muted)]" aria-hidden="true">{children}</kbd>;
}

/** Shared search presentation for settings and catalog searches. */
export function SearchPaletteFrame({ open, onOpenChange, title, description, query, onQueryChange, onKeyDown, controls, activeDescendant, children, wide = false, popupRole }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string;
  query: string; onQueryChange: (query: string) => void; onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  controls: string; activeDescendant?: string; children: ReactNode; wide?: boolean; popupRole?: 'grid' | 'listbox';
}) {
  return <Dialog open={open} onOpenChange={onOpenChange} contentClassName={cn("loom-settings-search max-w-none overflow-hidden border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)] shadow-[0_24px_80px_rgba(0,0,0,0.55)]", wide ? "loom-title-search w-[min(1040px,calc(100vw-32px))]" : "w-[min(560px,calc(100vw-32px))]")}>
    <DialogContent>
      <DialogHeader className="sr-only"><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <div className="flex h-12 items-center gap-2.5 border-b border-[color-mix(in_srgb,var(--loom-text)_8%,transparent)] px-3.5">
        <Search className="h-4 w-4 shrink-0 text-[var(--loom-muted)]" aria-hidden="true" />
        <input type="search" value={query} onChange={event => onQueryChange(event.target.value)} onKeyDown={onKeyDown}
          placeholder={title} aria-label={title} aria-controls={controls} aria-activedescendant={activeDescendant}
          role={popupRole ? "combobox" : undefined} aria-haspopup={popupRole} aria-expanded={popupRole ? open : undefined} aria-autocomplete={popupRole ? "list" : undefined}
          className="h-full min-w-0 flex-1 !rounded-none !border-0 bg-transparent !p-0 text-[15px] text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)] [&::-webkit-search-cancel-button]:hidden" />
      </div>
      {children}
    </DialogContent>
  </Dialog>;
}
