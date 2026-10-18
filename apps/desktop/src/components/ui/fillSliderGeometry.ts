/** Where the fill and handle sit, in percent of the bar's width. */
export function fillSliderGeometry(value: number, min: number, max: number) {
  const span = max - min || 1;
  const toPct = (input: number) => Math.min(100, Math.max(0, ((input - min) / span) * 100));
  const valuePct = Number.isFinite(value) ? toPct(value) : 0;
  const originPct = min < 0 && max > 0 ? toPct(0) : 0;
  return { valuePct, fillLeft: Math.min(originPct, valuePct), fillWidth: Math.abs(valuePct - originPct) };
}
