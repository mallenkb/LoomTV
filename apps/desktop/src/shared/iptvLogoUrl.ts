/**
 * Normalize an IPTV logo supplied by an untrusted playlist before it reaches
 * either desktop renderer. Providers commonly leave whitespace, HTML-escape
 * query separators, or omit the scheme even though the image is HTTPS.
 *
 * HTTP is accepted here for already-stored legacy logos and redirects. Stream
 * URLs remain HTTPS-only in the playlist parsers and playback proxy.
 */
export function normalizeIptvLogoUrl(value: string | null | undefined): string {
  const trimmed = String(value || '')
    .trim()
    .replaceAll('&amp;', '&')
    .replace(/^['"]|['"]$/g, '');
  if (!trimmed) return '';

  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (!parsed.hostname || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}
