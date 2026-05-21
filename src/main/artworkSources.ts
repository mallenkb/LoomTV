export function isInlineArtworkSource(source?: string | null): boolean {
  return /^data:/i.test(source || '');
}

function hasDurableArtworkSource(source?: string | null): boolean {
  return Boolean(source?.trim()) && !isInlineArtworkSource(source);
}

export function durableArtworkSource(source?: string | null): string {
  if (!hasDurableArtworkSource(source)) return '';
  return String(source).trim();
}

export function durableArtworkSources(sources?: string[]): string[] {
  return Array.from(new Set((sources || []).map(durableArtworkSource).filter(Boolean)));
}
