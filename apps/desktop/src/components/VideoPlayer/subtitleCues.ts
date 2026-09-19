export type SubtitleCue = { start: number; end: number; text: string };

export function isAssDialogueTrack(codec?: string, title?: string): boolean {
  return /^(ass|ssa)$|substation alpha/i.test((codec || '').trim())
    && /\b(dialogue|honorific)\b/i.test(title || '');
}

export function isAssSignsTrack(codec?: string, title?: string): boolean {
  return /^(ass|ssa)$|substation alpha/i.test((codec || '').trim())
    && /\b(signs?|sings?)\s*&\s*songs?\b/i.test(title || '');
}

export function cleanSubtitleCueText(value: string): string {
  return value
    // Subtitle files sometimes carry ASS overrides or stray conversion marks
    // as visible text. Keep dialogue, punctuation, and speaker labels intact.
    .replace(/\{\\[^}]{0,200}\}/g, '')
    .replace(/\{\*\}/g, '')
    // Some converted subtitles append editor notes after the spoken sentence.
    // Limit this to long, trailing notes so short sound and speaker cues survive.
    .replace(/([.!?])\s*\{[^{}\r\n]{20,160}\}(?=\s*(?:\n|$))/g, '$1')
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

export function cleanAssCueText(value: string): string {
  // ASS defines every {...} block as an override or inline comment. A raw
  // alternate translation in one of those blocks is not spoken dialogue.
  return value
    .replace(/\{[^{}\r\n]*\}/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, ' ')
    .replace(/\\h/g, '\u00a0')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function parseAssTimestamp(value: string): number {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/);
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(2, '0')) / 100;
}

export function parseAssDialogueCues(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let columns: string[] = [];
  let inEvents = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\[.*\]$/.test(line.trim())) {
      inEvents = line.trim().toLowerCase() === '[events]';
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) {
      columns = line.slice(line.indexOf(':') + 1).split(',').map((column) => column.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line) || columns.length === 0) continue;
    // Text is the last field in ASS and may contain commas.
    const parts = line.slice(line.indexOf(':') + 1).trimStart().split(',');
    if (parts.length < columns.length) continue;
    const values = [...parts.slice(0, columns.length - 1), parts.slice(columns.length - 1).join(',')];
    const start = parseAssTimestamp(values[columns.indexOf('start')] || '');
    const end = parseAssTimestamp(values[columns.indexOf('end')] || '');
    const style = values[columns.indexOf('style')]?.trim() || '';
    if (!/^(default(?:\s*-\s*alt)?|dialogue|subtitles|main)$/i.test(style)) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = cleanAssCueText(values[columns.indexOf('text')] || '');
    if (text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
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
