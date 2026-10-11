import { createContext, useContext, useEffect, useState } from 'react';

export const ArtworkSuspensionContext = createContext(false);

export function useArtworkSuspended(): boolean {
  return useContext(ArtworkSuspensionContext);
}

/** Hidden time before artwork is released. Main trims the image cache at 30 seconds. */
export const HIDDEN_ARTWORK_RELEASE_MS = 20_000;

/**
 * True once the window has been hidden or minimized for `delayMs`. Pages stay
 * mounted, so scroll position and state survive. Only their images detach, and
 * the cache trim that follows frees their decoded pixels and GPU textures.
 * Showing the window clears it at once.
 */
export function useWindowHiddenFor(delayMs = HIDDEN_ARTWORK_RELEASE_MS): boolean {
  const [hiddenLong, setHiddenLong] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        timer = window.setTimeout(() => setHiddenLong(true), delayMs);
      } else {
        setHiddenLong(false);
      }
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [delayMs]);
  return hiddenLong;
}
