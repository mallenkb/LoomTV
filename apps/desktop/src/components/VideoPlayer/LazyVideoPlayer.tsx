import { lazy, Suspense, type ComponentProps } from 'react';

const loadVideoPlayer = () => import('../VideoPlayer');
const VideoPlayer = lazy(loadVideoPlayer);

// Parse the player while the library screen is idle so clicking Play does not
// have to download and evaluate the largest renderer chunk first.
if (typeof window !== 'undefined') {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(() => { void loadVideoPlayer(); }, { timeout: 1_500 });
  } else {
    globalThis.setTimeout(() => { void loadVideoPlayer(); }, 0);
  }
}

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
