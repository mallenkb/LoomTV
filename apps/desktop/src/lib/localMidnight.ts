/** Milliseconds from `now` until the next local midnight, plus a small margin. */
export function msUntilNextLocalMidnight(now = new Date()): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - now.getTime() + 1_000;
}
