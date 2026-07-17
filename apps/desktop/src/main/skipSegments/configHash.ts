import { createHash } from 'node:crypto';
import type { SkipAnalysisSettings } from '../../shared/desktopProtocol.ts';
import { CHAPTER_LABELS } from './normalize.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

export function selectionConfigHash(settings: SkipAnalysisSettings): string {
  const selection = {
    detectorVersion: 'loom-skip-selection-v2',
    detectorConstants: {
      neighborRadius: 4,
      minimumPeerMatches: 2,
      minimumSimilarity: 0.85,
      reviewConfidence: 0.80,
      publishConfidence: 0.90,
      snapInwardMs: 5000,
      snapOutwardMs: 2000,
      snapMediaEdgeMs: 2000,
      localOverlapRatio: 0.60,
      introWindow: { startRatio: 0, maximumMs: 600_000, durationRatio: 0.25 },
      recapWindow: { startRatio: 0, maximumMs: 180_000, durationRatio: 0.15 },
      creditsWindow: { fromEnd: true, maximumMs: 300_000 },
      previewWindow: { fromEnd: true, maximumMs: 120_000 },
      episodeVisualWindowMs: 300_000,
      movieVisualWindowMs: 900_000,
      silence: { noiseDb: -45, agreementMinimumSeconds: 0.5, boundaryMinimumSeconds: 0.25, blackAgreementMs: 5000 },
      blackFrame: { detectionSeconds: 0.5, pixelThreshold: 0.10, adaptiveDarkRatio: 0.85, defaultBrightness: 28 },
      creditCard: { entropyScale: 6, mutedSaturation: 0.35, textEdgeDensity: 0.08, confidenceThreshold: 0.72 },
      chapterLabels: CHAPTER_LABELS,
    },
    enabledTypes: settings.enabledTypes,
    durationLimits: settings.durationLimits,
    suppressFirstEpisodeIntro: settings.suppressFirstEpisodeIntro,
    analyzeSpecials: settings.analyzeSpecials,
    exclusions: Object.fromEntries(Object.entries(settings.exclusions)
      .map(([key, values]) => [key, [...values].sort()])),
    seasonOverrides: settings.seasonOverrides,
  };
  return createHash('sha256').update(JSON.stringify(canonical(selection))).digest('hex').slice(0, 24);
}
