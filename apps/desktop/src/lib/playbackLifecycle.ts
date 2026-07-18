type PlaybackShutdown = () => Promise<void>;

let shutdown: PlaybackShutdown | null = null;

export function registerPlaybackShutdown(handler: PlaybackShutdown): () => void {
  shutdown = handler;
  return () => {
    if (shutdown === handler) shutdown = null;
  };
}

export async function shutdownActivePlayback(): Promise<boolean> {
  if (!shutdown) return false;
  await shutdown();
  return true;
}
