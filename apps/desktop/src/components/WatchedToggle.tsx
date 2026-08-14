import { useToast } from '@/components/ToastProvider';

interface WatchedToggleProps {
  watched: boolean;
  onToggle: () => void;
  className?: string;
  iconClassName?: string;
  size?: 'default' | 'compact';
  label?: string;
  surface?: 'default' | 'plain';
}

export default function WatchedToggle({
  watched,
  onToggle,
  className = '',
  iconClassName = 'h-6 w-6',
  size = 'default',
  label,
  surface = 'default',
}: WatchedToggleProps) {
  const { showToast } = useToast();
  const accessibleLabel = label || (watched ? 'Mark as unwatched' : 'Mark as watched');
  const surfaceClassName = surface === 'plain' ? '' : 'bg-black/60 backdrop-blur-md';
  const defaultHoverClassName = surface === 'plain' || watched ? '' : 'hover:bg-black/80';
  const sizeClassName = size === 'compact' ? 'h-7 w-7' : 'h-9 w-9';
  return (
    <button
      type="button"
      aria-label={accessibleLabel}
      aria-pressed={watched}
      title={accessibleLabel}
      onClick={(event) => {
        event.stopPropagation();
        const willBeWatched = !watched;
        onToggle();
        showToast({
          title: willBeWatched ? 'Marked as watched' : 'Marked as unwatched',
          tone: willBeWatched ? 'success' : 'info',
          durationMs: 2800,
          variant: 'confirmation',
        });
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={`grid ${sizeClassName} shrink-0 place-items-center rounded-full text-white transition-colors ${surfaceClassName} ${defaultHoverClassName} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${className}`}
    >
      {watched ? (
        <svg aria-hidden="true" className={iconClassName} viewBox="0 0 24 24" fill="currentColor">
          <path d="M0 0h24v24H0z" fill="none" />
          <path d="m23.5 17l-5 5l-3.5-3.5l1.5-1.5l2 2l3.5-3.5z" fill="#22c55e" />
          <path d="M12 9a3 3 0 0 1 3 3a3 3 0 0 1-3 3a3 3 0 0 1-3-3a3 3 0 0 1 3-3m0 8c.5 0 .97-.07 1.42-.21c-.27.71-.42 1.43-.42 2.21v.45l-1 .05c-5 0-9.27-3.11-11-7.5c1.73-4.39 6-7.5 11-7.5s9.27 3.11 11 7.5c-.25.64-.56 1.26-.92 1.85c-.9-.54-1.96-.85-3.08-.85c-.78 0-1.5.15-2.21.42c.14-.45.21-.92.21-1.42a5 5 0 0 0-5-5a5 5 0 0 0-5 5a5 5 0 0 0 5 5" />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          className={iconClassName}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </button>
  );
}
