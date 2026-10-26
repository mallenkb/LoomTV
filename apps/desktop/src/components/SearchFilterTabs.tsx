import { useSidebarNavOrder } from '@/lib/useSidebarNavOrder';
import { useId, type ReactNode } from 'react';
import { motion } from 'motion/react';

export default function SearchFilterTabs<T extends string>({ items, value, onChange, actions }: {
  items: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  actions?: ReactNode;
}) {
  const selectionId = useId();
  const navOrder = useSidebarNavOrder();
  const sidebarIds: Record<string, string> = { movie: 'movies', tv: 'tv', anime: 'anime' };
  const rank = (id: string) => id === 'all' ? -1 : navOrder.indexOf(sidebarIds[id] ?? id);
  const orderedItems = [...items].sort((a, b) => rank(a.value) - rank(b.value));
  return <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-[var(--loom-border)] px-5">
    <div role="group" aria-label="Filter search by type" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-2">
      {orderedItems.map(item => <button key={item.value} type="button" aria-pressed={value === item.value} onClick={() => onChange(item.value)}
        className={`relative inline-flex h-8 min-h-8 shrink-0 items-center justify-center rounded-full [--loom-modal-control-radius:9999px] px-3 text-xs font-semibold transition-colors sm:px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${value === item.value ? 'loom-modern-category-active' : 'loom-modern-category-idle'}`}>
        {value === item.value && <motion.span layoutId={selectionId} className="absolute inset-0 rounded-full bg-[var(--loom-text)]"
          transition={{ type: 'spring', stiffness: 520, damping: 42, mass: 0.7 }} aria-hidden="true" />}
        <span className="relative z-10">{item.label}</span>
      </button>)}
    </div>
    {actions && <div className="shrink-0">{actions}</div>}
  </div>;
}
