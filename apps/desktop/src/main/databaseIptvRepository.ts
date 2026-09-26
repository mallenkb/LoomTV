import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { parseDatabaseRow, parseDatabaseRows } from './databaseRows.ts';
import { iptvSearchTerms } from '../shared/iptvSearch.ts';
import type { ParsedIptvChannel } from './iptv/m3uPlaylist.ts';
import type { ParsedIptvProgramme } from './iptv/xmltvGuide.ts';
import type { IptvSourceIconId } from '../shared/desktopProtocol.ts';

export const MAX_IPTV_SOURCES = 12;
export const MAX_IPTV_CHANNEL_PAGE = 200;

export type IptvSourceRecord = {
  id: string;
  name: string;
  iconId: IptvSourceIconId;
  playlistUrl: string;
  epgUrl: string;
  sortOrder: number;
  channelCount: number;
  programmeCount: number;
  skippedInsecure: number;
  skippedMalformed: number;
  refreshedAt: number;
  refreshError: string;
  refreshWarning: string;
  healthCheckedAt: number;
  createdAt: number;
  updatedAt: number;
};

export type IptvChannelRecord = {
  sourceId: string;
  channelId: string;
  position: number;
  name: string;
  tvgId: string;
  tvgName: string;
  logoUrl: string;
  groupTitle: string;
  streamUrl: string;
  nowTitle: string;
  nowStartMs: number;
  nowEndMs: number;
  nextTitle: string;
  nextStartMs: number;
  favorite: boolean;
};

export type IptvChannelQuery = {
  sourceId: string;
  query?: string;
  group?: string;
  subcategory?: string;
  geoFilter?: 'all' | 'exclude' | 'only';
  /** Only favorites, or only recently watched channels (newest first). */
  collection?: 'all' | 'favorites' | 'recent';
  sort?: 'name-asc' | 'name-desc' | 'category';
  limit?: number;
  offset?: number;
  /** Reference time for the now/next columns; injected by tests. */
  nowMs?: number;
};

const sourceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon_id: z.string(),
  playlist_url: z.string(),
  epg_url: z.string(),
  sort_order: z.number().int(),
  channel_count: z.number().int(),
  programme_count: z.number().int(),
  skipped_insecure: z.number().int(),
  skipped_malformed: z.number().int(),
  refreshed_at: z.number().int(),
  refresh_error: z.string(),
  refresh_warning: z.string(),
  health_checked_at: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

const channelRowSchema = z.object({
  source_id: z.string(),
  channel_id: z.string(),
  position: z.number().int(),
  name: z.string(),
  tvg_id: z.string(),
  tvg_name: z.string(),
  logo_url: z.string(),
  group_title: z.string(),
  stream_url: z.string(),
  now_title: z.string().nullable(),
  now_start_ms: z.number().nullable(),
  now_end_ms: z.number().nullable(),
  next_title: z.string().nullable(),
  next_start_ms: z.number().nullable(),
  favorite: z.number().int(),
});

const countRowSchema = z.object({ total: z.number().int() });
const groupRowSchema = z.object({ group_title: z.string(), channel_count: z.number().int() });

function toSourceRecord(row: z.output<typeof sourceRowSchema>): IptvSourceRecord {
  return {
    id: row.id,
    name: row.name,
    iconId: row.icon_id as IptvSourceIconId,
    playlistUrl: row.playlist_url,
    epgUrl: row.epg_url,
    sortOrder: row.sort_order,
    channelCount: row.channel_count,
    programmeCount: row.programme_count,
    skippedInsecure: row.skipped_insecure,
    skippedMalformed: row.skipped_malformed,
    refreshedAt: row.refreshed_at,
    refreshError: row.refresh_error,
    refreshWarning: row.refresh_warning,
    healthCheckedAt: row.health_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listIptvSources(database: BetterSqlite3.Database): IptvSourceRecord[] {
  const rows = database
    .prepare('SELECT * FROM iptv_sources ORDER BY sort_order ASC, created_at ASC')
    .all();
  return parseDatabaseRows(rows, sourceRowSchema, 'IPTV source').map(toSourceRecord);
}

export function getIptvSource(database: BetterSqlite3.Database, sourceId: string): IptvSourceRecord | null {
  const row = database.prepare('SELECT * FROM iptv_sources WHERE id = ?').get(sourceId);
  return row ? toSourceRecord(parseDatabaseRow(row, sourceRowSchema, 'IPTV source')) : null;
}

export function countIptvSources(database: BetterSqlite3.Database): number {
  const row = database.prepare('SELECT COUNT(*) AS total FROM iptv_sources').get();
  return parseDatabaseRow(row, countRowSchema, 'IPTV source count').total;
}

export function findIptvSourceByPlaylistUrl(
  database: BetterSqlite3.Database,
  playlistUrl: string,
): IptvSourceRecord | null {
  const row = database.prepare('SELECT * FROM iptv_sources WHERE playlist_url = ?').get(playlistUrl);
  return row ? toSourceRecord(parseDatabaseRow(row, sourceRowSchema, 'IPTV source')) : null;
}

export function insertIptvSource(
  database: BetterSqlite3.Database,
  input: { id: string; name: string; playlistUrl: string; epgUrl: string; iconId?: IptvSourceIconId },
): IptvSourceRecord {
  const now = Date.now();
  const iconId = input.iconId ?? 'general';
  const nextOrderRow = database.prepare('SELECT COUNT(*) AS total FROM iptv_sources').get();
  const sortOrder = parseDatabaseRow(nextOrderRow, countRowSchema, 'IPTV source count').total;
  database
    .prepare(`
      INSERT INTO iptv_sources (id, name, icon_id, playlist_url, epg_url, sort_order, created_at, updated_at)
      VALUES (@id, @name, @iconId, @playlistUrl, @epgUrl, @sortOrder, @now, @now)
    `)
    .run({ ...input, iconId, sortOrder, now });
  const created = getIptvSource(database, input.id);
  if (!created) throw new Error('The IPTV source could not be saved.');
  return created;
}

export function renameIptvSource(
  database: BetterSqlite3.Database,
  sourceId: string,
  patch: { name?: string; playlistUrl?: string; epgUrl?: string; iconId?: IptvSourceIconId },
): IptvSourceRecord | null {
  const existing = getIptvSource(database, sourceId);
  if (!existing) return null;
  database
    .prepare('UPDATE iptv_sources SET name = ?, playlist_url = ?, epg_url = ?, icon_id = ?, updated_at = ? WHERE id = ?')
    .run(
      patch.name ?? existing.name,
      patch.playlistUrl ?? existing.playlistUrl,
      patch.epgUrl ?? existing.epgUrl,
      patch.iconId ?? existing.iconId,
      Date.now(),
      sourceId,
    );
  return getIptvSource(database, sourceId);
}

export function deleteIptvSource(database: BetterSqlite3.Database, sourceId: string): boolean {
  return database.transaction(() => {
    database.prepare('DELETE FROM iptv_favorites WHERE source_id = ?').run(sourceId);
    database.prepare('DELETE FROM iptv_recent WHERE source_id = ?').run(sourceId);
    database.prepare('DELETE FROM iptv_programmes WHERE source_id = ?').run(sourceId);
    database.prepare('DELETE FROM iptv_channels WHERE source_id = ?').run(sourceId);
    const result = database.prepare('DELETE FROM iptv_sources WHERE id = ?').run(sourceId);
    return result.changes > 0;
  })();
}

/**
 * A refresh replaces a source's channels wholesale. Providers reorder and
 * renumber freely between refreshes, so merging by row would leave channels
 * the playlist has dropped visible forever.
 */
export function replaceIptvChannels(
  database: BetterSqlite3.Database,
  sourceId: string,
  channels: readonly ParsedIptvChannel[],
): void {
  const insert = database.prepare(`
    INSERT INTO iptv_channels (
      source_id, channel_id, position, name, tvg_id, tvg_name, logo_url, group_title, is_geo_blocked, stream_url, search_text
    ) VALUES (
      @sourceId, @channelId, @position, @name, @tvgId, @tvgName, @logoUrl, @groupTitle, @isGeoBlocked, @streamUrl, @searchText
    )
  `);
  database.transaction(() => {
    database.prepare('DELETE FROM iptv_channels WHERE source_id = ?').run(sourceId);
    channels.forEach((channel, position) => {
      insert.run({ ...channel, isGeoBlocked: channel.isGeoBlocked ? 1 : 0, sourceId, position });
    });
  })();
}

export function replaceIptvProgrammes(
  database: BetterSqlite3.Database,
  sourceId: string,
  programmes: readonly ParsedIptvProgramme[],
): void {
  const insert = database.prepare(`
    INSERT OR REPLACE INTO iptv_programmes (source_id, tvg_id, start_ms, end_ms, title, description)
    VALUES (@sourceId, @tvgId, @startMs, @endMs, @title, @description)
  `);
  database.transaction(() => {
    database.prepare('DELETE FROM iptv_programmes WHERE source_id = ?').run(sourceId);
    for (const programme of programmes) insert.run({ ...programme, sourceId });
  })();
}

export function recordIptvRefresh(
  database: BetterSqlite3.Database,
  sourceId: string,
  outcome: {
    channelCount?: number;
    programmeCount?: number;
    skippedInsecure?: number;
    skippedMalformed?: number;
    epgUrl?: string;
    error?: string;
    /** A problem that did not stop the refresh, such as an unreachable guide. */
    warning?: string;
  },
): IptvSourceRecord | null {
  const existing = getIptvSource(database, sourceId);
  if (!existing) return null;
  const now = Date.now();
  database
    .prepare(`
      UPDATE iptv_sources SET
        channel_count = @channelCount,
        programme_count = @programmeCount,
        skipped_insecure = @skippedInsecure,
        skipped_malformed = @skippedMalformed,
        epg_url = @epgUrl,
        refreshed_at = @refreshedAt,
        refresh_error = @error,
        refresh_warning = @warning,
        updated_at = @now
      WHERE id = @sourceId
    `)
    .run({
      sourceId,
      channelCount: outcome.channelCount ?? existing.channelCount,
      programmeCount: outcome.programmeCount ?? existing.programmeCount,
      skippedInsecure: outcome.skippedInsecure ?? existing.skippedInsecure,
      skippedMalformed: outcome.skippedMalformed ?? existing.skippedMalformed,
      epgUrl: outcome.epgUrl ?? existing.epgUrl,
      // A failed refresh keeps the last good timestamp so the UI can say how
      // stale the channels on screen actually are.
      refreshedAt: outcome.error ? existing.refreshedAt : now,
      error: outcome.error || '',
      // A failed refresh keeps the previous warning; it says nothing new
      // about the guide.
      warning: outcome.error ? existing.refreshWarning : outcome.warning || '',
      now,
    });
  return getIptvSource(database, sourceId);
}

/** A channel's guide key in SQL: its tvg-id without the "@feed" suffix (see guideChannelKey). */
const GUIDE_KEY = "CASE WHEN instr(c.tvg_id, '@') > 0 THEN substr(c.tvg_id, 1, instr(c.tvg_id, '@') - 1) ELSE c.tvg_id END";

/**
 * Only channels whose latest full check passed are listed: the stream loaded,
 * a segment decoded to real picture or sound, and nothing has failed since.
 * New, failing, and unverifiable channels stay out of every list and count;
 * their rows remain so a stream that starts working appears on its own.
 */
const VISIBLE_CHANNEL = `EXISTS (
  SELECT 1 FROM iptv_stream_health h
  WHERE h.stream_url = c.stream_url AND h.status = 'ok' AND h.analyzed_at >= h.checked_at
)`;

/**
 * Build the WHERE fragment for a channel query. Every search term must appear
 * in the stored search column, which is what makes "sky sport" match
 * "Sky Sports Main Event" without matching every channel containing "sky".
 */
function channelFilter(request: IptvChannelQuery): { clause: string; parameters: Record<string, string> } {
  const parameters: Record<string, string> = { sourceId: request.sourceId };
  const clauses = ['c.source_id = @sourceId', VISIBLE_CHANNEL];

  const group = request.group?.trim();
  if (group) {
    clauses.push("instr(';' || lower(replace(c.group_title, ' ', '')) || ';', ';' || @group || ';') > 0");
    parameters.group = group.toLowerCase().replace(/\s+/g, '');
  }

  const subcategory = request.subcategory?.trim();
  if (subcategory) {
    clauses.push("instr(';' || lower(replace(c.group_title, ' ', '')) || ';', ';' || @subcategory || ';') > 0");
    parameters.subcategory = subcategory.toLowerCase().replace(/\s+/g, '');
  }

  if (request.collection === 'favorites') {
    clauses.push('EXISTS (SELECT 1 FROM iptv_favorites f WHERE f.source_id = c.source_id AND f.channel_id = c.channel_id)');
  } else if (request.collection === 'recent') {
    clauses.push('EXISTS (SELECT 1 FROM iptv_recent r WHERE r.source_id = c.source_id AND r.channel_id = c.channel_id)');
  }

  if (request.geoFilter === 'exclude') clauses.push('c.is_geo_blocked = 0');
  else if (request.geoFilter === 'only') clauses.push('c.is_geo_blocked = 1');

  iptvSearchTerms(request.query || '').forEach((term, index) => {
    const key = `term${index}`;
    // ESCAPE keeps a query containing % or _ from turning into a wildcard.
    clauses.push(`c.search_text LIKE @${key} ESCAPE '\\'`);
    parameters[key] = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
  });

  return { clause: clauses.join(' AND '), parameters };
}

export function countIptvChannels(database: BetterSqlite3.Database, request: IptvChannelQuery): number {
  const { clause, parameters } = channelFilter(request);
  const row = database
    .prepare(`SELECT COUNT(*) AS total FROM iptv_channels c WHERE ${clause}`)
    .get(parameters);
  return parseDatabaseRow(row, countRowSchema, 'IPTV channel count').total;
}

export function listIptvChannels(
  database: BetterSqlite3.Database,
  request: IptvChannelQuery,
): IptvChannelRecord[] {
  const { clause, parameters } = channelFilter(request);
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? MAX_IPTV_CHANNEL_PAGE), 1), MAX_IPTV_CHANNEL_PAGE);
  const offset = Math.max(Math.trunc(request.offset ?? 0), 0);
  const nowMs = Number.isFinite(request.nowMs) ? Number(request.nowMs) : Date.now();
  const orderBy = request.collection === 'recent'
    ? '(SELECT r.watched_at FROM iptv_recent r WHERE r.source_id = c.source_id AND r.channel_id = c.channel_id) DESC'
    : request.sort === 'name-desc'
    ? 'c.name COLLATE NOCASE DESC, c.position ASC'
    : request.sort === 'category'
      ? "CASE WHEN c.group_title = '' THEN 1 ELSE 0 END, c.group_title COLLATE NOCASE ASC, c.name COLLATE NOCASE ASC, c.position ASC"
      : 'c.position ASC';

  // The now/next lookups are correlated subqueries rather than joins so a
  // channel with no guide coverage still returns exactly one row.
  const rows = database
    .prepare(`
      SELECT
        c.source_id, c.channel_id, c.position, c.name, c.tvg_id, c.tvg_name,
        c.logo_url, c.group_title, c.stream_url,
        EXISTS (SELECT 1 FROM iptv_favorites f WHERE f.source_id = c.source_id AND f.channel_id = c.channel_id) AS favorite,
        now_p.title AS now_title, now_p.start_ms AS now_start_ms, now_p.end_ms AS now_end_ms,
        next_p.title AS next_title, next_p.start_ms AS next_start_ms
      FROM iptv_channels c
      LEFT JOIN iptv_programmes now_p ON now_p.rowid = (
        SELECT p.rowid FROM iptv_programmes p
        WHERE p.source_id = c.source_id AND p.tvg_id = ${GUIDE_KEY}
          AND p.start_ms <= @nowMs AND p.end_ms > @nowMs
        ORDER BY p.start_ms DESC LIMIT 1
      )
      LEFT JOIN iptv_programmes next_p ON next_p.rowid = (
        SELECT p.rowid FROM iptv_programmes p
        WHERE p.source_id = c.source_id AND p.tvg_id = ${GUIDE_KEY} AND p.start_ms > @nowMs
        ORDER BY p.start_ms ASC LIMIT 1
      )
      WHERE ${clause}
      ORDER BY ${orderBy}
      LIMIT @limit OFFSET @offset
    `)
    .all({ ...parameters, nowMs, limit, offset });

  return parseDatabaseRows(rows, channelRowSchema, 'IPTV channel').map((row) => ({
    sourceId: row.source_id,
    channelId: row.channel_id,
    position: row.position,
    name: row.name,
    tvgId: row.tvg_id,
    tvgName: row.tvg_name,
    logoUrl: row.logo_url,
    groupTitle: row.group_title,
    streamUrl: row.stream_url,
    nowTitle: row.now_title || '',
    nowStartMs: row.now_start_ms || 0,
    nowEndMs: row.now_end_ms || 0,
    nextTitle: row.next_title || '',
    nextStartMs: row.next_start_ms || 0,
    favorite: row.favorite === 1,
  }));
}

export function listIptvGroups(
  database: BetterSqlite3.Database,
  sourceId: string,
): Array<{ name: string; channelCount: number }> {
  const rows = database
    .prepare(`
      SELECT group_title, COUNT(*) AS channel_count
      FROM iptv_channels c
      WHERE c.source_id = ? AND c.group_title <> '' AND ${VISIBLE_CHANNEL}
      GROUP BY group_title
      ORDER BY group_title COLLATE NOCASE ASC
    `)
    .all(sourceId);
  const groups = new Map<string, { name: string; channelCount: number }>();
  parseDatabaseRows(rows, groupRowSchema, 'IPTV group').forEach((row) => {
    const names = new Set(row.group_title.split(';').map((name) => name.trim()).filter(Boolean));
    names.forEach((name) => {
      const key = name.toLocaleLowerCase();
      const current = groups.get(key);
      if (current) current.channelCount += row.channel_count;
      else groups.set(key, { name, channelCount: row.channel_count });
    });
  });
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

export function listIptvSubcategories(
  database: BetterSqlite3.Database,
  sourceId: string,
  selectedGroup: string | undefined,
): Array<{ name: string; channelCount: number }> {
  const group = selectedGroup?.trim();
  if (!group) return [];
  const groupKey = group.toLowerCase().replace(/\s+/g, '');
  const rows = database
    .prepare(`
      SELECT group_title, COUNT(*) AS channel_count
      FROM iptv_channels c
      WHERE c.source_id = @sourceId
        AND instr(';' || lower(replace(c.group_title, ' ', '')) || ';', ';' || @group || ';') > 0
        AND ${VISIBLE_CHANNEL}
      GROUP BY group_title
      ORDER BY group_title COLLATE NOCASE ASC
    `)
    .all({ sourceId, group: groupKey });

  const subcategories = new Map<string, { name: string; channelCount: number }>();
  parseDatabaseRows(rows, groupRowSchema, 'IPTV subcategory').forEach((row) => {
    const names = new Set(row.group_title.split(';').map((name) => name.trim()).filter(Boolean));
    names.forEach((name) => {
      const key = name.toLowerCase().replace(/\s+/g, '');
      if (key === groupKey) return;
      const current = subcategories.get(key);
      if (current) current.channelCount += row.channel_count;
      else subcategories.set(key, { name, channelCount: row.channel_count });
    });
  });

  return [...subcategories.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

/** Resolve a channel to the stream URL the player is allowed to open. */
export function getIptvChannelStreamUrl(
  database: BetterSqlite3.Database,
  sourceId: string,
  channelId: string,
): string | null {
  const row = database
    .prepare('SELECT stream_url FROM iptv_channels WHERE source_id = ? AND channel_id = ?')
    .get(sourceId, channelId);
  if (!row) return null;
  return parseDatabaseRow(row, z.object({ stream_url: z.string() }), 'IPTV stream URL').stream_url;
}

export type IptvStreamHealthStatus = 'ok' | 'dead' | 'blank';

export type IptvStreamHealthRecord = {
  streamUrl: string;
  status: IptvStreamHealthStatus | null;
  failures: number;
  hidden: boolean;
  checkedAt: number;
  analyzedAt: number;
};

const streamHealthRowSchema = z.object({
  stream_url: z.string(),
  status: z.enum(['ok', 'dead', 'blank']).nullable(),
  failures: z.number().int().nullable(),
  hidden: z.number().int().nullable(),
  checked_at: z.number().int().nullable(),
  analyzed_at: z.number().int().nullable(),
});

/**
 * Streams in a source that are due a health check: never checked, last checked
 * before `dueBefore`, failing but not yet confirmed (a transient failure is
 * settled on the very next run), or reachable but never fully verified.
 */
export function listIptvStreamsDueForHealthCheck(
  database: BetterSqlite3.Database,
  sourceId: string,
  dueBefore: number,
): IptvStreamHealthRecord[] {
  const rows = database
    .prepare(`
      SELECT DISTINCT c.stream_url, h.status, h.failures, h.hidden, h.checked_at, h.analyzed_at
      FROM iptv_channels c
      LEFT JOIN iptv_stream_health h ON h.stream_url = c.stream_url
      WHERE c.source_id = @sourceId
        AND (
          h.stream_url IS NULL
          OR h.checked_at < @dueBefore
          OR (h.status <> 'ok' AND h.hidden = 0)
          OR (h.status = 'ok' AND h.analyzed_at < h.checked_at)
        )
      ORDER BY c.position ASC
    `)
    .all({ sourceId, dueBefore });
  return parseDatabaseRows(rows, streamHealthRowSchema, 'IPTV stream health').map((row) => ({
    streamUrl: row.stream_url,
    status: row.status,
    failures: row.failures ?? 0,
    hidden: row.hidden === 1,
    checkedAt: row.checked_at ?? 0,
    analyzedAt: row.analyzed_at ?? 0,
  }));
}

export function recordIptvStreamHealth(
  database: BetterSqlite3.Database,
  entry: {
    streamUrl: string;
    status: IptvStreamHealthStatus;
    reason: string;
    failures: number;
    hidden: boolean;
    checkedAt: number;
    analyzedAt: number;
  },
): void {
  database
    .prepare(`
      INSERT INTO iptv_stream_health (stream_url, status, reason, failures, hidden, checked_at, analyzed_at)
      VALUES (@streamUrl, @status, @reason, @failures, @hidden, @checkedAt, @analyzedAt)
      ON CONFLICT(stream_url) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        failures = excluded.failures,
        hidden = excluded.hidden,
        checked_at = excluded.checked_at,
        analyzed_at = excluded.analyzed_at
    `)
    .run({ ...entry, reason: entry.reason.slice(0, 300), hidden: entry.hidden ? 1 : 0 });
}

const healthCountRowSchema = z.object({
  total: z.number().int(),
  verified: z.number().int().nullable(),
  failed: z.number().int().nullable(),
});

/** Verified, failed, and not-yet-verified channel counts for one source. */
export function countIptvChannelHealth(
  database: BetterSqlite3.Database,
  sourceId: string,
): { verified: number; failed: number; pending: number } {
  const row = database
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN h.status = 'ok' AND h.analyzed_at >= h.checked_at THEN 1 ELSE 0 END) AS verified,
        SUM(CASE WHEN h.status IS NOT NULL AND h.status <> 'ok' THEN 1 ELSE 0 END) AS failed
      FROM iptv_channels c
      LEFT JOIN iptv_stream_health h ON h.stream_url = c.stream_url
      WHERE c.source_id = ?
    `)
    .get(sourceId);
  const counts = parseDatabaseRow(row, healthCountRowSchema, 'IPTV channel health count');
  const verified = counts.verified ?? 0;
  const failed = counts.failed ?? 0;
  return { verified, failed, pending: Math.max(counts.total - verified - failed, 0) };
}

export function recordIptvHealthCheck(database: BetterSqlite3.Database, sourceId: string, checkedAt: number): void {
  database.prepare('UPDATE iptv_sources SET health_checked_at = ? WHERE id = ?').run(checkedAt, sourceId);
}

/** Drop health rows for streams no source lists any more. */
export function pruneIptvStreamHealth(database: BetterSqlite3.Database): void {
  database
    .prepare('DELETE FROM iptv_stream_health WHERE stream_url NOT IN (SELECT stream_url FROM iptv_channels)')
    .run();
}

export function setIptvFavorite(database: BetterSqlite3.Database, sourceId: string, channelId: string, favorite: boolean): void {
  if (favorite) {
    database.prepare('INSERT OR IGNORE INTO iptv_favorites (source_id, channel_id, created_at) VALUES (?, ?, ?)').run(sourceId, channelId, Date.now());
  } else {
    database.prepare('DELETE FROM iptv_favorites WHERE source_id = ? AND channel_id = ?').run(sourceId, channelId);
  }
}

/** Channels kept in a source's recently watched list. */
export const MAX_IPTV_RECENT = 30;

export function recordIptvRecent(database: BetterSqlite3.Database, sourceId: string, channelId: string, watchedAt = Date.now()): void {
  database.transaction(() => {
    database.prepare(`
      INSERT INTO iptv_recent (source_id, channel_id, watched_at) VALUES (?, ?, ?)
      ON CONFLICT(source_id, channel_id) DO UPDATE SET watched_at = excluded.watched_at
    `).run(sourceId, channelId, watchedAt);
    database.prepare(`
      DELETE FROM iptv_recent WHERE source_id = ? AND channel_id NOT IN (
        SELECT channel_id FROM iptv_recent WHERE source_id = ? ORDER BY watched_at DESC LIMIT ?
      )
    `).run(sourceId, sourceId, MAX_IPTV_RECENT);
  })();
}
