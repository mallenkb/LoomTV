import { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal, Power, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AddonManagementMenu({ disabled, onDisable, onRemove }: {
  disabled: boolean;
  onDisable?: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    trigger.current?.focus();
    action();
  };
  const itemClass = 'flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm outline-none hover:bg-[var(--loom-surface-3)] focus:bg-[var(--loom-surface-3)]';
  return (
    <div ref={root} className="relative" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }} onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation();
        setOpen(false); trigger.current?.focus();
      }
    }}>
      <Button ref={trigger} type="button" size="icon" variant="ghost" disabled={disabled} aria-label="More add-on actions" title="More actions"
        aria-haspopup="menu" aria-expanded={open && !disabled} aria-controls={open ? id : undefined}
        onClick={() => setOpen(value => !value)} onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
        }} className="h-9 w-9">
        <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
      </Button>
      {open && !disabled ? (
        <div ref={menu} id={id} role="menu" aria-label="More add-on actions"
          className="absolute bottom-full left-0 z-50 mb-2 w-44 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-1 text-[var(--loom-text)] shadow-xl"
          onKeyDown={event => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: number;
            if (event.key === 'ArrowDown') next = (current + 1) % items.length;
            else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            else return;
            event.preventDefault(); items[next]?.focus();
          }}>
          {onDisable ? <button type="button" role="menuitem" onClick={() => choose(onDisable)} className={itemClass}>
            <Power aria-hidden="true" className="h-4 w-4" />Disable
          </button> : null}
          <button type="button" role="menuitem" onClick={() => choose(onRemove)} className={`${itemClass} text-red-400`}>
            <Trash2 aria-hidden="true" className="h-4 w-4" />Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}
