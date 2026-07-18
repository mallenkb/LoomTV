import { createHash } from 'node:crypto';
import type {
  MediaSegment,
  MediaSegmentCandidate,
  MediaSegmentSource,
  MediaSegmentType,
  NormalizedSegmentInput,
} from './types';

const SOURCE_PRIORITY: Record<MediaSegmentSource, number> = {
  manual: 0,
  chapter: 1,
  aniskip: 2,
  theintrodb: 2,
  chromaprint: 3,
};

const TYPE_ORDER: Record<MediaSegmentType, number> = {
  recap: 0,
  intro: 1,
  outro: 2,
  credits: 3,
  preview: 4,
};

export function normalizeSegment(
  value: NormalizedSegmentInput,
  mediaDurationMs: number,
): NormalizedSegmentInput | null {
  const duration = Math.max(0, Math.round(mediaDurationMs));
  const startMs = Math.round(Number(value.startMs));
  const rawEnd = value.endMs === null ? null : Math.round(Number(value.endMs));
  if (!duration || !Number.isFinite(startMs) || startMs < 0 || startMs >= duration) return null;
  // Provider timestamps are submitted against releases whose runtime can differ
  // from the local file by a few seconds. An end that overshoots the local
  // duration within the shared duration tolerance clamps to the file end;
  // rejecting it drops valid credits markers on an episode-by-episode basis.
  if (rawEnd !== null && (!Number.isFinite(rawEnd) || rawEnd <= startMs || rawEnd > duration + durationToleranceMs(duration))) return null;
  const endMs = rawEnd === null ? null : Math.min(duration, rawEnd);
  if (endMs !== null && endMs - startMs < 1000) return null;
  return {
    ...value,
    startMs,
    endMs,
    confidence: Math.min(1, Math.max(0, Number(value.confidence) || 0)),
  };
}

export function durationToleranceMs(localDurationMs: number): number {
  return Math.max(30_000, localDurationMs * 0.02);
}

export function durationIsCompatible(sourceDurationMs: number | undefined, localDurationMs: number): boolean {
  if (!sourceDurationMs || !localDurationMs) return true;
  return Math.abs(sourceDurationMs - localDurationMs) <= durationToleranceMs(localDurationMs);
}

export function resolveCandidates(candidates: MediaSegmentCandidate[]): MediaSegment[] {
  const active = candidates.filter((candidate) => candidate.status === 'active');
  const byType = new Map<MediaSegmentType, MediaSegmentCandidate[]>();
  for (const candidate of active) {
    const values = byType.get(candidate.type) || [];
    values.push(candidate);
    byType.set(candidate.type, values);
  }

  return [...byType.entries()]
    .flatMap(([type, values]) => {
      const ranked = values.sort((a, b) => {
      const sourceOrder = SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
      if (sourceOrder !== 0) return sourceOrder;
      if (a.source === 'aniskip' && b.source === 'theintrodb') return -1;
      if (a.source === 'theintrodb' && b.source === 'aniskip') return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
      });
      const winner = ranked[0];
      if (!winner) return [];
      // Movies can have a credits block, a post-credit scene, and another
      // credits block. Preserve every non-overlapping credits interval from
      // the winning source while retaining one winner for other marker types.
      return type === 'credits'
        ? ranked.filter((candidate) => candidate.source === winner.source)
        : [winner];
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs || TYPE_ORDER[a.type] - TYPE_ORDER[b.type])
    .map(({ id, type, startMs, endMs, confidence, source, mediaDurationMs, updatedAt, analysisMetadata }) => ({
      id,
      type,
      startMs,
      endMs,
      confidence,
      source,
      mediaDurationMs,
      updatedAt,
      analysisMetadata,
    }));
}

export function segmentRevision(segments: MediaSegment[]): string {
  const canonical = segments.map(({ type, startMs, endMs, source, mediaDurationMs }) => ({
    type,
    startMs,
    endMs,
    source,
    mediaDurationMs,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

export const CHAPTER_LABELS: Record<MediaSegmentType, readonly string[]> = {
  intro: ['intro', 'introduction', 'opening', 'op'],
  recap: ['recap', 'previously', 'previously on', 'summary', 'last episode'],
  outro: ['outro', 'ending', 'ending theme', 'closing theme', 'ed'],
  credits: ['credits', 'end credits', 'production credits', 'closing credits'],
  preview: ['preview', 'pv', 'sneak peek', 'coming up', 'next episode', 'next episode preview'],
};

export function chapterType(title: string): MediaSegmentType | null {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const type of ['intro', 'recap', 'outro', 'credits', 'preview'] as const) {
    if (CHAPTER_LABELS[type].includes(normalized)) return type;
  }
  return null;
}

export function deduplicateProviderSegments(segments: NormalizedSegmentInput[], mediaDurationMs: number): NormalizedSegmentInput[] {
  const result: NormalizedSegmentInput[] = [];
  for (const type of ['recap', 'intro', 'outro', 'credits', 'preview'] as const) {
    const values = segments.filter((segment) => segment.type === type);
    if (values.length <= 1) {
      result.push(...values);
      continue;
    }
    const intervals = values.map((segment) => ({
      segment,
      start: segment.startMs,
      end: segment.endMs ?? mediaDurationMs,
    })).sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const overlapsEnough = (left: typeof intervals[number], right: typeof intervals[number]) => {
      const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
      const shortest = Math.min(left.end - left.start, right.end - right.start);
      return shortest > 0 && overlap / shortest >= 0.5;
    };
    if (type === 'credits') {
      const clusters: Array<typeof intervals> = [];
      for (const interval of intervals.sort((a, b) => a.start - b.start)) {
        const cluster = clusters.find((values) => values.some((value) => overlapsEnough(value, interval)));
        if (cluster) cluster.push(interval);
        else clusters.push([interval]);
      }
      result.push(...clusters.map((cluster) => cluster.sort((a, b) =>
        (b.end - b.start) - (a.end - a.start) || b.segment.confidence - a.segment.confidence)[0].segment));
      continue;
    }
    const anchor = intervals[0];
    if (intervals.every((candidate) => overlapsEnough(anchor, candidate))) result.push(anchor.segment);
  }
  return result.sort((a, b) => a.startMs - b.startMs);
}
