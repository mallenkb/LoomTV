export type SkipPromptSegmentType = 'intro' | 'recap' | 'credits' | 'preview';

export type SkipPromptSegment = {
  type: string;
  startMs: number;
  endMs: number | null;
  mediaDurationMs: number;
};

export function isKnownSkipPromptType(type: string): type is SkipPromptSegmentType {
  return type === 'intro' || type === 'recap' || type === 'credits' || type === 'preview';
}

export function activeSkipSegmentAt<T extends SkipPromptSegment>(
  segments: readonly T[],
  positionSeconds: number,
): (T & { type: SkipPromptSegmentType }) | null {
  return segments.find((segment): segment is T & { type: SkipPromptSegmentType } => {
    if (!isKnownSkipPromptType(segment.type)) return false;
    const endSeconds = (segment.endMs ?? segment.mediaDurationMs) / 1000;
    return positionSeconds >= segment.startMs / 1000 && positionSeconds < endSeconds - 0.25;
  }) || null;
}

export function shouldShowSkipPrompt(segment: SkipPromptSegment | null, markerEditorOpen: boolean): boolean {
  // Marker timing is the source of truth. A transient player loading/error state
  // must not suppress the prompt while the playback clock is still advancing.
  return Boolean(segment) && !markerEditorOpen;
}

export function skipPromptLabel(type: string, episodic: boolean): string {
  if (type === 'credits') return episodic ? 'Outro' : 'Credits';
  return ({ intro: 'Intro', recap: 'Recap', preview: 'Preview' } as Record<string, string>)[type] || 'Skip';
}
