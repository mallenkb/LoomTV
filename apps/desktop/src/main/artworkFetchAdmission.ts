// Normal and plugin artwork share the same fetch and decode capacity. A queued
// task holds its URL and callback, never downloaded image bytes.
const MAX_ACTIVE_ARTWORK_FETCHES = 4;
const MAX_QUEUED_ARTWORK_FETCHES = 32;

let activeArtworkFetches = 0;
const waitingArtworkFetches: Array<() => void> = [];

export function runBoundedArtworkFetch<T>(task: () => Promise<T>): Promise<T | null> {
  if (activeArtworkFetches >= MAX_ACTIVE_ARTWORK_FETCHES
    && waitingArtworkFetches.length >= MAX_QUEUED_ARTWORK_FETCHES) return Promise.resolve(null);

  return new Promise<T | null>((resolve, reject) => {
    const start = () => {
      activeArtworkFetches += 1;
      void Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeArtworkFetches -= 1;
          waitingArtworkFetches.shift()?.();
        });
    };
    if (activeArtworkFetches < MAX_ACTIVE_ARTWORK_FETCHES) start();
    else waitingArtworkFetches.push(start);
  });
}
