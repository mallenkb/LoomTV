export type FingerprintWindow = {
  frames: number[];
  durationMs: number;
  windowStartMs: number;
};

export type FingerprintMatch = {
  startFrame: number;
  endFrame: number;
  similarity: number;
  durationMs: number;
};

function popcount32(value: number): number {
  let next = value >>> 0;
  next -= (next >>> 1) & 0x55555555;
  next = (next & 0x33333333) + ((next >>> 2) & 0x33333333);
  return (((next + (next >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function fingerprintFrameSimilarity(left: number, right: number): number {
  return 1 - popcount32((left ^ right) >>> 0) / 32;
}

function candidateOffsets(left: number[], right: number[]): number[] {
  const buckets = new Map<number, number[]>();
  for (let index = 0; index < right.length; index += 2) {
    const key = (right[index] >>> 20) & 0xfff;
    const values = buckets.get(key) || [];
    if (values.length < 64) values.push(index);
    buckets.set(key, values);
  }
  const votes = new Map<number, number>();
  for (let index = 0; index < left.length; index += 4) {
    const values = buckets.get((left[index] >>> 20) & 0xfff) || [];
    for (const otherIndex of values) {
      const offset = otherIndex - index;
      votes.set(offset, (votes.get(offset) || 0) + 1);
    }
  }
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 32)
    .map(([offset]) => offset);
}

export function bestFingerprintMatch(
  left: FingerprintWindow,
  right: FingerprintWindow,
  limits: { minDurationMs: number; maxDurationMs: number; minSimilarity: number },
): FingerprintMatch | null {
  if (!left.frames.length || !right.frames.length || !left.durationMs || !right.durationMs) return null;
  const frameMs = left.durationMs / left.frames.length;
  const minFrames = Math.max(1, Math.ceil(limits.minDurationMs / frameMs));
  const maxFrames = Math.max(minFrames, Math.floor(limits.maxDurationMs / frameMs));
  let best: FingerprintMatch | null = null;

  for (const offset of candidateOffsets(left.frames, right.frames)) {
    const start = Math.max(0, -offset);
    const stop = Math.min(left.frames.length, right.frames.length - offset);
    let runStart = start;
    let runScore = 0;
    let runLength = 0;
    const consider = () => {
      if (runLength < minFrames) return;
      const boundedLength = Math.min(runLength, maxFrames);
      const similarity = runScore / runLength;
      if (similarity < limits.minSimilarity) return;
      const match: FingerprintMatch = {
        startFrame: runStart,
        endFrame: runStart + boundedLength,
        similarity,
        durationMs: boundedLength * frameMs,
      };
      if (!best || match.similarity * match.durationMs > best.similarity * best.durationMs) best = match;
    };

    for (let index = start; index < stop; index += 1) {
      const similarity = fingerprintFrameSimilarity(left.frames[index], right.frames[index + offset]);
      if (similarity >= 0.70) {
        runScore += similarity;
        runLength += 1;
      } else {
        consider();
        runStart = index + 1;
        runScore = 0;
        runLength = 0;
      }
    }
    consider();
  }
  return best;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function scoreFingerprintMatches(matches: FingerprintMatch[]): number {
  if (matches.length < 2) return 0;
  const similarities = matches.map((match) => match.similarity);
  const durations = matches.map((match) => match.durationMs);
  const medianDuration = median(durations);
  const medianDeviation = median(durations.map((duration) => Math.abs(duration - medianDuration)));
  const consistency = Math.max(0, 1 - medianDeviation / 5000);
  const supportingEpisodes = matches.length + 1;
  return 0.60 * median(similarities)
    + 0.25 * Math.min(1, supportingEpisodes / 5)
    + 0.15 * consistency;
}
