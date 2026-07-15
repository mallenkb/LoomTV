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
  credits: 2,
  preview: 3,
};

export function normalizeSegment(
  value: NormalizedSegmentInput,
  mediaDurationMs: number,
): NormalizedSegmentInput | null {
  const duration = Math.max(0, Math.round(mediaDurationMs));
  const startMs = Math.round(Number(value.startMs));
  const rawEnd = value.endMs === null ? null : Math.round(Number(value.endMs));
  if (!duration || !Number.isFinite(startMs) || startMs < 0 || startMs >= duration) return null;
  if (rawEnd !== null && (!Number.isFinite(rawEnd) || rawEnd <= startMs || rawEnd > duration + 1000)) return null;
  const endMs = rawEnd === null ? null : Math.min(duration, rawEnd);
  if (endMs !== null && endMs - startMs < 1000) return null;
  return {
    ...value,
    startMs,
    endMs,
    confidence: Math.min(1, Math.max(0, Number(value.confidence) || 0)),
  };
}

export function durationIsCompatible(sourceDurationMs: number | undefined, localDurationMs: number): boolean {
  if (!sourceDurationMs || !localDurationMs) return true;
  const tolerance = Math.max(30_000, localDurationMs * 0.02);
  return Math.abs(sourceDurationMs - localDurationMs) <= tolerance;
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
    .map(([, values]) => values.sort((a, b) => {
      const sourceOrder = SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
      if (sourceOrder !== 0) return sourceOrder;
      if (a.source === 'aniskip' && b.source === 'theintrodb') return -1;
      if (a.source === 'theintrodb' && b.source === 'aniskip') return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    })[0])
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs || TYPE_ORDER[a.type] - TYPE_ORDER[b.type])
    .map(({ id, type, startMs, endMs, confidence, source, mediaDurationMs, updatedAt }) => ({
      id,
      type,
      startMs,
      endMs,
      confidence,
      source,
      mediaDurationMs,
      updatedAt,
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

export function chapterType(title: string): MediaSegmentType | null {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (['intro', 'introduction', 'opening', 'op'].includes(normalized)) return 'intro';
  if (['recap', 'previously on'].includes(normalized)) return 'recap';
  if (['credits', 'end credits', 'ending', 'ed'].includes(normalized)) return 'credits';
  if (['preview', 'next episode', 'next episode preview'].includes(normalized)) return 'preview';
  return null;
}

export function deduplicateProviderSegments(segments: NormalizedSegmentInput[], mediaDurationMs: number): NormalizedSegmentInput[] {
  const result: NormalizedSegmentInput[] = [];
  for (const type of ['recap', 'intro', 'credits', 'preview'] as const) {
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
    const anchor = intervals[0];
    const compatible = intervals.every((candidate) => {
      const overlap = Math.max(0, Math.min(anchor.end, candidate.end) - Math.max(anchor.start, candidate.start));
      const shortest = Math.min(anchor.end - anchor.start, candidate.end - candidate.start);
      return shortest > 0 && overlap / shortest >= 0.5;
    });
    if (compatible) result.push(anchor.segment);
  }
  return result;
}
