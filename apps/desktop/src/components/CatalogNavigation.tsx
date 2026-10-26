import { useSidebarNavOrder } from '@/lib/useSidebarNavOrder';
import { useId, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { motion } from 'motion/react';

/** Shared category pill and search entry point for provider catalogs. */
export default function CatalogNavigation<T extends string>({ label, items, value, onChange, searchOpen, onSearch, actions }: {
  label: string;
  items: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  searchOpen: boolean;
  onSearch: () => void;
  actions?: ReactNode;
}) {
  const selectionId = useId();
  const navOrder = useSidebarNavOrder();
  const sidebarIds: Record<string, string> = { movie: 'movies', tv: 'tv', anime: 'anime' };
  const rank = (id: string) => {
    if (id === 'all') return -1;
    const index = navOrder.indexOf(sidebarIds[id] ?? id);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const orderedItems = [...items].sort((a, b) => rank(a.value) - rank(b.value));
  return (
    <header className="loom-modern-header loom-no-drag pointer-events-none fixed inset-x-0 top-6 z-50 flex h-12 items-center justify-center px-5">
      <div className="pointer-events-auto flex max-w-full items-center gap-3">
        <nav aria-label={label} className="loom-modern-category-pill loom-no-drag flex h-12 max-w-full items-center rounded-full border p-1 backdrop-blur-xl">
          {orderedItems.map(item => (
            <button key={item.value} type="button" aria-pressed={value === item.value} onClick={() => onChange(item.value)}
              className={`relative inline-flex h-full items-center justify-center rounded-full px-3 text-xs font-semibold transition-colors sm:px-5 ${value === item.value ? 'loom-modern-category-active' : 'loom-modern-category-idle'}`}>
              {value === item.value ? <motion.span layoutId={selectionId} className="loom-modern-category-selection absolute inset-0 rounded-full" transition={{ type: 'spring', stiffness: 520, damping: 42, mass: 0.7 }} aria-hidden="true" /> : null}
              <span className="relative z-10">{item.label}</span>
            </button>
          ))}
        </nav>
        <button type="button" aria-label="Search titles" aria-expanded={searchOpen} onClick={onSearch}
          className="loom-modern-category-pill loom-modern-category-idle loom-no-drag grid h-12 w-12 shrink-0 place-items-center rounded-full border backdrop-blur-xl">
          <Search aria-hidden="true" className="h-4 w-4" />
        </button>
        {actions}
      </div>
    </header>
  );
}
