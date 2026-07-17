import { classifyCreditCard } from './creditCardClassifier.ts';

export const MOVIE_CREDIT_FRAME_WIDTH = 160;
export const MOVIE_CREDIT_FRAME_HEIGHT = 90;
const MOVIE_CREDIT_SAMPLE_MS = 1000;

export type MovieCreditInterval = {
  startMs: number;
  endMs: number | null;
  confidence: number;
};

type FrameEvidence = {
  creditLike: boolean;
  darkRatio: number;
};

function frameEvidence(frame: Uint8Array, adaptiveBrightnessThreshold: number, channels: 1 | 3, previous?: Uint8Array): FrameEvidence {
  const width = MOVIE_CREDIT_FRAME_WIDTH;
  const height = MOVIE_CREDIT_FRAME_HEIGHT;
  let dark = 0;
  let bright = 0;
  let edges = 0;
  let comparisons = 0;
  let change = 0;
  let sum = 0;
  let saturationSum = 0;
  const histogram = new Uint32Array(256);
  const brightRows = new Uint16Array(height);
  const brightColumns = new Uint16Array(width);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const index = pixelIndex * channels;
      const red = frame[index];
      const green = channels === 3 ? frame[index + 1] : red;
      const blue = channels === 3 ? frame[index + 2] : red;
      const value = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      saturationSum += maximum ? (maximum - minimum) / maximum : 0;
      sum += value;
      histogram[value] += 1;
      if (value < 58) dark += 1;
      if (value > 185) {
        bright += 1;
        brightRows[y] += 1;
        brightColumns[x] += 1;
      }
      if (x > 0) {
        const previousIndex = index - channels;
        const previousValue = Math.round(frame[previousIndex] * 0.2126 + (channels === 3 ? frame[previousIndex + 1] : frame[previousIndex]) * 0.7152 + (channels === 3 ? frame[previousIndex + 2] : frame[previousIndex]) * 0.0722);
        if (Math.abs(value - previousValue) > 45) edges += 1;
        comparisons += 1;
      }
      if (y > 0) {
        const previousIndex = index - width * channels;
        const previousValue = Math.round(frame[previousIndex] * 0.2126 + (channels === 3 ? frame[previousIndex + 1] : frame[previousIndex]) * 0.7152 + (channels === 3 ? frame[previousIndex + 2] : frame[previousIndex]) * 0.0722);
        if (Math.abs(value - previousValue) > 45) edges += 1;
        comparisons += 1;
      }
      if (previous) {
        const previousValue = Math.round(previous[index] * 0.2126 + (channels === 3 ? previous[index + 1] : previous[index]) * 0.7152 + (channels === 3 ? previous[index + 2] : previous[index]) * 0.0722);
        change += Math.abs(value - previousValue);
      }
    }
  }

  const pixels = width * height;
  const darkRatio = dark / pixels;
  const brightRatio = bright / pixels;
  const edgeRatio = edges / Math.max(1, comparisons);
  const rowCoverage = brightRows.filter((count) => count >= 2).length / height;
  const columnCoverage = brightColumns.filter((count) => count >= 1).length / width;
  const changeRatio = previous ? change / pixels / 255 : 0;
  const mean = sum / pixels;
  const entropy = histogram.reduce((value, count) => {
    if (!count) return value;
    const probability = count / pixels;
    return value - probability * Math.log2(probability);
  }, 0);
  const creditCard = classifyCreditCard({ mean, entropy, saturation: saturationSum / pixels, edgeDensity: edgeRatio });
  let adaptiveDarkPixels = 0;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * channels;
    const value = Math.round(frame[offset] * 0.2126 + (channels === 3 ? frame[offset + 1] : frame[offset]) * 0.7152 + (channels === 3 ? frame[offset + 2] : frame[offset]) * 0.0722);
    if (value < adaptiveBrightnessThreshold) adaptiveDarkPixels += 1;
  }
  const adaptiveDarkRatio = adaptiveDarkPixels / pixels;
  const distributedText = rowCoverage >= 0.08 && columnCoverage >= 0.08 && edgeRatio >= 0.008;
  return {
    darkRatio,
    creditLike: (darkRatio >= 0.68
      && brightRatio >= 0.002
      && brightRatio <= 0.22
      && distributedText
      && changeRatio <= 0.22)
      || (adaptiveDarkRatio >= 0.85 && distributedText && changeRatio <= 0.22)
      || (creditCard.matches && distributedText && changeRatio <= 0.12),
  };
}

export function adaptiveLuminanceThreshold(rawFrames: Uint8Array, channels: 1 | 3 = 1): number {
  if (!rawFrames.length) return 28;
  const samples: number[] = [];
  const stride = Math.max(1, Math.floor(rawFrames.length / 20_000));
  for (let index = 0; index < rawFrames.length; index += stride * channels) {
    const red = rawFrames[index];
    const green = channels === 3 ? rawFrames[index + 1] : red;
    const blue = channels === 3 ? rawFrames[index + 2] : red;
    samples.push(Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722));
  }
  samples.sort((left, right) => left - right);
  const lowerQuartile = samples[Math.floor(samples.length * 0.25)] ?? 28;
  return Math.max(18, Math.min(48, Math.round(lowerQuartile * 0.75 || 28)));
}

function fillShortGaps(values: boolean[], maxGap: number): boolean[] {
  const smoothed = [...values];
  let index = 0;
  while (index < smoothed.length) {
    if (smoothed[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < smoothed.length && !smoothed[index]) index += 1;
    const length = index - start;
    if (start > 0 && index < smoothed.length && length <= maxGap) {
      for (let fill = start; fill < index; fill += 1) smoothed[fill] = true;
    }
  }
  return smoothed;
}

export function detectMovieCreditIntervals(
  rawFrames: Uint8Array,
  windowStartMs: number,
  mediaDurationMs: number,
  channels: 1 | 3 = 1,
): MovieCreditInterval[] {
  const frameSize = MOVIE_CREDIT_FRAME_WIDTH * MOVIE_CREDIT_FRAME_HEIGHT * channels;
  const frameCount = Math.floor(rawFrames.length / frameSize);
  if (frameCount < 45) return [];
  const evidence: FrameEvidence[] = [];
  const adaptiveBrightnessThreshold = adaptiveLuminanceThreshold(rawFrames, channels);
  let previous: Uint8Array | undefined;
  for (let index = 0; index < frameCount; index += 1) {
    const frame = rawFrames.subarray(index * frameSize, (index + 1) * frameSize);
    evidence.push(frameEvidence(frame, adaptiveBrightnessThreshold, channels, previous));
    previous = frame;
  }

  const smoothed = fillShortGaps(evidence.map((value) => value.creditLike), 3);
  const runs: Array<{ start: number; end: number; confidence: number }> = [];
  let index = 0;
  while (index < smoothed.length) {
    if (!smoothed[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < smoothed.length && smoothed[index]) index += 1;
    const end = index;
    const durationMs = (end - start) * MOVIE_CREDIT_SAMPLE_MS;
    if (durationMs < 45_000) continue;
    const originalRatio = evidence.slice(start, end).filter((value) => value.creditLike).length / (end - start);
    const averageDarkness = evidence.slice(start, end).reduce((sum, value) => sum + value.darkRatio, 0) / (end - start);
    const confidence = Math.min(0.98,
      0.84
      + Math.min(0.05, durationMs / 300_000 * 0.05)
      + originalRatio * 0.04
      + averageDarkness * 0.03);
    if (confidence >= 0.90) runs.push({ start, end, confidence });
  }

  let finalRunIndex = -1;
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    if (windowStartMs + runs[runIndex].end * MOVIE_CREDIT_SAMPLE_MS >= mediaDurationMs - 30_000) {
      finalRunIndex = runIndex;
      break;
    }
  }
  if (finalRunIndex < 0) return [];
  const accepted = [runs[finalRunIndex]];
  for (let runIndex = finalRunIndex - 1; runIndex >= 0; runIndex -= 1) {
    const run = runs[runIndex];
    const next = accepted[0];
    const gapMs = (next.start - run.end) * MOVIE_CREDIT_SAMPLE_MS;
    if (run.confidence >= 0.92 && gapMs <= 5 * 60_000) accepted.unshift(run);
  }

  return accepted.map((run, runIndex) => ({
    startMs: Math.max(0, Math.round(windowStartMs + run.start * MOVIE_CREDIT_SAMPLE_MS)),
    endMs: runIndex === accepted.length - 1
      ? null
      : Math.min(mediaDurationMs, Math.round(windowStartMs + run.end * MOVIE_CREDIT_SAMPLE_MS)),
    confidence: run.confidence,
  }));
}
