/** One automatic compatibility retry per user-initiated playback attempt. */
export function createPlaybackRecoveryGate() {
  let generation = 0;
  let attempted = false;
  return {
    begin() { attempted = false; return ++generation; },
    cancel() { attempted = true; generation += 1; },
    isCurrent(value: number) { return value === generation; },
    claim(value: number) {
      if (value !== generation || attempted) return false;
      attempted = true;
      return true;
    },
  };
}
