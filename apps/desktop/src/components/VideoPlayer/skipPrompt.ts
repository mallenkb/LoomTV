export type SkipPromptSegmentType = 'intro' | 'recap' | 'outro' | 'credits' | 'preview';

export type SkipPromptSegment = {
  type: string;
  startMs: number;
  endMs: number | null;
  mediaDurationMs: number;
};

export function isKnownSkipPromptType(type: string): type is SkipPromptSegmentType {
  return type === 'intro' || type === 'recap' || type === 'outro' || type === 'credits' || type === 'preview';
}

export function activeSkipSegmentAt<T extends SkipPromptSegment>(
  segments: readonly T[],
  positionSeconds: number,
): (T & { type: SkipPromptSegmentType }) | null {
  const active = segments.filter((segment): segment is T & { type: SkipPromptSegmentType } => {
    if (!isKnownSkipPromptType(segment.type)) return false;
    const endSeconds = (segment.endMs ?? segment.mediaDurationMs) / 1000;
    return positionSeconds >= segment.startMs / 1000 && positionSeconds < endSeconds - 0.25;
  });
  // A provider credits range may encompass the anime ending. Keep the more
  // specific Ending prompt visible until it ends, then expose Skip Credits.
  const priority: Record<SkipPromptSegmentType, number> = { recap: 0, intro: 1, outro: 2, preview: 3, credits: 4 };
  return active.sort((left, right) => priority[left.type] - priority[right.type] || left.startMs - right.startMs)[0] || null;
}

export function shouldShowSkipPrompt(segment: SkipPromptSegment | null, markerEditorOpen: boolean): boolean {
  // Marker timing is the source of truth. A transient player loading/error state
  // must not suppress the prompt while the playback clock is still advancing.
  return Boolean(segment) && !markerEditorOpen;
}

export function skipPromptLabel(type: string, _episodic: boolean): string {
  return ({ intro: 'Intro', recap: 'Recap', outro: 'Outro', credits: 'Credits', preview: 'Preview' } as Record<string, string>)[type] || 'Skip';
}

export type SkipActionSegment = {
  startMs: number;
  endMs: number | null;
  mediaDurationMs: number;
};

export function buildSkipAction(
  segment: SkipActionSegment,
  positionMs: number,
  preRollMs = 500,
): number | null {
  const { startMs, endMs, mediaDurationMs } = segment;
  if (!Number.isFinite(mediaDurationMs) || mediaDurationMs <= 0) return null;
  if (!Number.isFinite(positionMs) || !Number.isFinite(startMs)) return null;
  if (!Number.isFinite(preRollMs) || preRollMs < 0) return null;
  if (startMs < 0) return null;
  if (startMs >= mediaDurationMs) return null;
  if (endMs !== null) {
    if (!Number.isFinite(endMs)) return null;
    if (endMs <= startMs) return null;
    if (endMs > mediaDurationMs) return null;
  }
  const effectiveEndMs = endMs ?? mediaDurationMs;
  if (positionMs < startMs || positionMs >= effectiveEndMs) return null;
  const targetMs = endMs === null ? mediaDurationMs - preRollMs : endMs;
  if (!Number.isFinite(targetMs)) return null;
  if (!(targetMs > positionMs + 250)) return null;
  if (!(targetMs >= 0 && targetMs < mediaDurationMs)) return null;
  return targetMs;
}

export function pinVisibleTarget(
  previousId: string | null,
  previousTargetMs: number | null,
  currentId: string | null,
  freshTargetMs: number | null,
): number | null {
  if (currentId === null || currentId === undefined) return null;
  if (previousId !== null && previousId === currentId && previousTargetMs !== null) {
    return previousTargetMs;
  }
  return freshTargetMs;
}
