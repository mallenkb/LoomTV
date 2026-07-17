export type CreditCardMetrics = { mean: number; entropy: number; saturation: number; edgeDensity: number };

export function classifyCreditCard(metrics: CreditCardMetrics): { matches: boolean; confidence: number } {
  const uniformity = Math.max(0, 1 - metrics.entropy / 6);
  const muted = Math.max(0, 1 - metrics.saturation / 0.35);
  const textLike = Math.min(1, metrics.edgeDensity / 0.08);
  const brightnessRange = metrics.mean >= 8 && metrics.mean <= 247 ? 1 : 0.5;
  const confidence = Math.max(0, Math.min(0.98,
    0.35 * uniformity + 0.30 * muted + 0.25 * textLike + 0.10 * brightnessRange));
  return { matches: confidence >= 0.72, confidence };
}
