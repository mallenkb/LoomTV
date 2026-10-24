import type { ReactNode } from 'react';

export default function DiscoverFilterPanel({ id, fields, activeCount, onReset }: {
  id: string;
  fields: readonly { label: string; control: ReactNode }[];
  activeCount: number;
  onReset: () => void;
}) {
  return (
    <section id={id} aria-label="Discover filters" className="mb-5 flex flex-wrap items-end gap-3">
        {fields.map(field => <div key={field.label} className="min-w-[8rem] flex-1 sm:w-40 sm:flex-none">
          {field.control}
        </div>)}
        {activeCount > 0 ? <button type="button" onClick={onReset} className="h-8 px-2 text-xs text-[var(--loom-muted)] hover:text-[var(--loom-text)]">Reset filters</button> : null}
    </section>
  );
}
