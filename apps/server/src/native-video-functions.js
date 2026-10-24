import path from 'node:path';
import { createHash } from 'node:crypto';

/** @typedef {{sourceIds: string[]; available: boolean}} CanonicalSourceProjection */
/** @typedef {((mediaId: string, locator?: string) => boolean) & {
 * projectSources: (mediaId: string, sourceIds: readonly string[]) => CanonicalSourceProjection
 * }} CanonicalMediaAccess */

/** Snapshot root and subfolder grants once for a catalog request.
 * @param {import('node:sqlite').DatabaseSync} database @param {string} profileId
 * @returns {CanonicalMediaAccess} */
export function createCanonicalMediaAccess(database, profileId) {
  const profile = database
    .prepare(`SELECT p.id,r.allowed_root_ids_json FROM profiles p
    LEFT JOIN profile_restrictions r ON r.profile_id=p.id WHERE p.id=?`)
    .get(profileId);
  const roots = profile?.allowed_root_ids_json ?? null;
  const hasPaths = database.prepare('SELECT 1 FROM profile_path_grants WHERE profile_id=? LIMIT 1').get(profileId);
  const unrestricted = Boolean(profile && roots === null && !hasPaths);
  /** @type {Map<string, Map<string, boolean>>} */
  const sources = new Map();
  /** @type {Map<string, Set<string>>} */
  const locators = new Map();
  if (profile)
    for (const row of database
      .prepare(`SELECT s.id,s.media_id,s.locator,s.state,json_extract(c.extension_json,'$.seriesId') series_id
    FROM media_sources s JOIN catalog_items c ON c.id=s.media_id
    WHERE (? IS NULL OR s.root_id IN (SELECT value FROM json_each(?)))
      AND (NOT EXISTS(SELECT 1 FROM profile_path_grants WHERE profile_id=?) OR EXISTS(
        SELECT 1 FROM profile_path_grants WHERE profile_id=? AND loom_contains(folder_path,s.locator)))`)
      .all(roots, roots, profileId, profileId)) {
      for (const id of [row.media_id, row.series_id]) {
        if (typeof id !== 'string') continue;
        if (!sources.has(id)) sources.set(id, new Map());
        if (!locators.has(id)) locators.set(id, new Set());
        sources.get(id)?.set(String(row.id), row.state === 'online');
        locators.get(id)?.add(path.resolve(String(row.locator)));
      }
    }
  /** @param {string} mediaId @param {string} [locator] */
  const allows = (mediaId, locator) => {
    if (unrestricted) return true;
    const paths = locators.get(mediaId);
    return Boolean(paths && (locator === undefined || paths.has(path.resolve(locator))));
  };
  /** @param {string} mediaId @param {readonly string[]} sourceIds @returns {CanonicalSourceProjection} */
  const projectSources = (mediaId, sourceIds) => {
    const candidates = sources.get(mediaId);
    const permitted = sourceIds.filter((id) => candidates?.has(id));
    return { sourceIds: permitted, available: permitted.some((id) => candidates?.get(id) === true) };
  };
  return Object.assign(allows, { projectSources });
}

/** Core and native callers enforce the same root and subfolder grants.
 * A source locator scopes episode playback to that file, rather than an allowed sibling.
 * @param {import('node:sqlite').DatabaseSync} database @param {string} profileId
 * @param {string} mediaId @param {string} [locator] */
export function profileAllowsCanonicalMedia(database, profileId, mediaId, locator) {
  const profile = database
    .prepare(`SELECT p.id,r.allowed_root_ids_json FROM profiles p
    LEFT JOIN profile_restrictions r ON r.profile_id=p.id WHERE p.id=?`)
    .get(profileId);
  if (!profile) return false;
  const roots = profile.allowed_root_ids_json ?? null;
  const hasPaths = database.prepare('SELECT 1 FROM profile_path_grants WHERE profile_id=? LIMIT 1').get(profileId);
  if (roots === null && !hasPaths) return true;
  return Boolean(
    database
      .prepare(`SELECT 1 FROM media_sources s JOIN catalog_items c ON c.id=s.media_id
    WHERE (c.id=? OR json_extract(c.extension_json,'$.seriesId')=?)
      AND (? IS NULL OR s.locator=?)
      AND (? IS NULL OR s.root_id IN (SELECT value FROM json_each(?)))
      AND (NOT EXISTS(SELECT 1 FROM profile_path_grants WHERE profile_id=?) OR EXISTS(
        SELECT 1 FROM profile_path_grants WHERE profile_id=? AND loom_contains(folder_path,s.locator))) LIMIT 1`)
      .get(mediaId, mediaId, locator ?? null, locator ?? null, roots, roots, profileId, profileId),
  );
}

/** Functions used by the native compatibility views on every SQLite connection.
 * @param {import('node:sqlite').DatabaseSync} database */
export function registerNativeVideoFunctions(database) {
  database.function('loom_root_id', { deterministic: true }, (value) =>
    createHash('sha256')
      .update(path.resolve(String(value)))
      .digest('hex')
      .slice(0, 24),
  );
  database.function(
    'loom_relative',
    { deterministic: true },
    (root, file) => path.relative(String(root), String(file)) || path.basename(String(file)),
  );
  database.function('loom_extension', { deterministic: true }, (file) =>
    path.extname(String(file)).slice(1).toLowerCase(),
  );
  database.function('loom_contains', { deterministic: true }, (root, file) => {
    const relative = path.relative(path.resolve(String(root)), path.resolve(String(file)));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      ? 1
      : 0;
  });
  database.function('loom_preferences', { deterministic: true }, (payload, direction) => {
    const parsed = JSON.parse(String(payload || '{}'));
    const pairs = [
      ['appThemeMode', 'themeMode'],
      ['appThemeColor', 'themeColor'],
      ['showProviderRatingBadges', 'showProviderRatingBadges'],
      ['sidebarNavOrder', 'sidebarNavOrder'],
      ['autoplayNextEnabled', 'autoplayNextEnabled'],
      ['playbackSkipBackSeconds', 'skipBackSeconds'],
      ['playbackSkipForwardSeconds', 'skipForwardSeconds'],
      ['playbackRewindOnResumeSeconds', 'rewindOnResumeSeconds'],
    ];
    /** @type {Record<string, unknown>} */
    const result = {};
    /** @param {string} key @param {unknown} value */
    const validSharedValue = (key, value) => {
      if (key === 'themeMode') return value === 'dark' || value === 'light';
      if (key === 'themeColor')
        return typeof value === 'string' && ['orange', 'yellow', 'red', 'blue', 'twitch'].includes(value);
      if (key === 'showProviderRatingBadges' || key === 'autoplayNextEnabled') return typeof value === 'boolean';
      if (key === 'sidebarNavOrder')
        return (
          Array.isArray(value) &&
          value.length <= 32 &&
          value.every((entry) => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 64)
        );
      if (key === 'skipBackSeconds' || key === 'skipForwardSeconds' || key === 'rewindOnResumeSeconds') {
        return (
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= (key === 'rewindOnResumeSeconds' ? 30 : 600)
        );
      }
      return false;
    };
    for (const [native, canonical] of pairs) {
      const source = direction === 'native' ? canonical : native;
      const target = direction === 'native' ? native : canonical;
      if (!Object.hasOwn(parsed, source)) continue;
      if (validSharedValue(canonical, parsed[source])) result[target] = parsed[source];
      // json_patch removes an old shared value when its native replacement is
      // UI-only, such as a sidebar order exceeding the canonical size limit.
      else if (direction === 'canonical') result[target] = null;
    }
    return JSON.stringify(result);
  });
}
