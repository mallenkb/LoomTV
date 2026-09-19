export function subtitleBottom(
  position: number,
  viewportHeight: number,
  blockHeight: number,
  controlsInset: number,
  controlsVisible: boolean,
): number {
  const savedBottom = viewportHeight * (1 - Math.max(0, Math.min(100, position)) / 100);
  const desiredBottom = controlsVisible ? Math.max(savedBottom, controlsInset) : savedBottom;
  return Math.max(0, Math.min(desiredBottom, viewportHeight - blockHeight - 16));
}
