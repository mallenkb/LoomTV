export type HttpByteRange = {
  start: number;
  end: number;
};

function safeNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parse one RFC 9110 byte range. Multipart ranges are intentionally rejected;
 * media players only need a single range, and accepting a partial parse would
 * make response length and seek behavior ambiguous.
 */
export function parseHttpByteRange(header: string, fileSize: number): HttpByteRange | null {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, startText, endText] = match;
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = safeNonNegativeInteger(endText);
    if (!suffixLength) return null;
    const boundedLength = Math.min(suffixLength, fileSize);
    return { start: fileSize - boundedLength, end: fileSize - 1 };
  }

  const start = safeNonNegativeInteger(startText);
  if (start === null || start >= fileSize) return null;
  if (!endText) return { start, end: fileSize - 1 };

  const requestedEnd = safeNonNegativeInteger(endText);
  if (requestedEnd === null || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, fileSize - 1) };
}
