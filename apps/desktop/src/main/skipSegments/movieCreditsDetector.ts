export const MOVIE_CREDIT_FRAME_WIDTH = 160;
export const MOVIE_CREDIT_FRAME_HEIGHT = 90;
export const MOVIE_CREDIT_SAMPLE_MS = 1000;

export type MovieCreditInterval = {
  startMs: number;
  endMs: number | null;
  confidence: number;
};

type FrameEvidence = {
  creditLike: boolean;
  darkRatio: number;
};

function frameEvidence(frame: Uint8Array, previous?: Uint8Array): FrameEvidence {
  const width = MOVIE_CREDIT_FRAME_WIDTH;
  const height = MOVIE_CREDIT_FRAME_HEIGHT;
  let dark = 0;
  let bright = 0;
  let edges = 0;
  let comparisons = 0;
  let change = 0;
  const brightRows = new Uint16Array(height);
  const brightColumns = new Uint16Array(width);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const value = frame[index];
      if (value < 58) dark += 1;
      if (value > 185) {
        bright += 1;
        brightRows[y] += 1;
        brightColumns[x] += 1;
      }
      if (x > 0) {
        if (Math.abs(value - frame[index - 1]) > 45) edges += 1;
        comparisons += 1;
      }
      if (y > 0) {
        if (Math.abs(value - frame[index - width]) > 45) edges += 1;
        comparisons += 1;
      }
      if (previous) change += Math.abs(value - previous[index]);
    }
  }

  const pixels = frame.length;
  const darkRatio = dark / pixels;
  const brightRatio = bright / pixels;
  const edgeRatio = edges / Math.max(1, comparisons);
  const rowCoverage = brightRows.filter((count) => count >= 2).length / height;
  const columnCoverage = brightColumns.filter((count) => count >= 1).length / width;
  const changeRatio = previous ? change / pixels / 255 : 0;
  return {
    darkRatio,
    creditLike: darkRatio >= 0.68
      && brightRatio >= 0.002
      && brightRatio <= 0.22
      && edgeRatio >= 0.008
      && rowCoverage >= 0.08
      && columnCoverage >= 0.08
      && changeRatio <= 0.22,
  };
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
): MovieCreditInterval[] {
  const frameSize = MOVIE_CREDIT_FRAME_WIDTH * MOVIE_CREDIT_FRAME_HEIGHT;
  const frameCount = Math.floor(rawFrames.length / frameSize);
  if (frameCount < 45) return [];
  const evidence: FrameEvidence[] = [];
  let previous: Uint8Array | undefined;
  for (let index = 0; index < frameCount; index += 1) {
    const frame = rawFrames.subarray(index * frameSize, (index + 1) * frameSize);
    evidence.push(frameEvidence(frame, previous));
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
