import { createContext, useContext, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { CaretDown } from '@phosphor-icons/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Settings layout primitives. A page is a header and a stack of groups. A
 * group is a small heading above one bordered list, and everything inside it
 * is a row separated by a hairline. Rows never wrap another bordered box.
 *
 * Expandable content has two levels:
 * - A collapsible group hides a whole group behind its heading (Advanced).
 * - A disclosure is a row that opens in place. Its panel is inset and drawn
 *   on a sunken surface with a guide line, and a disclosure inside another
 *   one renders smaller, so each level reads as a child of the one above.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

/** Text of a title, used to find a setting from search. */
function titleText(title: ReactNode): string | undefined {
  return typeof title === 'string' ? title : undefined;
}

/** Names the page for screen readers. The tab bar already shows it on screen. */
export function SettingsPageHeader({ title }: { title: string; description?: ReactNode }) {
  return <h1 className="sr-only">{title}</h1>;
}

type SettingsGroupProps = {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Hide the group's rows behind its heading until opened. */
  collapsible?: boolean;
  /** Remembers a collapsible group's open state across visits. */
  storageKey?: string;
  defaultOpen?: boolean;
};

export const SETTINGS_OPEN_GROUP_EVENT = 'loomtv:settings-open-group';

/** Opens a collapsible group now and on its next visit. */
export function openSettingsGroup(storageKey: string) {
  try { localStorage.setItem(`loomtv:settings-open:${storageKey}`, '1'); } catch { /* Storage is optional. */ }
  window.dispatchEvent(new CustomEvent(SETTINGS_OPEN_GROUP_EVENT, { detail: storageKey }));
}

function readStoredOpen(storageKey: string | undefined, fallback: boolean): boolean {
  if (!storageKey) return fallback;
  try {
    const saved = localStorage.getItem(`loomtv:settings-open:${storageKey}`);
    return saved === null ? fallback : saved === '1';
  } catch {
    return fallback;
  }
}

export function SettingsGroup({ title, description, action, children, className, collapsible = false, storageKey, defaultOpen = false }: SettingsGroupProps) {
  const [open, setOpen] = useState(() => readStoredOpen(storageKey, defaultOpen));
  const panelId = useId();
  const reduceMotion = useReducedMotion();
  // Settings search opens the group that holds the setting it jumps to.
  useEffect(() => {
    if (!storageKey) return undefined;
    const openFromSearch = (event: Event) => {
      if ((event as CustomEvent<string>).detail === storageKey) setOpen(true);
    };
    window.addEventListener(SETTINGS_OPEN_GROUP_EVENT, openFromSearch);
    return () => window.removeEventListener(SETTINGS_OPEN_GROUP_EVENT, openFromSearch);
  }, [storageKey]);
  const toggle = () => {
    setOpen((current) => {
      if (storageKey) {
        try { localStorage.setItem(`loomtv:settings-open:${storageKey}`, current ? '0' : '1'); } catch { /* Storage is optional. */ }
      }
      return !current;
    });
  };

  const list = (
    <div className="settings-group divide-y divide-[var(--loom-settings-divider)] overflow-hidden rounded-xl">
      {children}
    </div>
  );

  if (collapsible) {
    return (
      <section className={cn('settings-group-section', className)} data-settings-title={titleText(title)} data-open={open || undefined}>
        <div className="mb-2 flex min-h-9 items-center justify-between gap-3">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={toggle}
            className="settings-group-toggle group -mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--loom-active-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-[var(--loom-muted)] transition-transform duration-200', open && 'rotate-90 text-[var(--loom-text)]')} aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold uppercase tracking-[0.08em] text-[var(--loom-muted)] group-hover:text-[var(--loom-text)]">{title}</span>
              {description && !open ? <span className="mt-0.5 block text-xs normal-case tracking-normal text-[var(--loom-faint)]">{description}</span> : null}
            </span>
          </button>
          {action && open ? <div className="settings-group-action flex min-h-9 shrink-0 items-center gap-2">{action}</div> : null}
        </div>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              id={panelId}
              key="group"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="overflow-hidden"
            >
              {description ? <p className="mb-2 px-1 text-xs text-[var(--loom-faint)]">{description}</p> : null}
              {list}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </section>
    );
  }

  return (
    <section className={cn('settings-group-section', className)} data-settings-title={titleText(title)}>
      {title || action ? (
        <div className="mb-2 flex min-h-9 items-center justify-between gap-3 px-1">
          <div className="min-w-0">
            {title ? <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--loom-muted)]">{title}</h2> : null}
            {description ? <p className="mt-1 text-xs text-[var(--loom-faint)]">{description}</p> : null}
          </div>
          {action ? <div className="settings-group-action flex min-h-9 shrink-0 items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      {list}
    </section>
  );
}

type SettingsRowProps = {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  /** Put the control under the label instead of beside it, for wide inputs and lists. */
  stacked?: boolean;
  tone?: 'default' | 'danger';
  className?: string;
};

export function SettingsRow({ title, description, icon, children, stacked = false, tone = 'default', className }: SettingsRowProps) {
  const depth = useContext(DisclosureDepth);
  return (
    <div
      data-settings-title={titleText(title)}
      className={cn(
        'settings-row',
        depth > 0 ? 'py-3' : 'min-h-[60px] px-4 py-3.5',
        stacked ? 'space-y-3' : 'flex flex-wrap items-center justify-between gap-x-4 gap-y-3',
        className,
      )}
    >
      <div className={cn('flex min-w-0 items-center gap-3', !stacked && 'flex-1 basis-64')}>
        {icon ? <span className="shrink-0 text-[var(--loom-muted)]">{icon}</span> : null}
        <div className="min-w-0">
          <div className={cn('text-sm font-medium', tone === 'danger' ? 'settings-status-error' : 'text-[var(--loom-text)]')}>{title}</div>
          {description ? <div className="mt-0.5 text-xs leading-5 text-[var(--loom-muted)]">{description}</div> : null}
        </div>
      </div>
      {children ? <div className={cn(stacked ? 'min-w-0' : 'flex shrink-0 flex-wrap items-center justify-end gap-2')}>{children}</div> : null}
    </div>
  );
}

/** Plain text row for status lines, notes, and empty states inside a group. */
export function SettingsNote({ children, tone = 'muted', role }: { children: ReactNode; tone?: 'muted' | 'error' | 'warning' | 'ok'; role?: 'status' | 'alert' }) {
  const depth = useContext(DisclosureDepth);
  return (
    <div
      role={role}
      className={cn(
        'settings-row text-xs leading-5',
        depth > 0 ? 'py-2.5' : 'px-4 py-3',
        tone === 'error' ? 'settings-status-error' : tone === 'warning' ? 'settings-status-warning' : tone === 'ok' ? 'settings-status-available' : 'text-[var(--loom-muted)]',
      )}
    >
      {children}
    </div>
  );
}

/** A right-aligned row of buttons that ends a group. */
export function SettingsActions({ children, start }: { children: ReactNode; start?: ReactNode }) {
  return (
    <div className="settings-row flex flex-wrap items-center justify-between gap-2 bg-[var(--loom-settings-sunk)] px-4 py-3">
      <div className="min-w-0 text-xs text-[var(--loom-muted)]">{start}</div>
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

/** Count or state pill shown beside a title or chevron. */
export function SettingsBadge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warning' | 'error' | 'ok' | 'accent' }) {
  return (
    <span
      className={cn(
        'settings-badge inline-flex h-5 min-w-5 items-center justify-center whitespace-nowrap rounded-full px-2 text-[11px] font-semibold tabular-nums',
        tone === 'warning' && 'settings-badge-warning',
        tone === 'error' && 'settings-badge-error',
        tone === 'ok' && 'settings-badge-ok',
        tone === 'accent' && 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]',
        tone === 'muted' && 'bg-[var(--loom-surface-3)] text-[var(--loom-muted)]',
      )}
    >
      {children}
    </span>
  );
}

const DisclosureDepth = createContext(0);

type AccordionState = { openId: string | null; setOpenId: (id: string | null) => void };
const AccordionContext = createContext<AccordionState | null>(null);

/**
 * Only one accordion inside a scope is open at a time. A page is one scope,
 * and each open disclosure starts a new scope for the accordions inside it.
 */
export function SettingsAccordionScope({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return <AccordionContext.Provider value={{ openId, setOpenId }}>{children}</AccordionContext.Provider>;
}

/** The open accordion in the nearest scope, or local state outside any scope. */
export function useSettingsAccordion(): AccordionState {
  const scope = useContext(AccordionContext);
  const [openId, setOpenId] = useState<string | null>(null);
  return scope ?? { openId, setOpenId };
}


type SettingsDisclosureProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Short value shown beside the chevron, such as a count. Numbers render as a badge. */
  summary?: ReactNode;
  summaryTone?: 'muted' | 'warning' | 'error' | 'ok';
  icon?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Controls next to the chevron that should not toggle the row. */
  actions?: ReactNode;
};

/** A row that expands in place. Used for history, issue lists, and long lists. */
export function SettingsDisclosure({ title, description, summary, summaryTone = 'muted', icon, children, defaultOpen = false, onOpenChange, actions }: SettingsDisclosureProps) {
  const accordion = useSettingsAccordion();
  const panelId = useId();
  const [openedByDefault, setOpenedByDefault] = useState(defaultOpen);
  const open = accordion.openId === panelId || (openedByDefault && accordion.openId === null);
  const depth = useContext(DisclosureDepth);
  const nested = depth > 0;
  const reduceMotion = useReducedMotion();
  const toggle = () => {
    setOpenedByDefault(false);
    accordion.setOpenId(open ? null : panelId);
    onOpenChange?.(!open);
  };
  // Tell the owner when another accordion closes this one.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) onOpenChange?.(false);
    wasOpen.current = open;
  }, [onOpenChange, open]);
  const summaryNode = summary === undefined || summary === null || summary === false
    ? null
    : typeof summary === 'number' || typeof summary === 'string'
      ? <SettingsBadge tone={summaryTone}>{typeof summary === 'number' ? summary.toLocaleString() : summary}</SettingsBadge>
      : summary;

  return (
    <div className={cn('settings-row settings-disclosure', nested && 'settings-disclosure-nested')} data-open={open || undefined} data-settings-title={titleText(title)}>
      {/* The whole header toggles; buttons in `actions` keep their own clicks. */}
      <div
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('[data-disclosure-actions]')) return;
          toggle();
        }}
        className={cn(
          'settings-disclosure-header settings-row-button flex cursor-pointer items-center transition-colors',
          nested ? 'gap-2 rounded-lg px-2 py-2' : 'min-h-[60px] gap-3 px-4 py-3.5',
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--loom-settings-card-bg)]"
        >
          {icon ? <span className="shrink-0 text-[var(--loom-muted)]">{icon}</span> : null}
          <span className="min-w-0 flex-1">
            <span className={cn('block font-medium text-[var(--loom-text)]', nested ? 'text-[13px]' : 'text-sm')}>{title}</span>
            {description ? <span className="mt-0.5 block text-xs leading-5 text-[var(--loom-muted)]">{description}</span> : null}
          </span>
        </button>
        {summaryNode ? <span className="shrink-0">{summaryNode}</span> : null}
        {actions ? <div data-disclosure-actions className="flex shrink-0 cursor-default items-center gap-1.5">{actions}</div> : null}
        <ChevronRight
          className={cn('settings-disclosure-chevron h-4 w-4 shrink-0 text-[var(--loom-muted)] transition-transform duration-200', open && 'rotate-90')}
          aria-hidden="true"
        />
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={panelId}
            role="region"
            aria-label={titleText(title)}
            key="panel"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="overflow-hidden"
          >
            <div className={cn('settings-disclosure-panel', nested ? 'px-2 pb-2' : 'px-4 pb-3')}>
              <div className={cn('settings-disclosure-body', icon && !nested && 'pl-12')}>
                <DisclosureDepth.Provider value={depth + 1}>
                  <SettingsAccordionScope>{children}</SettingsAccordionScope>
                </DisclosureDepth.Provider>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** A list of entries inside a disclosure, split by hairlines. */
export function SettingsList({ children, label, maxHeight = 'max-h-72' }: { children: ReactNode; label?: string; maxHeight?: string }) {
  return (
    <ul aria-label={label} className={cn('divide-y divide-[var(--loom-settings-divider)] overflow-y-auto overscroll-contain', maxHeight)}>
      {children}
    </ul>
  );
}

type SettingsSwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
};

export function SettingsSwitch({ checked, onChange, label, disabled = false }: SettingsSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'settings-switch relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--loom-settings-card-bg)] disabled:opacity-50',
        checked ? 'bg-[var(--loom-accent)]' : 'bg-[var(--loom-surface-3)]',
      )}
    >
      <span className={cn('absolute left-0 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

type SettingsSelectProps<T extends string | number> = {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
};

export function SettingsSelect<T extends string | number>({ value, options, onChange, label, disabled = false, className }: SettingsSelectProps<T>) {
  return (
    <span className={cn('relative block w-44 shrink-0', className)}>
      <select
        value={String(value)}
        onChange={(event) => {
          const next = options.find((option) => String(option.value) === event.target.value);
          if (next) onChange(next.value);
        }}
        disabled={disabled}
        aria-label={label}
        className="h-9 w-full cursor-pointer appearance-none rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] py-1.5 pl-3 pr-9 text-sm text-[var(--loom-text)] outline-none transition-colors hover:bg-[var(--loom-surface-3)] focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] disabled:cursor-default disabled:opacity-50"
      >
        {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
      </select>
      <CaretDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)]" weight="regular" aria-hidden="true" />
    </span>
  );
}

type SegmentedOption<T extends string> = { value: T; label: ReactNode };

export function SettingsSegmented<T extends string>({ value, options, onChange, label, disabled = false }: { value: T; options: ReadonlyArray<SegmentedOption<T>>; onChange: (value: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="settings-segmented inline-flex rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] p-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => { if (!selected) onChange(option.value); }}
            className={cn(
              'h-[30px] rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] disabled:opacity-50',
              selected ? 'bg-[var(--loom-active-bg)] text-[var(--loom-active-text)] shadow-sm' : 'text-[var(--loom-muted)] hover:text-[var(--loom-text)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labeled text input for forms inside settings. */
export function SettingsField({ label, hint, className, inputClassName, mono = false, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & { label: string; hint?: ReactNode; className?: string; inputClassName?: string; mono?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn('block min-w-0', className)}>
      <span className="mb-1.5 block text-xs font-medium text-[var(--loom-muted)]">{label}</span>
      <input
        id={id}
        spellCheck={false}
        {...props}
        className={cn(
          'h-9 w-full min-w-0 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)] disabled:opacity-50',
          mono && 'font-mono text-xs',
          inputClassName,
        )}
      />
      {hint ? <span className="mt-1 block text-[11px] leading-4 text-[var(--loom-faint)]">{hint}</span> : null}
    </label>
  );
}

/** Status for a row's right side, drawn as a badge so every status looks the same. */
export function SettingsStatus({ tone, children }: { tone: 'ok' | 'warning' | 'error' | 'muted'; children: ReactNode }) {
  return <SettingsBadge tone={tone}>{children}</SettingsBadge>;
}
