import { useState } from 'react';
import { Archive, Bookmark, ChevronDown, ChevronUp, Minus } from 'lucide-react';
import { DotsSixVertical } from '@phosphor-icons/react';
import { AnimeIcon, DiscoverIcon, FilmNavIcon, TVNavIcon } from '@/components/Sidebar';
import { FolderNavIcon } from '@/components/LoomIcons';
import { liveTvSourceIconPair } from '@/components/LiveTvSourceIcons';
import { addonSourceIconPair } from '@/components/AddonSourceIcons';
import { useAddonIcons } from '@/lib/addonIcons';
import { useAddonTitles } from '@/lib/addonTitles';
import { useIptvSources } from '@/lib/liveTvSources';
import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsRow, SettingsSwitch } from '@/components/settings/SettingsLayout';
import { cn } from '@/lib/utils';
import type { SettingsController } from './useSettingsController';

type SidebarController = Pick<SettingsController, 'sidebarOrderItems' | 'moveSidebarItem' | 'draggedSidebarItem' | 'setDraggedSidebarItem' | 'onSidebarOrderDrop' | 'hiddenSidebarItems' | 'setSidebarItemVisible' | 'isSavingSidebarVisibility'>;

export default function SidebarSettingsSection({ controller }: { controller: SidebarController }) {
  const order = controller.sidebarOrderItems;
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const { sources } = useIptvSources();
  const addonIcons = useAddonIcons();
  const addonTitles = useAddonTitles();
  const sidebarIcon = (id: string) => {
    if (id === 'anime') return AnimeIcon;
    if (id === 'tv') return TVNavIcon;
    if (id === 'movies') return FilmNavIcon;
    if (id === 'discover') return DiscoverIcon;
    if (id === 'my-list') return Bookmark;
    if (id === 'divider') return Minus;
    if (id.startsWith('live:')) return liveTvSourceIconPair(sources.find(source => `live:${source.id}` === id)?.iconId).outline;
    if (id.startsWith('stremio:')) {
      const addonId = id.slice('stremio:'.length);
      const selected = addonIcons[addonId];
      return selected && selected !== 'default' ? addonSourceIconPair(selected).outline : addonId === 'org.archive.clean' ? Archive : DiscoverIcon;
    }
    return FolderNavIcon;
  };

  return (
      <SettingsGroup title="Sidebar" description="Drag to reorder, or use the arrows. Visibility changes only affect the sidebar, not your folders or services.">
        {order.map((item, index) => {
          const hidden = controller.hiddenSidebarItems.includes(item.id);
          const Icon = sidebarIcon(item.id);
          const title = item.id.startsWith('stremio:') ? addonTitles[item.id.slice('stremio:'.length)] : undefined;
          return (
          <div key={item.id} data-sidebar-order-row className={cn('relative', controller.draggedSidebarItem === item.id && 'opacity-50')}
            onDragOver={event => {
              if (!controller.draggedSidebarItem || controller.draggedSidebarItem === item.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const bounds = event.currentTarget.getBoundingClientRect();
              const position = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
              setDropTarget(current => current?.id === item.id && current.position === position ? current : { id: item.id, position });
            }}
            onDrop={event => {
              if (!controller.draggedSidebarItem) return;
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              controller.onSidebarOrderDrop(item.id, event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after');
              setDropTarget(null);
            }}>
          {dropTarget?.id === item.id && controller.draggedSidebarItem && controller.draggedSidebarItem !== item.id ? <span aria-hidden="true" className={cn('pointer-events-none absolute inset-x-3 z-10 h-0.5 bg-[var(--loom-accent)]', dropTarget.position === 'before' ? 'top-0' : 'bottom-0')} /> : null}
          <SettingsRow className={cn('group min-h-[64px] gap-x-2.5 px-3 py-2.5 [&>div:first-child>div]:w-full', hidden && '[&>div:first-child]:opacity-40')} title={<span className="flex w-full min-w-0 items-center gap-2.5">
            <button type="button" draggable aria-label={`Drag ${item.label} to reorder`} title="Drag to reorder, or use the arrow keys"
              className="grid h-10 w-4 shrink-0 cursor-grab place-items-center rounded-md text-[var(--loom-faint)] opacity-60 transition-opacity hover:text-[var(--loom-text)] group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
              onKeyDown={event => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault(); event.stopPropagation();
                controller.moveSidebarItem(item.id, event.key === 'ArrowUp' ? -1 : 1);
              }}
              onDragStart={event => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.id);
                const row = event.currentTarget.closest<HTMLElement>('[data-sidebar-order-row]');
                if (row) {
                  const bounds = row.getBoundingClientRect();
                  event.dataTransfer.setDragImage(row, Math.max(0, event.clientX - bounds.left), Math.max(0, event.clientY - bounds.top));
                }
                controller.setDraggedSidebarItem(item.id);
              }}
              onDragEnd={() => { controller.setDraggedSidebarItem(null); setDropTarget(null); }}>
              <DotsSixVertical aria-hidden="true" weight="bold" className="h-4 w-4" />
            </button>
            {item.id === 'divider' ? <span className="flex min-w-0 flex-1 items-center gap-3 text-xs text-[var(--loom-muted)]">
              <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-[var(--loom-border)]" />
              <span className="shrink-0">Library divider{hidden ? ' · Hidden' : ''}</span>
              <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-[var(--loom-border)]" />
            </span> : <><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--loom-surface-3)] text-[var(--loom-muted)]"><Icon className="h-5 w-5" /></span><span>{title ? `${title} (Add-on)` : item.label}{hidden ? <span className="ml-2 text-xs font-normal text-[var(--loom-muted)]">Hidden</span> : null}</span></>}
          </span>}>
            <span className="flex items-center gap-1">
              <SettingsSwitch label={`Show ${item.label} in sidebar`} checked={!controller.hiddenSidebarItems.includes(item.id)}
                disabled={controller.isSavingSidebarVisibility} onChange={visible => { void controller.setSidebarItemVisible(item.id, visible); }} />
              <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={index === 0} aria-label={`Move ${item.label} up`} title="Move up" onClick={() => controller.moveSidebarItem(item.id, -1)}>
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={index === order.length - 1} aria-label={`Move ${item.label} down`} title="Move down" onClick={() => controller.moveSidebarItem(item.id, 1)}>
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </Button>
            </span>
          </SettingsRow>
          </div>
        ); })}
      </SettingsGroup>
  );
}
