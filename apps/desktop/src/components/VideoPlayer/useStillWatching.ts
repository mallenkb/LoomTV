import { useCallback, useEffect, useRef, useState } from 'react';

/** Episodes that may play back to back with no input before asking. */
export const STILL_WATCHING_AFTER_EPISODES = 2;

/**
 * Counts episodes that ended on their own with no key press, click, or
 * scroll from the viewer. Once that reaches the limit, the next automatic
 * advance asks "Are you still watching?" instead of starting the episode.
 *
 * The player stays mounted across a series' episodes, so the count lives
 * here and starts from zero whenever the viewer opens the player.
 */
export function useStillWatching() {
  const unattendedEpisodesRef = useRef(0);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    const viewerIsHere = () => { unattendedEpisodesRef.current = 0; };
    // Capture so input handled (and stopped) by player controls still counts.
    const options = { capture: true, passive: true } as const;
    window.addEventListener('keydown', viewerIsHere, options);
    window.addEventListener('pointerdown', viewerIsHere, options);
    window.addEventListener('wheel', viewerIsHere, options);
    return () => {
      window.removeEventListener('keydown', viewerIsHere, options);
      window.removeEventListener('pointerdown', viewerIsHere, options);
      window.removeEventListener('wheel', viewerIsHere, options);
    };
  }, []);

  /**
   * Called when an episode ends on its own and the next one would start.
   * True lets it start; false means the viewer is being asked first.
   */
  const allowAutomaticNext = useCallback((): boolean => {
    unattendedEpisodesRef.current += 1;
    if (unattendedEpisodesRef.current < STILL_WATCHING_AFTER_EPISODES) return true;
    setAsking(true);
    return false;
  }, []);

  const answered = useCallback(() => {
    unattendedEpisodesRef.current = 0;
    setAsking(false);
  }, []);

  return { askingStillWatching: asking, allowAutomaticNext, answerStillWatching: answered };
}
