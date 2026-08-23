/**
 * Desktop-to-legacy projection.
 *
 * the canonical server's frozen plan builder reads legacy headless sources from a data directory and
 * accepts a `desktopState` carrier for the eight per-profile and device record sets that
 * the headless files never held. A desktop-hosted installation has neither headless file,
 * so the bridge projects the desktop database into exactly those legacy shapes first and
 * plans against the projection. Nothing in the desktop database is written to.
 *
 * Every mapping decision that loses, widens, or defers information is recorded as a
 * decision, a warning, or a conflict, and those arrays are what the operator report is
 * built from.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMediaItemId } from '@loom-media-server/media-core';
import { migrateLegacyProfileKind } from '@loom-media-server/video-contracts/server';
import { migrationError } from './errors.mjs';
import { locatorFingerprint, opaqueFingerprint } from './redaction.mjs';

/** Limits enforced by the canonical server's normalizers. Exceeding one silently discards records. */
const MAX_PROFILES = 32;
const MAX_ROOTS = 128;
const MAX_PROGRESS = 20_000 * MAX_PROFILES;

const PROFILE_LIST_KINDS = new Set(['watchlist', 'favorite', 'watched']);
const DEFAULT_DEVICE_PERMISSIONS = Object.freeze(['library.read', 'stream', 'transcode', 'downloads']);
const LEGACY_DEVICE_PERMISSIONS = new Set([...DEFAULT_DEVICE_PERMISSIONS, 'remote.access']);

/** Same construction as `rootIdFor` in the canonical server's admin service, so root IDs stay stable. */
export function rootIdFor(rootPath) {
  return createHash('sha256').update(path.resolve(rootPath)).digest('hex').slice(0, 24);
}

/**
 * Legacy desktop preference keys that have a canonical destination. `appHomeStyle`,
 * `appModernHeroMode`, `appLoaderStyle`, and `appDarkTheme` deliberately have none: they
 * describe a desktop-only shell, and the canonical `ProfilePreferences` contract does not
 * carry them.
 */
const PREFERENCE_KEY_MAP = Object.freeze({
  appThemeMode: 'themeMode',
  appThemeColor: 'themeColor',
  showProviderRatingBadges: 'showProviderRatingBadges',
  sidebarNavOrder: 'sidebarNavOrder',
  autoplayNextEnabled: 'autoplayNextEnabled',
  playbackSkipBackSeconds: 'skipBackSeconds',
  playbackSkipForwardSeconds: 'skipForwardSeconds',
});

function longestRootFor(locator, roots) {
  let best = null;
  for (const root of roots) {
    if (locator === root.path || locator.startsWith(`${root.path}${path.sep}`)) {
      if (!best || root.path.length > best.path.length) best = root;
    }
  }
  return best;
}

function artworkDigest(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const header = comma === -1 ? '' : dataUrl.slice(0, comma);
  const payload = comma === -1 ? '' : dataUrl.slice(comma + 1);
  const mimeType = /^data:([^;,]+)/.exec(header)?.[1] || 'application/octet-stream';
  const bytes = header.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(payload, 'utf8');
  return { mimeType, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength };
}

/**
 * @param {object} input
 * @param {object} input.inventory result of `readDesktopInventory`
 * @param {object} input.identity result of `resolveMediaIdentity`
 * @param {object} input.ownerAccount result of `createOwnerAccount`
 * @param {'preserve'|'revoke'} [input.sessionPolicy] desktop has no account sessions, so
 *   this only records the operator's intent in the report.
 */
export function projectDesktopState({ inventory, identity, ownerAccount, sessionPolicy = 'preserve', now = Date.now() }) {
  const decisions = [];
  const warnings = [];
  const conflicts = [];
  const note = (bucket, entry) => bucket.push(entry);

  // --- Library roots -------------------------------------------------------
  const rootsByPath = new Map();
  for (const folder of inventory.folders) {
    const resolved = path.resolve(folder.path);
    if (rootsByPath.has(resolved)) continue;
    rootsByPath.set(resolved, {
      id: rootIdFor(resolved),
      path: resolved,
      kind: ['movies', 'tvShows', 'anime', 'others'].includes(folder.kind) ? folder.kind : 'others',
      createdAt: folder.addedAt,
    });
  }
  const roots = [...rootsByPath.values()];
  if (roots.length > MAX_ROOTS) {
    throw migrationError('desktop_schema_unsupported', 'The desktop library has more roots than the canonical store accepts.', {
      rootCount: roots.length,
      limit: MAX_ROOTS,
    });
  }

  // --- Catalog -------------------------------------------------------------
  const seriesIds = new Set([
    ...inventory.episodeFiles.map((file) => file.seriesId),
    ...inventory.mediaItems
      .filter((item) => ['tv', 'tvShow', 'series', 'anime'].includes(item.type))
      .map((item) => item.id),
  ]);
  const itemsById = new Map(inventory.mediaItems.map((item) => [item.id, item]));
  const episodeByLocator = new Map();
  for (const file of inventory.episodeFiles) episodeByLocator.set(path.resolve(file.filePath), file);
  const episodeDetailByKey = new Map(
    (inventory.episodes || []).map((entry) => [`${entry.seriesId}\u0000${entry.season}\u0000${entry.episode}`, entry]),
  );
  const seasonByKey = new Map(
    (inventory.seasons || []).map((entry) => [`${entry.seriesId}\u0000${entry.season}`, entry]),
  );

  const catalog = [];
  const catalogById = new Map();
  // Current locations are authoritative and unique: `media_sources.locator` is a unique
  // column. Pre-move locations are a separate fallback index, because a reconnected file
  // can leave its old path free for a different record to occupy.
  const mediaIdByCurrentLocator = new Map();
  const mediaIdByFormerLocator = new Map();
  const mediaIdFor = (locator) => mediaIdByCurrentLocator.get(locator) ?? mediaIdByFormerLocator.get(locator);
  const outsideRoot = [];
  const duplicateLocators = [];

  for (const resolution of identity.resolutions) {
    const locator = path.resolve(resolution.locator);
    const root = longestRootFor(locator, roots);
    if (!root) {
      outsideRoot.push(resolution.mediaId);
      continue;
    }
    if (mediaIdByCurrentLocator.has(locator)) {
      duplicateLocators.push(resolution.mediaId);
      continue;
    }
    if (catalogById.has(resolution.mediaId)) {
      duplicateLocators.push(resolution.mediaId);
      continue;
    }

    const episode = episodeByLocator.get(path.resolve(resolution.originalLocator))
      || episodeByLocator.get(locator);
    const series = episode ? itemsById.get(episode.seriesId) : null;
    const item = episode ? null : itemsById.get(resolution.mediaId);
    const source = series || item;

    const entry = {
      id: resolution.mediaId,
      rootId: root.id,
      path: locator,
      relativePath: path.relative(root.path, locator) || path.basename(locator),
      type: episode ? 'tv' : 'movie',
      kind: episode ? 'episode' : 'movie',
      title: (episode?.title || item?.title || path.basename(locator)).slice(0, 500),
      extension: path.extname(locator).slice(1).toLowerCase(),
      available: resolution.state === 'online',
      indexedAt: source?.updatedAt || now,
      sourceId: `${resolution.mediaId}:primary`,
    };
    if (item && Number.isSafeInteger(item.year) && item.year > 1900 && item.year < 2200) entry.year = item.year;
    if (source?.type === 'anime') entry.animeLikely = true;
    if (episode) {
      entry.series = {
        title: (series?.title || episode.title || path.basename(path.dirname(locator))).slice(0, 500),
        season: Number.isSafeInteger(episode.season) && episode.season >= 0 ? episode.season : 1,
        episode: Number.isSafeInteger(episode.episode) && episode.episode >= 0 ? episode.episode : null,
      };
      entry.seriesId = episode.seriesId;
      entry.seasonNumber = entry.series.season;
      if (entry.series.episode !== null) entry.episodeNumber = entry.series.episode;
      if (Number.isSafeInteger(series?.year) && series.year > 1900 && series.year < 2200) entry.year = series.year;
    }

    // Fields the canonical server's admin normalizer does not claim land in `catalog_items.extension_json`,
    // which is how metadata overrides and artwork references survive the cutover.
    const metadata = {};
    if (source?.summary) metadata.summary = episode?.summary || source.summary;
    if (source?.rating) metadata.rating = source.rating;
    if (source?.genres?.length) metadata.genres = source.genres;
    if (source?.providerIds && Object.keys(source.providerIds).length) metadata.providerIds = source.providerIds;
    if (source?.providerRatings && Object.keys(source.providerRatings).length) metadata.providerRatings = source.providerRatings;
    if (source?.contentRating) metadata.contentRating = source.contentRating;
    if (source?.contentRatings && Object.keys(source.contentRatings).length) metadata.contentRatings = source.contentRatings;
    if (source?.runtime) metadata.runtime = source.runtime;
    const artwork = { ...(source?.artwork || {}), ...(episode?.artwork || {}) };
    for (const [key, value] of Object.entries(artwork)) if (!value) delete artwork[key];
    if (Object.keys(artwork).length) metadata.artwork = artwork;
    const localMetadata = episode?.localMetadata || item?.localMetadata;
    if (localMetadata) metadata.localMetadata = localMetadata;
    if (episode) {
      // Series-level records the desktop app kept in `episodes` and `seasons`. The
      // canonical catalog is per-file, so this state has no row of its own and would be
      // lost unless it travels with the episode it describes.
      const detail = episodeDetailByKey.get(`${episode.seriesId}\u0000${episode.season}\u0000${episode.episode}`);
      const season = seasonByKey.get(`${episode.seriesId}\u0000${episode.season}`);
      if (detail?.summary) metadata.summary = detail.summary;
      if (detail?.rating) metadata.episodeRating = detail.rating;
      if (detail?.airDate) metadata.airDate = detail.airDate;
      if (detail?.artwork?.still && !metadata.artwork?.still) {
        metadata.artwork = { ...(metadata.artwork || {}), still: detail.artwork.still };
      }
      if (season?.title) metadata.seasonTitle = season.title;
      if (season?.episodeCount) metadata.seasonEpisodeCount = season.episodeCount;
    } else if (item) {
      if (item.seasonCount !== null) metadata.seasonCount = item.seasonCount;
      if (item.episodeCount !== null) metadata.episodeCount = item.episodeCount;
      if (item.sizeBytes !== null) metadata.sizeBytes = item.sizeBytes;
      if (item.format) metadata.format = item.format;
    }
    if (source?.lastPlayedAt) metadata.lastPlayedAt = source.lastPlayedAt;
    if (episode) metadata.legacySeriesId = episode.seriesId;
    if (Object.keys(metadata).length) entry.legacyMetadata = metadata;

    catalog.push(entry);
    catalogById.set(entry.id, entry);
    mediaIdByCurrentLocator.set(locator, entry.id);
    const formerLocator = path.resolve(resolution.originalLocator);
    if (formerLocator !== locator) mediaIdByFormerLocator.set(formerLocator, entry.id);
  }

  // A former location only resolves when no record currently occupies it, so a moved
  // record can never steal progress or a track scope from the record that took its place.
  for (const locator of mediaIdByCurrentLocator.keys()) mediaIdByFormerLocator.delete(locator);

  // A series is a first-class canonical catalog record even though it has no file of its
  // own. Episode rows point at this ID, and series-scoped lists, artwork, and track
  // preferences can therefore survive without an unresolved opaque identifier.
  const seriesCatalogItems = [];
  for (const seriesId of [...seriesIds].sort()) {
    const item = itemsById.get(seriesId);
    if (!item) {
      note(conflicts, {
        code: 'series_catalog_record_missing',
        category: 'catalogItems',
        count: 1,
        recordIds: [seriesId],
        resolution: 'restore-series-row-and-rerun',
      });
      continue;
    }
    const episodesForSeries = catalog.filter((entry) => entry.seriesId === seriesId);
    const createdAt = episodesForSeries.reduce((value, entry) => Math.min(value, Number(entry.indexedAt) || now), Number(item.updatedAt) || now);
    const seriesItem = {
      id: seriesId,
      kind: 'series',
      title: (item.title || 'Untitled series').slice(0, 500),
      available: episodesForSeries.some((entry) => entry.available !== false),
      sourceIds: [],
      legacyIds: [],
      createdAt,
      updatedAt: Number(item.updatedAt) || now,
    };
    if (Number.isSafeInteger(item.year) && item.year > 1900 && item.year < 2200) seriesItem.year = item.year;
    if (item.type === 'anime') seriesItem.animeLikely = true;
    if (item.summary) seriesItem.summary = item.summary;
    if (item.rating) seriesItem.rating = item.rating;
    if (item.genres?.length) seriesItem.genres = item.genres;
    if (item.providerIds && Object.keys(item.providerIds).length) seriesItem.providerIds = item.providerIds;
    if (item.contentRating) seriesItem.contentRating = item.contentRating;
    if (item.contentRatings && Object.keys(item.contentRatings).length) seriesItem.contentRatings = item.contentRatings;
    if (item.providerRatings && Object.keys(item.providerRatings).length) seriesItem.providerRatings = item.providerRatings;
    if (item.runtime) seriesItem.runtime = item.runtime;
    if (item.localMetadata) seriesItem.localMetadata = item.localMetadata;
    if (item.seasonCount !== null) seriesItem.seasonCount = item.seasonCount;
    if (item.episodeCount !== null) seriesItem.episodeCount = item.episodeCount;
    if (item.format) seriesItem.format = item.format;
    const seasons = (inventory.seasons || [])
      .filter((entry) => entry.seriesId === seriesId)
      .map((entry) => ({
        number: entry.season,
        title: entry.title,
        episodeCount: entry.episodeCount,
      }))
      .sort((left, right) => left.number - right.number);
    if (seasons.length) seriesItem.seasons = seasons;
    const episodeMetadata = (inventory.episodes || [])
      .filter((entry) => entry.seriesId === seriesId)
      .map((entry) => ({
        seasonNumber: entry.season,
        episodeNumber: entry.episode,
        title: entry.title,
        summary: entry.summary,
        ...(entry.rating ? { rating: entry.rating } : {}),
        ...(entry.airDate ? { airDate: entry.airDate } : {}),
        ...(entry.artwork?.still ? { still: entry.artwork.still } : {}),
      }))
      .sort((left, right) => left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber);
    if (episodeMetadata.length) seriesItem.episodeMetadata = episodeMetadata;
    const artwork = Object.fromEntries(Object.entries(item.artwork || {}).filter(([, value]) => Boolean(value)));
    if (Object.keys(artwork).length) seriesItem.artwork = artwork;
    seriesCatalogItems.push(seriesItem);
  }
  const seriesCatalogById = new Map(seriesCatalogItems.map((item) => [item.id, item]));
  const knownCatalogIds = new Set([...catalogById.keys(), ...seriesCatalogById.keys()]);
  const unavailableCatalogItems = [];
  for (const item of inventory.mediaItems) {
    if (knownCatalogIds.has(item.id)) continue;
    const recovered = {
      id: item.id,
      kind: 'movie',
      title: (item.title || 'Unavailable video').slice(0, 500),
      available: false,
      sourceIds: [],
      legacyIds: [],
      createdAt: Number(item.updatedAt) || now,
      updatedAt: Number(item.updatedAt) || now,
    };
    if (Number.isSafeInteger(item.year) && item.year > 1900 && item.year < 2200) recovered.year = item.year;
    if (item.summary) recovered.summary = item.summary;
    if (item.rating) recovered.rating = item.rating;
    if (item.genres?.length) recovered.genres = item.genres;
    if (item.providerIds && Object.keys(item.providerIds).length) recovered.providerIds = item.providerIds;
    if (item.providerRatings && Object.keys(item.providerRatings).length) recovered.providerRatings = item.providerRatings;
    if (item.contentRating) recovered.contentRating = item.contentRating;
    if (item.contentRatings && Object.keys(item.contentRatings).length) recovered.contentRatings = item.contentRatings;
    if (item.runtime) recovered.runtime = item.runtime;
    if (item.localMetadata) recovered.localMetadata = item.localMetadata;
    const artwork = Object.fromEntries(Object.entries(item.artwork || {}).filter(([, value]) => Boolean(value)));
    if (Object.keys(artwork).length) recovered.artwork = artwork;
    unavailableCatalogItems.push(recovered);
    knownCatalogIds.add(item.id);
  }
  if (unavailableCatalogItems.length) {
    note(decisions, {
      code: 'unavailable_catalog_records_preserved',
      value: 'source-less-catalog-items',
      count: unavailableCatalogItems.length,
      detail: 'Legacy catalog records without an active file remain visible as unavailable items so lists and history can still refer to them.',
    });
  }
  const recoveredReferenceItems = [];
  const preserveReferenceItem = (mediaId, title, updatedAt) => {
    if (knownCatalogIds.has(mediaId)) return mediaId;
    recoveredReferenceItems.push({
      id: mediaId,
      kind: 'movie',
      title: (title || 'Unavailable video').slice(0, 500),
      available: false,
      sourceIds: [],
      legacyIds: [],
      createdAt: Number(updatedAt) || now,
      updatedAt: Number(updatedAt) || now,
    });
    knownCatalogIds.add(mediaId);
    return mediaId;
  };
  const orphanSeriesMetadata = [...new Set([
    ...(inventory.seasons || []).map((entry) => entry.seriesId),
    ...(inventory.episodes || []).map((entry) => entry.seriesId),
  ].filter((seriesId) => !seriesCatalogById.has(seriesId)))];
  if (orphanSeriesMetadata.length) {
    note(conflicts, {
      code: 'series_metadata_parent_unresolved',
      category: 'catalogItems',
      count: orphanSeriesMetadata.length,
      recordIds: orphanSeriesMetadata.slice(0, 16),
      resolution: 'restore-series-row-and-rerun',
    });
  }

  if (outsideRoot.length) {
    note(conflicts, {
      code: 'catalog_item_outside_root',
      category: 'library',
      count: outsideRoot.length,
      recordIds: outsideRoot.slice(0, 16),
      resolution: 'excluded-add-root-and-rerun',
      detail: 'These records sit outside every configured library root. The canonical store cannot hold a source without a root.',
    });
  }
  if (duplicateLocators.length) {
    note(conflicts, {
      code: 'duplicate_media_locator',
      category: 'library',
      count: duplicateLocators.length,
      recordIds: duplicateLocators.slice(0, 16),
      resolution: 'first-record-kept',
      detail: 'More than one legacy record claims one file. The canonical store holds one source per locator.',
    });
  }

  // --- Artwork overrides ---------------------------------------------------
  const artworkArtifacts = [];
  const unresolvedArtwork = [];
  for (const entry of inventory.customArtwork) {
    const target = catalogById.get(entry.mediaId) || seriesCatalogById.get(entry.mediaId);
    const digest = artworkDigest(entry.dataUrl);
    if (!digest.byteLength) continue;
    artworkArtifacts.push({
      sha256: digest.sha256,
      byteLength: digest.byteLength,
      mimeType: digest.mimeType,
      bytes: digest.bytes,
      legacyMediaId: entry.mediaId,
      target: entry.target,
      updatedAt: entry.updatedAt,
      resolved: Boolean(target),
    });
    if (!target) {
      unresolvedArtwork.push(entry.mediaId);
      continue;
    }
    const metadataTarget = catalogById.has(entry.mediaId)
      ? (target.legacyMetadata ||= {})
      : target;
    metadataTarget.customArtwork ||= [];
    metadataTarget.customArtwork.push({
      target: entry.target,
      sha256: digest.sha256,
      byteLength: digest.byteLength,
      mimeType: digest.mimeType,
      updatedAt: entry.updatedAt,
    });
  }
  if (unresolvedArtwork.length) {
    note(warnings, {
      code: 'artwork_series_scope_unresolved',
      category: 'library',
      count: unresolvedArtwork.length,
      recordIds: [...new Set(unresolvedArtwork)].slice(0, 16),
      detail: 'Custom artwork attached to a series has no canonical item to attach to. The bytes are exported to the migration bundle.',
    });
  }

  // --- Accounts, profiles, credentials -------------------------------------
  if (inventory.profiles.length > MAX_PROFILES) {
    throw migrationError('desktop_schema_unsupported', 'The desktop database holds more profiles than the canonical store accepts.', {
      profileCount: inventory.profiles.length,
      limit: MAX_PROFILES,
    });
  }
  if (!inventory.profiles.length) {
    throw migrationError('desktop_owner_profile_missing', 'The desktop database has no profiles to migrate.');
  }

  const profiles = [];
  const profileCredentials = [];
  for (const profile of inventory.profiles) {
    let kind;
    try {
      // Fail closed. the canonical server's helper throws `unknown_profile_kind` rather than defaulting,
      // and a guessed kind would hand a child profile adult access.
      kind = migrateLegacyProfileKind(profile.isGuest ? 'guest' : profile.profileType);
    } catch (error) {
      throw migrationError('unknown_profile_kind', 'A desktop profile has a kind with no canonical mapping.', {
        recordId: profile.id,
        legacyKind: opaqueFingerprint(profile.profileType),
        cause: error?.code || 'unknown_profile_kind',
      });
    }
    profiles.push({
      id: profile.id,
      name: profile.name,
      kind,
      avatarKey: profile.avatarKey,
      colorKey: profile.colorKey,
      hasPin: Boolean(profile.pinHash && profile.pinSalt),
      sortOrder: profile.sortOrder,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      ...(profile.lastUsedAt === null ? {} : { lastUsedAt: profile.lastUsedAt }),
      ...(profile.guestDeviceId ? { guestDeviceId: profile.guestDeviceId } : {}),
      // the canonical server's client normalizer turns `ownerId` into the required `manage` assignment.
      ownerId: ownerAccount.id,
    });
    if (profile.pinHash && profile.pinSalt) {
      profileCredentials.push({
        profileId: profile.id,
        pinHash: profile.pinHash,
        pinSalt: profile.pinSalt,
        pinAlgorithm: 'scrypt',
        updatedAt: profile.updatedAt,
      });
    }
  }
  const profileIds = new Set(profiles.map((profile) => profile.id));

  note(decisions, {
    code: 'owner_account_synthesized',
    value: 'operator-supplied-credential',
    detail: 'The desktop app has no account model. One owner account is created from the credential the operator supplied at migration time.',
  });
  note(decisions, {
    code: 'legacy_profile_kinds_mapped',
    value: 'owner-standard-to-adult-kid-to-child-guest-to-guest',
    count: profiles.length,
  });
  if (profileCredentials.length) {
    note(decisions, {
      code: 'profile_pins_preserved',
      value: 'scrypt-carried',
      count: profileCredentials.length,
    });
  }

  // --- Devices -------------------------------------------------------------
  const pairedDevices = Array.isArray(inventory.settings?.localNetworkPairedDevices)
    ? inventory.settings.localNetworkPairedDevices
    : [];
  const devices = [];
  const deviceCredentials = [];
  const deviceIds = new Set();
  let expiredDevices = 0;
  for (const device of pairedDevices) {
    if (!device || typeof device.id !== 'string' || !device.id) continue;
    if (deviceIds.has(device.id)) continue;
    const expiresAt = Number(device.refreshTokenExpiresAt);
    const secretHash = typeof device.refreshTokenHash === 'string' ? device.refreshTokenHash : '';
    const credentialValid = Number.isFinite(expiresAt) && expiresAt > now && Boolean(secretHash);
    const expired = !credentialValid;
    const requestedPermissions = Array.isArray(device.permissions)
      ? device.permissions
      : Array.isArray(device.scopes) ? device.scopes : DEFAULT_DEVICE_PERMISSIONS;
    const permissions = [...new Set(requestedPermissions.filter((permission) => LEGACY_DEVICE_PERMISSIONS.has(permission)))];
    if (expired) expiredDevices += 1;
    deviceIds.add(device.id);
    devices.push({
      id: device.id,
      accountId: ownerAccount.id,
      name: String(device.name || 'Paired device').slice(0, 120),
      kind: 'lan-client',
      disabled: expired,
      permissions,
      createdAt: Number(device.createdAt) || now,
      updatedAt: Number(device.lastSeenAt) || Number(device.createdAt) || now,
      lastSeenAt: Number(device.lastSeenAt) || null,
    });
    if (credentialValid) {
      deviceCredentials.push({
        deviceId: device.id,
        secretHash,
        algorithm: 'sha256',
        createdAt: Number(device.createdAt) || now,
        expiresAt,
        updatedAt: Number(device.lastSeenAt) || Number(device.createdAt) || now,
      });
    }
  }
  if (expiredDevices) {
    note(decisions, {
      code: 'expired_paired_devices_disabled',
      value: 'credential-dropped-pairing-required',
      count: expiredDevices,
      detail: 'Paired devices whose refresh window had already closed are imported disabled and without a credential, so they must pair again.',
    });
  }

  // A guest profile carries a foreign key to its device. A guest whose device record was
  // pruned from settings would fail the canonical foreign-key check, so the device record
  // is repaired as a disabled placeholder rather than dropping the guest profile.
  let repairedDevices = 0;
  for (const profile of profiles) {
    if (!profile.guestDeviceId) continue;
    if (deviceIds.has(profile.guestDeviceId)) continue;
    deviceIds.add(profile.guestDeviceId);
    repairedDevices += 1;
    devices.push({
      id: profile.guestDeviceId,
      accountId: ownerAccount.id,
      name: 'Recovered guest device',
      kind: 'unknown',
      disabled: true,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      lastSeenAt: null,
    });
  }
  if (repairedDevices) {
    note(decisions, {
      code: 'guest_device_records_repaired',
      value: 'disabled-placeholder',
      count: repairedDevices,
      detail: 'Guest profiles referenced devices that settings no longer held. A disabled device record keeps the guest profile intact.',
    });
  }

  // --- Profile selections --------------------------------------------------
  const selections = [];
  const selectionDevices = new Set();
  let orphanSelections = 0;
  let unknownSelectionDevices = 0;
  for (const selection of inventory.selections) {
    if (selection.profileId && !profileIds.has(selection.profileId)) {
      orphanSelections += 1;
      continue;
    }
    if (selectionDevices.has(selection.deviceId)) continue;
    selectionDevices.add(selection.deviceId);
    if (!deviceIds.has(selection.deviceId)) {
      unknownSelectionDevices += 1;
      deviceIds.add(selection.deviceId);
      devices.push({
        id: selection.deviceId,
        accountId: ownerAccount.id,
        name: 'Recovered selection device',
        kind: 'unknown',
        disabled: true,
        createdAt: selection.selectedAt,
        updatedAt: selection.selectedAt,
        lastSeenAt: null,
      });
    }
    selections.push({
      accountId: ownerAccount.id,
      deviceId: selection.deviceId,
      profileId: selection.profileId,
      revision: selection.revision,
      automaticSignIn: selection.automaticSignIn,
      selectedAt: selection.selectedAt,
    });
  }
  if (orphanSelections) {
    note(warnings, {
      code: 'selection_profile_missing',
      category: 'profiles',
      count: orphanSelections,
      detail: 'Device selections pointed at profiles that no longer exist and were dropped.',
    });
  }
  if (unknownSelectionDevices) {
    note(warnings, {
      code: 'selection_device_unpaired',
      category: 'devices',
      count: unknownSelectionDevices,
      detail: 'Device selections referenced devices that were never paired over the local network. Disabled placeholders preserve the selections without creating usable credentials.',
    });
  }

  // --- Progress ------------------------------------------------------------
  const progressByKey = new Map();
  let recoveredProgress = 0;
  let orphanProgress = 0;
  let mergedProgress = 0;
  for (const entry of inventory.progress) {
    if (!profileIds.has(entry.profileId)) {
      orphanProgress += 1;
      continue;
    }
    const resolvedPath = path.resolve(entry.filePath);
    let mediaId = mediaIdFor(resolvedPath);
    if (!mediaId) {
      mediaId = preserveReferenceItem(
        createMediaItemId(resolvedPath),
        path.basename(resolvedPath, path.extname(resolvedPath)),
        entry.updatedAt,
      );
      recoveredProgress += 1;
    }
    const key = `${entry.profileId}\u0000${mediaId}`;
    const existing = progressByKey.get(key);
    if (existing) {
      mergedProgress += 1;
      if (existing.updatedAt >= entry.updatedAt) continue;
    }
    progressByKey.set(key, {
      profileId: entry.profileId,
      mediaId,
      positionSeconds: entry.positionSeconds,
      durationSeconds: entry.durationSeconds,
      watched: entry.watched,
      updatedAt: entry.updatedAt,
    });
  }
  const progress = [...progressByKey.values()];
  if (progress.length > MAX_PROGRESS) {
    throw migrationError('desktop_schema_unsupported', 'The desktop database holds more progress rows than the canonical store accepts.', {
      progressCount: progress.length,
      limit: MAX_PROGRESS,
    });
  }
  note(decisions, {
    code: 'progress_resolved_to_media_ids',
    value: 'file-path-keys-retired',
    count: progress.length,
    detail: 'Desktop progress is keyed by profile and file path. Every row is resolved to a canonical media ID before it is written.',
  });
  if (recoveredProgress) {
    note(decisions, {
      code: 'progress_media_recovered',
      value: 'unavailable-catalog-placeholder',
      count: recoveredProgress,
      detail: 'Progress for files no longer present in a library root now points at an unavailable catalog item instead of being discarded.',
    });
  }
  if (orphanProgress) {
    note(warnings, { code: 'progress_profile_missing', category: 'progress', count: orphanProgress });
  }
  if (mergedProgress) {
    note(warnings, {
      code: 'progress_rows_merged',
      category: 'progress',
      count: mergedProgress,
      detail: 'Two file paths resolved to one canonical media ID. The most recently updated row was kept.',
    });
  }

  // --- Lists ---------------------------------------------------------------
  const listByKey = new Map();
  let recoveredListEntries = 0;
  let droppedListEntries = 0;
  for (const entry of inventory.mediaLists) {
    if (!profileIds.has(entry.profileId) || !PROFILE_LIST_KINDS.has(entry.kind)) {
      droppedListEntries += 1;
      continue;
    }
    if (!knownCatalogIds.has(entry.mediaId)) {
      preserveReferenceItem(entry.mediaId, 'Unavailable video', entry.createdAt);
      recoveredListEntries += 1;
    }
    const key = `${entry.profileId}\u0000${entry.mediaId}\u0000${entry.kind}`;
    if (listByKey.has(key)) continue;
    listByKey.set(key, {
      profileId: entry.profileId,
      mediaId: entry.mediaId,
      kind: entry.kind,
      createdAt: entry.createdAt,
    });
  }
  const profileListEntries = [...listByKey.values()];
  if (recoveredListEntries) {
    note(decisions, {
      code: 'list_entry_media_recovered',
      value: 'unavailable-catalog-placeholder',
      count: recoveredListEntries,
      detail: 'List entries whose old catalog row was removed now point at an unavailable catalog item instead of being discarded.',
    });
  }
  if (droppedListEntries) {
    note(warnings, { code: 'list_entry_invalid', category: 'lists', count: droppedListEntries });
  }

  // --- Preferences ---------------------------------------------------------
  const profilePreferences = [];
  const unmappedPreferenceKeys = new Set();
  for (const entry of inventory.preferences) {
    if (!profileIds.has(entry.profileId)) continue;
    const preferences = {};
    for (const [key, value] of Object.entries(entry.preferences || {})) {
      if (value === undefined || value === null) continue;
      const destination = PREFERENCE_KEY_MAP[key];
      if (!destination) {
        unmappedPreferenceKeys.add(key);
        continue;
      }
      preferences[destination] = value;
    }
    profilePreferences.push({ profileId: entry.profileId, preferences, updatedAt: entry.updatedAt });
  }
  if (unmappedPreferenceKeys.size) {
    note(warnings, {
      code: 'preference_key_unmapped',
      category: 'preferences',
      count: unmappedPreferenceKeys.size,
      keys: [...unmappedPreferenceKeys].sort(),
      detail: 'These desktop preference keys describe the desktop shell and have no canonical ProfilePreferences destination.',
    });
  }

  // --- Restrictions --------------------------------------------------------
  const accessByProfile = new Map();
  for (const grant of inventory.libraryAccess) {
    if (!profileIds.has(grant.profileId)) continue;
    if (!accessByProfile.has(grant.profileId)) accessByProfile.set(grant.profileId, []);
    accessByProfile.get(grant.profileId).push(path.resolve(grant.folderPath));
  }
  const restrictionsByProfile = new Map(inventory.restrictions.map((entry) => [entry.profileId, entry]));
  const profileRestrictions = [];
  for (const profileId of new Set([...restrictionsByProfile.keys(), ...accessByProfile.keys()])) {
    if (!profileIds.has(profileId)) continue;
    const record = restrictionsByProfile.get(profileId);
    profileRestrictions.push({
      profileId,
      country: record?.country || 'US',
      maximumAge: record?.maximumAge ?? null,
      allowUnrated: record?.allowUnrated === true,
      revision: record?.revision || 0,
      // Passed through to the canonical server's `mapLegacyAllowedFolders`, which is the frozen owner of
      // the inversion: desktop `[]` means every folder, canonical `null` means every root.
      allowedFolders: accessByProfile.get(profileId) || [],
    });
  }
  const emptyGrantProfiles = profileRestrictions.filter((entry) => entry.allowedFolders.length === 0).length;
  if (emptyGrantProfiles) {
    note(decisions, {
      code: 'empty_library_grants_map_to_all_roots',
      value: 'allowedRootIds-null',
      count: emptyGrantProfiles,
      detail: 'Desktop treats an empty grant list as full library access. Copying it as an empty array would revoke the whole library.',
    });
  }

  // --- Track preferences ---------------------------------------------------
  const trackByKey = new Map();
  let unresolvedTrackScopes = 0;
  let mergedTrackScopes = 0;
  let droppedTrackScopes = 0;
  for (const entry of inventory.trackPreferences) {
    if (!profileIds.has(entry.profileId)) {
      droppedTrackScopes += 1;
      continue;
    }
    let scope = null;
    if (entry.scope === 'player:defaults') {
      scope = entry.scope;
    } else if (entry.scope.startsWith('media:')) {
      const legacyId = entry.scope.slice('media:'.length);
      scope = knownCatalogIds.has(legacyId) ? `media:${legacyId}` : null;
    } else if (entry.scope.startsWith('file:')) {
      // A `file:` scope embeds a raw locator. It is resolved to a media ID or dropped;
      // it is never written through, because scopes reach clients.
      const mediaId = mediaIdFor(path.resolve(entry.scope.slice('file:'.length)));
      scope = mediaId ? `media:${mediaId}` : null;
    }
    if (!scope) {
      unresolvedTrackScopes += 1;
      continue;
    }
    const key = `${entry.profileId}\u0000${scope}`;
    const existing = trackByKey.get(key);
    if (existing) {
      mergedTrackScopes += 1;
      if (existing.updatedAt >= entry.updatedAt) continue;
    }
    trackByKey.set(key, {
      profileId: entry.profileId,
      scope,
      preferences: entry.preferences,
      updatedAt: entry.updatedAt,
    });
  }
  const trackPreferences = [...trackByKey.values()];
  note(decisions, {
    code: 'track_preference_scopes_resolved',
    value: 'file-scopes-retired',
    count: trackPreferences.length,
    detail: 'Desktop stores track preferences under a raw file path scope. Those scopes are resolved to media scopes so no locator reaches a client.',
  });
  if (unresolvedTrackScopes) {
    note(conflicts, {
      code: 'track_preference_scope_unresolved',
      category: 'preferences',
      count: unresolvedTrackScopes,
      resolution: 'dropped',
      detail: 'These scopes named a file or a series with no canonical media ID. Keeping them would leak a locator or point at nothing.',
    });
  }
  if (mergedTrackScopes) {
    note(warnings, { code: 'track_preference_scopes_merged', category: 'preferences', count: mergedTrackScopes });
  }
  if (droppedTrackScopes) {
    note(warnings, { code: 'track_preference_profile_missing', category: 'preferences', count: droppedTrackScopes });
  }

  // --- Sessions ------------------------------------------------------------
  note(decisions, {
    code: 'account_sessions',
    value: sessionPolicy === 'revoke' ? 'revoked' : 'none-to-preserve',
    count: 0,
    detail: 'The desktop app authenticates with local-network pairing, not account sessions. The canonical server starts with no live session.',
  });

  // --- Out-of-scope desktop state -----------------------------------------
  const outOfScope = Object.entries(inventory.outOfScope).filter(([, count]) => count > 0);
  if (outOfScope.length) {
    note(warnings, {
      code: 'desktop_state_outside_video_scope',
      category: 'scope',
      count: outOfScope.reduce((total, [, count]) => total + count, 0),
      records: Object.fromEntries(outOfScope),
      detail: 'Plugin, secret, and skip-segment state stays in the desktop database. It has no canonical destination in the video program.',
    });
  }

  const adminState = {
    owner: { id: ownerAccount.id, name: ownerAccount.name, salt: ownerAccount.salt, hash: ownerAccount.hash },
    users: [],
    sessions: [],
    loginAttempts: [],
    roots,
    catalog: [],
    profiles: [],
    watchState: {},
    logs: [],
  };

  const projectedCatalogItems = [
    ...seriesCatalogItems,
    ...unavailableCatalogItems,
    ...recoveredReferenceItems,
    ...catalog.map((entry) => {
      const metadata = entry.legacyMetadata || {};
      return {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        ...(entry.year === undefined ? {} : { year: entry.year }),
        ...(entry.seriesId ? { seriesId: entry.seriesId } : {}),
        ...(entry.seasonNumber === undefined ? {} : { seasonNumber: entry.seasonNumber }),
        ...(entry.episodeNumber === undefined ? {} : { episodeNumber: entry.episodeNumber }),
        ...(entry.animeLikely === true ? { animeLikely: true } : {}),
        available: entry.available !== false,
        sourceIds: [entry.sourceId],
        legacyIds: [],
        ...(metadata.artwork ? { artwork: metadata.artwork } : {}),
        ...(metadata.summary ? { summary: metadata.summary } : {}),
        ...(metadata.rating ? { rating: metadata.rating } : {}),
        ...(metadata.genres ? { genres: metadata.genres } : {}),
        ...(metadata.providerIds ? { providerIds: metadata.providerIds } : {}),
        ...(metadata.providerRatings ? { providerRatings: metadata.providerRatings } : {}),
        ...(metadata.contentRating ? { contentRating: metadata.contentRating } : {}),
        ...(metadata.contentRatings ? { contentRatings: metadata.contentRatings } : {}),
        ...(metadata.runtime ? { runtime: metadata.runtime } : {}),
        ...(metadata.localMetadata ? { localMetadata: metadata.localMetadata } : {}),
        ...(metadata.seasonCount === undefined ? {} : { seasonCount: metadata.seasonCount }),
        ...(metadata.episodeCount === undefined ? {} : { episodeCount: metadata.episodeCount }),
        ...(metadata.format ? { format: metadata.format } : {}),
        createdAt: entry.indexedAt,
        updatedAt: entry.indexedAt,
      };
    }),
  ];
  const projectedMediaSources = catalog.map((entry) => ({
    id: entry.sourceId,
    mediaId: entry.id,
    rootId: entry.rootId,
    relativePath: entry.relativePath,
    locator: entry.path,
    state: entry.available === false ? 'offline' : 'online',
    fileExtension: entry.extension || undefined,
    sizeBytes: entry.legacyMetadata?.sizeBytes ?? undefined,
    indexedAt: entry.indexedAt,
    lastSeenAt: entry.available === false ? undefined : entry.indexedAt,
  }));

  // Every projected record travels in one `DesktopCanonicalProjection`. the canonical server's plan builder
  // normalizes `adminState` and the per-profile carriers together, so nothing is written to
  // an intermediate legacy file and no record can be counted twice.
  const sourceIdFor = (mediaId) => `${mediaId}:primary`;
  const mediaIdentityEvidence = [];
  const seenEvidence = new Set();
  for (const entry of identity.evidence) {
    if (!catalogById.has(entry.legacyMediaId)) continue;
    const sourceId = sourceIdFor(entry.legacyMediaId);
    const key = `${sourceId}\u0000${entry.kind}\u0000${entry.value}`;
    if (seenEvidence.has(key)) continue;
    seenEvidence.add(key);
    mediaIdentityEvidence.push({ sourceId, kind: entry.kind, value: entry.value, observedAt: entry.observedAt });
  }
  if (mediaIdentityEvidence.length) {
    note(decisions, {
      code: 'identity_evidence_carried',
      value: 'content-sha256-filesystem-id-quick-hash',
      count: mediaIdentityEvidence.length,
      detail: 'Strong identity evidence is written to the canonical store so a later move can be repaired without a rescan.',
    });
  }

  const desktopState = {
    adminState,
    profiles,
    // Stated explicitly rather than left for the normalizer to infer from `ownerId`.
    // An inferred assignment has no source record to reconcile against, and the canonical
    // importer rejects a category whose imported count exceeds its source count.
    profileAssignments: profiles.map((profile) => ({
      profileId: profile.id,
      accountId: ownerAccount.id,
      access: 'manage',
      createdAt: profile.createdAt,
    })),
    profileSelections: selections,
    progress,
    history: [],
    profileCredentials,
    profilePreferences,
    profileRestrictions,
    profileListEntries,
    trackPreferences,
    catalogItems: projectedCatalogItems,
    mediaSources: projectedMediaSources,
    mediaIdentityAliases: identity.aliases.filter((alias) => catalogById.has(alias.mediaId)),
    mediaIdentityEvidence,
    devices,
    deviceCredentials,
  };

  return {
    desktopState,
    artworkArtifacts,
    decisions,
    warnings,
    conflicts,
    summary: {
      roots: roots.length,
      catalogItems: projectedCatalogItems.length,
      profiles: profiles.length,
      devices: devices.length,
      progress: progress.length,
      listEntries: profileListEntries.length,
      trackPreferences: trackPreferences.length,
      identity: identity.counts,
      rootFingerprints: roots.map((root) => ({ rootId: root.id, locatorFingerprint: locatorFingerprint(root.path), kind: root.kind })),
    },
  };
}
