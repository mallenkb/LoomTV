export function isMeaningfulCinemetaEpisodeTitle(value: string | undefined, seriesTitle?: string): boolean {
  const title = value?.trim().toLowerCase().replace(/\s+/g, ' ') || '';
  if (!title || title === seriesTitle?.trim().toLowerCase().replace(/\s+/g, ' ')) return false;
  if (/^(?:tba|tbd|unknown|untitled|n\/a|to be announced|to be determined)$/.test(title)) return false;
  if (/^(?:https?:|file:|[a-z]:[\\/]|[\\/])/.test(title)) return false;
  if (/^(?:tt\d+(?::\d+){0,2}|\d+|s\d+\s*e\d+|\d+\s*x\s*\d+)$/.test(title)) return false;
  return !/^(?:season\s*\d+\s*[-:,.]?\s*)?(?:episode|ep\.?)\s*[-:#.]?\s*\d+[.!]?$/.test(title);
}
