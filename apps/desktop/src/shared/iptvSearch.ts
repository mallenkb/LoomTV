/**
 * Channel search runs in the main process against a normalized column that is
 * written once per refresh, so a playlist with tens of thousands of channels
 * never has to cross IPC to be filtered. The renderer normalizes its input
 * with the same helpers so both sides agree on what a query means.
 */

export const IPTV_SEARCH_MAX_TERMS = 8;
export const IPTV_SEARCH_MAX_QUERY_LENGTH = 200;

/**
 * Fold a channel label into the comparable form used by both the stored search
 * column and the query. Accents are stripped so "Canal+ Décalé" is reachable
 * from an ASCII keyboard, and every run of punctuation becomes a single space
 * so "HBO-2", "HBO 2", and "HBO.2" are the same channel to a searcher.
 */
export function normalizeIptvText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function iptvChannelSearchText(channel: {
  name: string;
  groupTitle?: string;
  tvgId?: string;
  tvgName?: string;
}): string {
  return normalizeIptvText([
    channel.name,
    channel.groupTitle || '',
    channel.tvgName || '',
    channel.tvgId || '',
  ].join(' '));
}

/**
 * Split a query into the terms every match must contain. Duplicates collapse
 * and the count is capped so a pasted paragraph cannot turn into an unbounded
 * chain of SQL LIKE clauses.
 */
export function iptvSearchTerms(query: string): string[] {
  const normalized = normalizeIptvText(query.slice(0, IPTV_SEARCH_MAX_QUERY_LENGTH));
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(' '))).slice(0, IPTV_SEARCH_MAX_TERMS);
}

export function matchesIptvSearch(searchText: string, query: string): boolean {
  return iptvSearchTerms(query).every((term) => searchText.includes(term));
}
