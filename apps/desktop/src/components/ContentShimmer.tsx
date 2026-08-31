import { cn } from '@/lib/utils';

function ShimmerBlock({ className }: { className: string }) {
  return (
    <div className={cn('relative overflow-hidden bg-[var(--loom-surface)]', className)} aria-hidden="true">
      <span className="loom-content-shimmer pointer-events-none absolute inset-0 block" />
    </div>
  );
}

export function PosterGridShimmer({
  count = 18,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cn('grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6', className)}
      role="status"
      aria-label="Loading titles"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="block w-full min-w-0">
          <ShimmerBlock className="aspect-[2/3] rounded-lg" />
          <div className="mt-2 space-y-2">
            <ShimmerBlock className="h-4 w-4/5" />
            <ShimmerBlock className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function LandscapeGridShimmer({ count = 12 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-x-4 gap-y-7"
      role="status"
      aria-label="Loading content"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="min-w-0">
          <ShimmerBlock className="aspect-[16/10] rounded-2xl" />
          <div className="px-1 pt-3">
            <ShimmerBlock className="h-4 w-4/5" />
            <ShimmerBlock className="mt-2 h-3 w-2/5" />
            <ShimmerBlock className="mt-2 h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChannelGridShimmer({ count = 12 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3"
      role="status"
      aria-label="Loading channels"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-xl border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-3">
          <div className="flex items-center gap-3">
            <ShimmerBlock className="h-12 w-12 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1">
              <ShimmerBlock className="h-4 w-4/5" />
              <ShimmerBlock className="mt-2 h-3 w-1/2" />
            </div>
          </div>
          <ShimmerBlock className="mt-3 h-3 w-3/4" />
          <ShimmerBlock className="mt-2 h-1 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}
