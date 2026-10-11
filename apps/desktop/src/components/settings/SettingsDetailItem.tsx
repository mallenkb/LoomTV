import type { ReactNode } from 'react';

/** A title, its file or folder, and an optional explanation in an expanded list. */
export default function SettingsDetailItem({ title, detail, reason }: {
  title: ReactNode;
  detail?: ReactNode;
  reason?: ReactNode;
}) {
  return (
    <li className="min-w-0 py-3">
      <p className="break-words text-sm font-medium leading-5 text-[var(--loom-text)]">{title}</p>
      {detail ? <p className="mt-1 break-all font-mono text-[11px] leading-5 text-[var(--loom-faint)]">{detail}</p> : null}
      {reason ? <p className="mt-1.5 break-words text-xs leading-5 text-[var(--loom-muted)]">{reason}</p> : null}
    </li>
  );
}
