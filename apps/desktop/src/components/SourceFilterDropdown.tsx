import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useModalLayer } from '@/components/ui/dialog';

type Option = { value: string; label: string; icon?: ReactNode; disabled?: boolean };

/** Shared single- and multi-select controls for the source picker. */
export default function SourceFilterDropdown({ label, valueLabel, selected, options, onSelect, multiple = false, disabled = false, actions = false }: {
  label: string;
  valueLabel: string;
  selected: readonly string[];
  options: readonly Option[];
  onSelect: (value: string) => void;
  multiple?: boolean;
  disabled?: boolean;
  actions?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [bounds, setBounds] = useState({ left: 0, top: 0, width: 220, maxHeight: 280 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  useModalLayer({ open, contentRef: layerRef, initialFocusRef: selectedRef, onEscape: () => setOpen(false) });

  const positionMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dialog = triggerRef.current?.closest('[role="dialog"]')?.getBoundingClientRect();
    const leftEdge = Math.max(8, (dialog?.left ?? 0) + 8);
    const rightEdge = Math.min(window.innerWidth - 8, (dialog?.right ?? window.innerWidth) - 8);
    const topEdge = Math.max(8, (dialog?.top ?? 0) + 8);
    const bottomEdge = Math.min(window.innerHeight - 8, (dialog?.bottom ?? window.innerHeight) - 8);
    const width = Math.max(0, Math.min(Math.max(rect.width, 240), rightEdge - leftEdge));
    const below = Math.max(0, bottomEdge - rect.bottom - 6);
    const above = Math.max(0, rect.top - topEdge - 6);
    const upwards = below < 200 && above > below;
    const maxHeight = Math.min(280, upwards ? above : below);
    setBounds({ width, maxHeight, left: Math.max(leftEdge, Math.min(rect.left, rightEdge - width)),
      top: Math.max(topEdge, Math.min(upwards ? rect.top - maxHeight - 6 : rect.bottom + 6, bottomEdge - maxHeight)) });
  };
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    return () => {
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return <div className="min-w-0 space-y-1.5">
    {!actions ? <label htmlFor={id} className="block text-xs text-[var(--loom-muted)]">{label}</label> : null}
    <button ref={triggerRef} id={id} type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? `${id}-menu` : undefined} aria-label={actions ? label : undefined} title={valueLabel}
      onClick={() => { positionMenu(); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); positionMenu(); setOpen(true);
        }
      }}
      className={`${actions ? 'grid h-10 w-10 place-items-center rounded-full' : 'flex h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3'} text-left text-sm text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-active-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] disabled:opacity-50`}>
      {actions ? <MoreHorizontal aria-hidden="true" className="h-5 w-5" /> : <><span className="min-w-0 flex-1 truncate">{valueLabel}</span>
      <ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 text-[var(--loom-muted)] transition-transform ${open ? 'rotate-180' : ''}`} /></>}
    </button>
    {open ? createPortal(<div ref={layerRef} className="fixed inset-0 z-[10000]" onPointerDown={event => {
      if (event.target === event.currentTarget) setOpen(false);
    }}>
      <div ref={menuRef} id={`${id}-menu`} role="menu" aria-label={label} style={bounds}
        className="fixed overflow-y-auto overscroll-contain rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-1 text-[var(--loom-text)] shadow-xl"
        onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || [])];
          if (!buttons.length) return;
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}>
        {options.map(option => {
          const checked = selected.includes(option.value);
          return <button key={option.value} ref={option.value === selected[0] ? selectedRef : undefined}
            type="button" disabled={option.disabled} role={actions ? 'menuitem' : multiple ? 'menuitemcheckbox' : 'menuitemradio'} aria-checked={actions ? undefined : checked}
            onClick={() => { onSelect(option.value); if (!multiple) setOpen(false); }}
            className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm outline-none hover:bg-[var(--loom-active-bg)] focus-visible:bg-[var(--loom-active-bg)] disabled:opacity-40 ${checked ? 'bg-[var(--loom-surface-3)] text-[var(--loom-text)]' : 'text-[var(--loom-muted)]'}`}>
            {option.icon}
            <span className="min-w-0 flex-1">{option.label}</span>
            {!actions ? <span className="grid h-4 w-4 shrink-0 place-items-center text-[var(--loom-accent)]">{checked ? <Check aria-hidden="true" className="h-4 w-4" /> : null}</span> : null}
          </button>;
        })}
      </div>
    </div>, document.body) : null}
  </div>;
}
