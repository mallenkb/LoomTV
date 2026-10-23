import { useId } from 'react';
import { Puzzle } from 'lucide-react';
import { ADDON_SOURCE_ICON_OPTIONS } from '@/components/AddonSourceIcons';
import type { AddonIconId } from '@/lib/addonIcons';

export default function AddonIconPicker({ value, onChange, disabled = false }: {
  value: AddonIconId;
  onChange: (value: AddonIconId) => void;
  disabled?: boolean;
}) {
  const name = useId();
  const options = [...ADDON_SOURCE_ICON_OPTIONS.filter(option => option.id !== 'miscellaneous'), { id: 'default' as const, label: 'Default', outline: Puzzle, solid: Puzzle }, ...ADDON_SOURCE_ICON_OPTIONS.filter(option => option.id === 'miscellaneous')];
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-2 text-sm font-medium text-[var(--loom-text)]">Sidebar icon</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(option => {
          const selected = option.id === value;
          const Icon = selected ? option.solid : option.outline;
          return (
            <label key={option.id} title={option.label} className={`grid h-10 w-10 cursor-pointer place-items-center rounded-xl border focus-within:ring-2 focus-within:ring-[var(--loom-accent)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 ${selected ? 'border-[var(--loom-accent)] bg-[var(--loom-surface-3)] text-[var(--loom-accent)]' : 'border-[var(--loom-border)] bg-[var(--loom-surface-2)] text-[var(--loom-muted)]'}`}>
              <input type="radio" name={name} value={option.id} checked={selected} onChange={() => onChange(option.id)} aria-label={option.label} className="sr-only" />
              <Icon className="h-7 w-7" aria-hidden="true" />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
