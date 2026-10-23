import { cn } from '@/lib/utils';

export function ShimmerBlock({ className }: { className: string }) {
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

export function SourceListShimmer({ count = 4 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading sources" className="space-y-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="grid grid-cols-[112px_minmax(0,1fr)] gap-4 px-3 py-4" aria-hidden="true">
          <div className="space-y-2">
            <ShimmerBlock className="h-4 w-20 rounded bg-[var(--loom-surface-2)]" />
            <ShimmerBlock className="h-4 w-14 rounded bg-[var(--loom-surface-2)]" />
          </div>
          <div className="space-y-2">
            <ShimmerBlock className="h-4 w-full rounded bg-[var(--loom-surface-2)]" />
            <ShimmerBlock className="h-3 w-2/3 rounded bg-[var(--loom-surface-2)]" />
            <ShimmerBlock className="h-3 w-1/3 rounded bg-[var(--loom-surface-2)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PosterRailShimmer() {
  return <div role="status" aria-label="Loading titles" className="flex gap-6 overflow-hidden">
    {Array.from({ length: 8 }, (_, index) => <div key={index} className="w-40 shrink-0 sm:w-44"><ShimmerBlock className="aspect-[2/3] rounded-lg" /><ShimmerBlock className="mt-2 h-4 w-4/5 rounded" /><ShimmerBlock className="mt-2 h-3 w-1/2 rounded" /></div>)}
  </div>;
}

export function MetadataShimmer() {
  return <div role="status" aria-label="Loading title details" className="mb-8 space-y-3">
    <ShimmerBlock className="h-5 w-28 rounded" />
    <ShimmerBlock className="h-4 w-full rounded" />
    <ShimmerBlock className="h-4 w-5/6 rounded" />
    <ShimmerBlock className="h-4 w-2/3 rounded" />
  </div>;
}
