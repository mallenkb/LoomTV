/**
 * XMLTV is the guide format that pairs with an M3U playlist: the playlist says
 * where a channel streams from, the guide says what is on it, and `tvg-id`
 * joins the two. Jellyfin uses the same pairing for its M3U tuners.
 *
 * A guide file is a large, flat, untrusted document. It is scanned rather than
 * parsed into a tree so a 100 MB guide never materializes as a DOM, and so a
 * single malformed `<programme>` costs one entry instead of the whole refresh.
 */

const MAX_GUIDE_PROGRAMMES = 200_000;
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 1000;

export type ParsedIptvProgramme = {
  tvgId: string;
  startMs: number;
  endMs: number;
  title: string;
  description: string;
};

export type ParsedIptvGuide = {
  programmes: ParsedIptvProgramme[];
  /** Entries dropped for a missing channel, unusable times, or no title. */
  skipped: number;
  truncated: boolean;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * XMLTV timestamps are `YYYYMMDDHHMMSS` with an optional ` +HHMM` offset.
 * A missing offset means the guide is in the viewer's local time, which is how
 * every XMLTV consumer reads it.
 */
export function parseXmltvTimestamp(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second || '0'),
  };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return null;
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) return null;

  const utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  if (!Number.isFinite(utc)) return null;
  if (!offset) {
    // Reconstruct through the local calendar so a guide without an offset
    // lands on the same wall-clock time the provider meant.
    const local = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return local.getTime();
  }
  const sign = offset.startsWith('-') ? -1 : 1;
  const offsetMinutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5));
  return utc - sign * offsetMinutes * 60_000;
}

function readAttribute(tag: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match ? decodeXmlText(match[1]).trim() : '';
}

/** Pull the text of the first `<child>` element inside a `<programme>` body. */
function readChildText(body: string, childName: string): string {
  const match = new RegExp(`<${childName}(?:\\s[^>]*)?>([\\s\\S]*?)</${childName}>`, 'i').exec(body);
  if (!match) return '';
  return decodeXmlText(match[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * The key a guide channel and a playlist channel are matched on: the ID
 * without iptv-org's feed suffix, so a playlist's "00sReplay.us@SD" matches a
 * guide's "00sReplay.us". Both sides are reduced the same way, so guides that
 * keep the suffix still match.
 */
export function guideChannelKey(id: string): string {
  return id.replace(/@[^@]*$/, '');
}

const PROGRAMME_PATTERN = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;

/** Add one `<programme>` element to the result, or count it as skipped. */
function collectProgramme(
  result: ParsedIptvGuide,
  attributes: string,
  body: string,
  knownChannelIds: ReadonlySet<string> | undefined,
): void {
  const tvgId = guideChannelKey(readAttribute(attributes, 'channel'));
  if (!tvgId || (knownChannelIds && !knownChannelIds.has(tvgId))) {
    result.skipped += 1;
    return;
  }
  const startMs = parseXmltvTimestamp(readAttribute(attributes, 'start'));
  const stopMs = parseXmltvTimestamp(readAttribute(attributes, 'stop'));
  const title = readChildText(body, 'title').slice(0, MAX_TITLE_LENGTH);
  if (startMs === null || stopMs === null || stopMs <= startMs || !title) {
    result.skipped += 1;
    return;
  }

  result.programmes.push({
    tvgId,
    startMs,
    endMs: stopMs,
    title,
    description: readChildText(body, 'desc').slice(0, MAX_DESCRIPTION_LENGTH),
  });
}

/**
 * Collect the guide entries for the channels a playlist actually carries.
 * `knownChannelIds` keeps a national guide covering thousands of channels from
 * writing rows for channels this source cannot play.
 */
export function parseXmltvGuide(
  text: string,
  knownChannelIds?: ReadonlySet<string>,
): ParsedIptvGuide {
  const result: ParsedIptvGuide = { programmes: [], skipped: 0, truncated: false };
  const pattern = new RegExp(PROGRAMME_PATTERN);
  let match = pattern.exec(text);

  while (match) {
    if (result.programmes.length >= MAX_GUIDE_PROGRAMMES) {
      result.truncated = true;
      break;
    }
    const [, attributes, body] = match;
    match = pattern.exec(text);
    collectProgramme(result, attributes, body, knownChannelIds);
  }

  return result;
}

/** Text kept between chunks while no complete `<programme>` has arrived yet. */
const MAX_PENDING_GUIDE_TEXT = 4 * 1024 * 1024;
/** Main-thread time spent parsing before giving the event loop a turn. */
const GUIDE_PARSE_SLICE_MS = 8;

/**
 * The same result as `parseXmltvGuide`, read from text chunks as they are
 * decompressed. A 200,000-entry guide is about 80 MB of XML. Parsing it in one
 * call held the main process for half a second and kept the whole document in
 * memory as a buffer and a string. Here only the unfinished tail of the last
 * chunk is kept, and the event loop runs every few milliseconds.
 */
export async function parseXmltvGuideChunks(
  chunks: AsyncIterable<string>,
  knownChannelIds?: ReadonlySet<string>,
): Promise<ParsedIptvGuide> {
  const result: ParsedIptvGuide = { programmes: [], skipped: 0, truncated: false };
  const pattern = new RegExp(PROGRAMME_PATTERN);
  let pending = '';
  let sliceStartedAt = performance.now();

  for await (const chunk of chunks) {
    pending += chunk;
    pattern.lastIndex = 0;
    let consumed = 0;
    let match = pattern.exec(pending);
    while (match) {
      if (result.programmes.length >= MAX_GUIDE_PROGRAMMES) {
        result.truncated = true;
        return result;
      }
      consumed = pattern.lastIndex;
      collectProgramme(result, match[1], match[2], knownChannelIds);
      match = pattern.exec(pending);
    }
    pending = pending.slice(consumed);
    // Text before the first `<programme` can never be part of a match, so the
    // channel list at the top of the file is not rescanned with every chunk.
    const firstOpen = pending.search(/<programme/i);
    pending = firstOpen >= 0 ? pending.slice(firstOpen) : pending.slice(-'<programme'.length);
    if (pending.length > MAX_PENDING_GUIDE_TEXT) {
      // Only an unfinished element can complete later. Keep text from its start.
      const open = pending.toLowerCase().lastIndexOf('<programme');
      pending = open >= 0 ? pending.slice(open) : pending.slice(-'<programme'.length);
    }
    if (performance.now() - sliceStartedAt >= GUIDE_PARSE_SLICE_MS) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      sliceStartedAt = performance.now();
    }
  }

  return result;
}
