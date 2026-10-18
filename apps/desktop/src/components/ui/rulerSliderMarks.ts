/** Ticks on the ruler: 10 short ones, with a longer tick every fifth. */
export const RULER_TICK_COUNT = 10;

/** A pointer drag within this share of the range lands exactly on a mark. */
export const RULER_SNAP_FRACTION = 0.03;

export function snapToMark(value: number, marks: readonly number[], min: number, max: number): number {
  const span = max - min;
  if (!(span > 0)) return value;
  let best: number | null = null;
  for (const mark of marks) {
    const distance = Math.abs(mark - value) / span;
    if (distance <= RULER_SNAP_FRACTION && (best === null || distance < Math.abs(best - value) / span)) best = mark;
  }
  return best ?? value;
}
