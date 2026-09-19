export type SubtitleCue = { start: number; end: number; text: string };

export function cleanSubtitleCueText(value: string): string {
  return value
    // Subtitle files sometimes carry ASS overrides or stray conversion marks
    // as visible text. Keep dialogue, punctuation, and speaker labels intact.
    .replace(/\{\\[^}]{0,200}\}/g, '')
    .replace(/\{\*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/gi, (entity) => {
      const decoded: Record<string, string> = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
        '&apos;': "'", '&nbsp;': ' ', '&#39;': "'",
      };
      return decoded[entity.toLowerCase()] || entity;
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function parseVttTimestamp(value: string): number {
  const parts = value.trim().split(':');
  if (parts.length < 2) return NaN;
  const seconds = parseFloat((parts.pop() || '').replace(',', '.'));
  const minutes = parseInt(parts.pop() || '0', 10);
  const hours = parts.length ? parseInt(parts.pop() || '0', 10) : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

export function parseVttCues(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    const arrowIndex = lines.findIndex((line) => line.includes('-->'));
    if (arrowIndex === -1) continue;
    const [startRaw, restRaw] = lines[arrowIndex].split('-->');
    const endRaw = (restRaw || '').trim().split(/\s+/)[0] || '';
    const start = parseVttTimestamp(startRaw);
    const end = parseVttTimestamp(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = lines
      .slice(arrowIndex + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    const cleanedText = cleanSubtitleCueText(text);
    if (cleanedText) cues.push({ start, end, text: cleanedText });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function activeSubtitleText(cues: SubtitleCue[], time: number, prefixEndTimes?: readonly number[]): string {
  if (!Number.isFinite(time) || cues.length === 0) return '';
  let low = 0;
  let high = cues.length - 1;
  let lastStartedIndex = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (cues[middle].start <= time) {
      lastStartedIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (lastStartedIndex < 0) return '';
  // Prefix maxima preserve overlapping cues while skipping expired history.
  let firstCandidate = 0;
  if (prefixEndTimes?.length === cues.length) {
    low = 0;
    high = lastStartedIndex + 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (prefixEndTimes[middle] <= time) low = middle + 1;
      else high = middle;
    }
    firstCandidate = low;
  }
  const activeLines = new Set<string>();
  for (let index = firstCandidate; index <= lastStartedIndex; index += 1) {
    const cue = cues[index];
    if (time >= cue.start && time < cue.end && cue.text) activeLines.add(cue.text);
  }
  return Array.from(activeLines).join('\n');
}
