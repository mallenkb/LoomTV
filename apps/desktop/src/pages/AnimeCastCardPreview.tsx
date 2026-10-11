import { UserRound } from 'lucide-react';
import type { AppCastCardStyle } from '@/lib/theme';

function PreviewAvatar({ initials, actor = false }: { initials?: string; actor?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${actor ? 'bg-[var(--loom-season-episodes-veil)] text-[var(--loom-muted)]' : 'bg-[var(--loom-season-accordion-bg)] text-[var(--loom-text)]'}`}
    >
      {actor ? <UserRound className="h-4 w-4" /> : <span className="text-[10px] font-semibold">{initials}</span>}
    </span>
  );
}

export default function AnimeCastCardPreview({ layout }: { layout: AppCastCardStyle }) {
  const standard = layout === 'standard';

  return (
    <div
      aria-label={`${standard ? 'Standard' : 'Compact'} anime cast card preview`}
      className="mt-1 w-full max-w-[280px] min-w-0"
      role="img"
    >
      {standard ? (
        <div className="overflow-hidden rounded-[12px] border border-white/5 bg-[var(--loom-season-accordion-bg)]">
          <div className="px-2.5 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <PreviewAvatar initials="MA" />
              <div className="min-w-0">
                <p className="break-words text-[12px] font-semibold leading-4 text-[var(--loom-text)]">Mikasa Ackerman</p>
                <p className="text-[10px] leading-3 text-[var(--loom-muted)]">Character</p>
              </div>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2.5 bg-[var(--loom-season-episodes-veil)] px-2.5 py-3">
            <PreviewAvatar actor />
            <div className="min-w-0">
              <p className="break-words text-[12px] font-medium leading-4 text-[var(--loom-text)]">Yui Ishikawa</p>
              <p className="text-[10px] font-semibold leading-3 text-[var(--loom-muted)]">Voice actor</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-[68px] items-center overflow-hidden rounded-[12px] border border-white/5 bg-[var(--loom-season-accordion-bg)] p-2">
          <div className="grid w-full min-w-0 grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-2">
            <PreviewAvatar initials="MA" />
            <div className="min-w-0">
              <p className="break-words text-[12px] font-semibold leading-4 text-[var(--loom-text)]">Mikasa Ackerman</p>
              <p className="text-[10px] leading-3 text-[var(--loom-muted)]">Character</p>
              <p className="break-words text-[10px] leading-3 text-[var(--loom-muted)]">(Yui Ishikawa)</p>
            </div>
            <PreviewAvatar actor />
          </div>
        </div>
      )}
    </div>
  );
}
