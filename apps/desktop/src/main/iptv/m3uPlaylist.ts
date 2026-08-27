import { iptvChannelSearchText } from '../../shared/iptvSearch.ts';

/**
 * Extended M3U is the interchange format every IPTV provider speaks, and the
 * same one Jellyfin's M3U tuner reads. A playlist is a flat list of
 * `#EXTINF` headers, each carrying `tvg-*` metadata and followed by the
 * stream URL for that channel.
 *
 * The parser is deliberately total: a provider's playlist is untrusted input,
 * so a malformed entry is counted and dropped rather than aborting the refresh
 * that the remaining thousands of channels depend on.
 */

/** Playlists this large are already pathological; refuse the rest of the file. */
export const MAX_PLAYLIST_CHANNELS = 20_000;
const MAX_FIELD_LENGTH = 400;
const MAX_URL_LENGTH = 2048;

export type ParsedIptvChannel = {
  /** Stable within a source: the provider's tvg-id when it gives one. */
  channelId: string;
  name: string;
  tvgId: string;
  tvgName: string;
  logoUrl: string;
  groupTitle: string;
  isGeoBlocked: boolean;
  streamUrl: string;
  searchText: string;
};

export type ParsedIptvPlaylist = {
  /** `x-tvg-url` from the header, used as the guide URL when none was given. */
  epgUrl: string;
  channels: ParsedIptvChannel[];
  /** Entries dropped because they carried no usable stream URL. */
  skippedMalformed: number;
  /** Entries dropped because their stream URL was not HTTPS. */
  skippedInsecure: number;
  /** Entries dropped because an earlier entry already claimed the same URL. */
  skippedDuplicate: number;
  /** True when the playlist was longer than MAX_PLAYLIST_CHANNELS. */
  truncated: boolean;
};

function trimField(value: string): string {
  return value.trim().slice(0, MAX_FIELD_LENGTH);
}

/** Read the `key="value"` pairs an `#EXTINF` header carries before its title. */
export function parseExtInfAttributes(header: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(header);
  while (match) {
    attributes[match[1].toLowerCase()] = match[2];
    match = pattern.exec(header);
  }
  return attributes;
}

/**
 * Split an `#EXTINF` line into its attribute half and its display title. The
 * separator is the first comma that is not inside a quoted attribute value —
 * group titles routinely contain commas, so splitting on the first comma or
 * the last one both produce wrong names on real playlists.
 */
export function splitExtInfLine(line: string): { header: string; title: string } {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) {
      return { header: line.slice(0, index), title: line.slice(index + 1) };
    }
  }
  return { header: line, title: '' };
}

/**
 * Only HTTPS streams are accepted. The renderer's media-src policy and the
 * app's outbound fetch policy both refuse plain HTTP, so storing an http://
 * channel would only produce a row that fails at play time.
 */
function isPlayableStreamUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isHttpStreamUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'http:';
  } catch {
    return false;
  }
}

function safeLogoUrl(value: string): string {
  if (!value || value.length > MAX_URL_LENGTH) return '';
  try {
    return new URL(value).protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

function isGeoBlockedEntry(attributes: Record<string, string>, title: string): boolean {
  if (/\[\s*geo[- ]blocked\s*\]/i.test(title)) return true;
  const declared = attributes['geo-blocked'] || attributes['geoblocked'] || attributes.label || '';
  return /^(?:1|true|yes|geo[- ]blocked)$/i.test(declared.trim());
}

export function parseM3uPlaylist(text: string): ParsedIptvPlaylist {
  const result: ParsedIptvPlaylist = {
    epgUrl: '',
    channels: [],
    skippedMalformed: 0,
    skippedInsecure: 0,
    skippedDuplicate: 0,
    truncated: false,
  };

  const seenUrls = new Set<string>();
  const usedChannelIds = new Set<string>();
  let pending: { attributes: Record<string, string>; title: string } | null = null;
  // #EXTGRP applies to every following entry until the next #EXTGRP, unlike
  // group-title which is per entry.
  let currentGroup = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      const headerAttributes = parseExtInfAttributes(line);
      const declared = headerAttributes['x-tvg-url'] || headerAttributes['url-tvg'] || '';
      const firstUrl = declared.split(',')[0]?.trim() || '';
      if (firstUrl && isPlayableStreamUrl(firstUrl)) result.epgUrl = firstUrl;
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      if (pending) result.skippedMalformed += 1;
      const { header, title } = splitExtInfLine(line);
      pending = { attributes: parseExtInfAttributes(header), title: trimField(title) };
      continue;
    }

    if (line.startsWith('#EXTGRP')) {
      currentGroup = trimField(line.slice(line.indexOf(':') + 1));
      continue;
    }

    // Every other directive (#EXTVLCOPT, #KODIPROP, comments) is metadata this
    // player has no use for and must not mistake for a stream URL.
    if (line.startsWith('#')) continue;

    if (!pending) continue;
    const entry = pending;
    pending = null;

    if (result.channels.length >= MAX_PLAYLIST_CHANNELS) {
      result.truncated = true;
      break;
    }

    const streamUrl = line.slice(0, MAX_URL_LENGTH + 1);
    if (!isPlayableStreamUrl(streamUrl)) {
      if (isHttpStreamUrl(streamUrl)) result.skippedInsecure += 1;
      else result.skippedMalformed += 1;
      continue;
    }
    if (seenUrls.has(streamUrl)) {
      result.skippedDuplicate += 1;
      continue;
    }
    seenUrls.add(streamUrl);

    const tvgId = trimField(entry.attributes['tvg-id'] || '');
    const tvgName = trimField(entry.attributes['tvg-name'] || '');
    const groupTitle = trimField(entry.attributes['group-title'] || '') || currentGroup;
    const name = entry.title || tvgName || tvgId || 'Untitled channel';

    // tvg-id is the join key against the guide, but providers repeat it across
    // quality variants ("HBO HD" and "HBO SD" both tagged hbo.us). Keep the
    // guide key separate from the row identity so neither one collides.
    const baseId = tvgId || `url:${streamUrl}`;
    let channelId = baseId;
    let suffix = 2;
    while (usedChannelIds.has(channelId)) {
      channelId = `${baseId}#${suffix}`;
      suffix += 1;
    }
    usedChannelIds.add(channelId);

    const channel: ParsedIptvChannel = {
      channelId: channelId.slice(0, MAX_URL_LENGTH),
      name,
      tvgId,
      tvgName,
      logoUrl: safeLogoUrl(entry.attributes['tvg-logo'] || ''),
      groupTitle,
      isGeoBlocked: isGeoBlockedEntry(entry.attributes, name),
      streamUrl,
      searchText: '',
    };
    channel.searchText = iptvChannelSearchText(channel);
    result.channels.push(channel);
  }

  if (pending) result.skippedMalformed += 1;
  return result;
}
