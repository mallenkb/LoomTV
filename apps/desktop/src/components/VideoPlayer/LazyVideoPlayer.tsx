import { lazy, Suspense, type ComponentProps } from 'react';

const VideoPlayer = lazy(() => import('../VideoPlayer'));

type LazyVideoPlayerProps = ComponentProps<typeof VideoPlayer>;

function PlayerLoadingFallback() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
      <p className="text-sm font-medium text-white/70" role="status" aria-live="polite">
        Preparing playback...
      </p>
    </div>
  );
}

export default function LazyVideoPlayer(props: LazyVideoPlayerProps) {
  return (
    <Suspense fallback={<PlayerLoadingFallback />}>
      <VideoPlayer {...props} />
    </Suspense>
  );
}
