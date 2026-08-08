import type {
  StremioCatalogResult,
  StremioInstallRecord,
  StremioManifestReview,
  StremioMetaResult,
} from '@loom-media-server/plugin-protocol';
import type {
  OfficialStremioAddon,
  StremioPluginCatalogItem,
  StremioPluginCatalogRequest,
  StremioPluginCatalogResult,
  StremioPluginCastMember,
  StremioPluginIpcError,
  StremioPluginArtworkReferences,
  StremioPluginConfigurationState,
  StremioPluginMetaResult,
  StremioPluginReview,
  StremioPluginSummary,
} from '../shared/desktopProtocol.ts';

const STREMIO_ITEM_ID_PREFIX = 'loomtv-stremio-item-v1';

function encodeItemPart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeItemPart(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return decoded && encodeItemPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

export interface StremioItemIdentity {
  addonId: string;
  type: string;
  providerId: string;
}

/** Create a stable opaque key that cannot collide across add-ons or types. */
export function stremioItemId(addonId: string, type: string, providerId: string): string {
  return [STREMIO_ITEM_ID_PREFIX, addonId, type, providerId].map(encodeItemPart).join('.');
}

export function parseStremioItemId(value: unknown): StremioItemIdentity | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== encodeItemPart(STREMIO_ITEM_ID_PREFIX)) return null;
  const decoded = parts.slice(1).map(decodeItemPart);
  if (decoded.some((part): part is null => part === null)) return null;
  const [addonId, type, providerId] = decoded as [string, string, string];
  return addonId && type && providerId ? { addonId, type, providerId } : null;
}

export const OFFICIAL_STREMIO_ADDONS: readonly OfficialStremioAddon[] = Object.freeze([
  Object.freeze({
    id: 'cinemeta',
    addonId: 'com.linvo.cinemeta',
    name: 'Cinemeta',
    description: 'Stremio’s official movie and series catalogs and metadata.',
    capability: 'catalog',
  }),
  Object.freeze({
    id: 'opensubtitles-v3',
    addonId: 'org.stremio.opensubtitlesv3',
    name: 'OpenSubtitles v3',
    description: 'Stremio’s official OpenSubtitles provider. Playback integration is planned.',
    capability: 'subtitles',
  }),
]);

const OFFICIAL_STREMIO_MANIFEST_URLS: Record<OfficialStremioAddon['id'], string> = {
  cinemeta: 'https://v3-cinemeta.strem.io/manifest.json',
  'opensubtitles-v3': 'https://opensubtitles-v3.strem.io/manifest.json',
};

const OFFICIAL_STREMIO_ADDON_IDS: Record<OfficialStremioAddon['id'], OfficialStremioAddon['addonId']> = {
  cinemeta: 'com.linvo.cinemeta',
  'opensubtitles-v3': 'org.stremio.opensubtitlesv3',
};

export function officialStremioManifestUrl(id: OfficialStremioAddon['id']): string {
  const manifestUrl = OFFICIAL_STREMIO_MANIFEST_URLS[id];
  if (!manifestUrl) throw new Error('Unknown official Stremio add-on.');
  return manifestUrl;
}

export function officialStremioAddonId(id: OfficialStremioAddon['id']): OfficialStremioAddon['addonId'] {
  const addonId = OFFICIAL_STREMIO_ADDON_IDS[id];
  if (!addonId) throw new Error('Unknown official Stremio add-on.');
  return addonId;
}

function uniqueWarnings(record: StremioInstallRecord, reviewWarnings: readonly string[] = []): string[] {
  return [...new Set([
    ...record.manifest.compatibilityWarnings.map(({ message }) => message),
    ...(record.manifest.peerToPeerDeclared
      ? ['Peer-to-peer and torrent sources are visible for review but are not playable in LoomTV.']
      : []),
    ...reviewWarnings,
  ])];
}

export function stremioPluginSummary(record: StremioInstallRecord, configurationState?: StremioPluginConfigurationState): StremioPluginSummary {
  const configurationRequired = record.manifest.behaviorHints.configurationRequired
    || record.manifest.config?.some((field) => field.required) === true;
  const configuration = (record.manifest.config || []).map((field) => ({
    key: field.key,
    type: field.type,
    required: field.required,
    ...(field.title ? { title: field.title } : {}),
    ...(field.options ? { options: [...field.options] } : {}),
  }));
  return {
    addonId: record.addonId,
    name: record.manifest.name,
    version: record.manifest.version,
    description: record.manifest.description,
    manifestOrigin: record.manifestOrigin,
    manifestUrlRedacted: record.manifestUrlRedacted,
    state: record.state,
    trusted: record.trusted,
    configurationRequired,
    configuration,
    configured: configurationState?.configured ?? !configurationRequired,
    configurationRevision: configurationState?.revision ?? 0,
    resources: record.manifest.resources.map(({ name }) => name),
    types: [...record.manifest.types],
    catalogs: record.manifest.catalogs.map((catalog) => ({
      type: catalog.type,
      id: catalog.id,
      name: catalog.name,
      extra: catalog.extra.map((extra) => ({
        name: extra.name,
        isRequired: extra.isRequired,
        ...(extra.options ? { options: [...extra.options] } : {}),
        ...(extra.optionsLimit === undefined ? {} : { optionsLimit: extra.optionsLimit }),
      })),
    })),
    warnings: uniqueWarnings(record),
    reviewedAt: record.reviewedAt,
    ...(record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt }),
    failureCount: record.failureCount || 0,
    ...(record.lastFailureAt === undefined ? {} : { lastFailureAt: record.lastFailureAt }),
    ...(record.nextRetryAt === undefined ? {} : { nextRetryAt: record.nextRetryAt }),
  };
}

export function stremioPluginReview(review: StremioManifestReview, configurationState?: StremioPluginConfigurationState): StremioPluginReview {
  return {
    ...stremioPluginSummary(review, configurationState),
    warnings: uniqueWarnings(review, review.reviewWarnings),
    reviewToken: review.reviewToken,
    approvalRequired: true,
  };
}

type ArtworkDeliveryUrl = (source?: string | null) => string;

function artworkReferences(
  item: StremioCatalogResult['items'][number],
  artworkDeliveryUrl?: ArtworkDeliveryUrl,
): StremioPluginArtworkReferences | undefined {
  if (!artworkDeliveryUrl) return undefined;
  const poster = artworkDeliveryUrl(item.posterUrl);
  const background = artworkDeliveryUrl(item.backgroundUrl);
  const logo = artworkDeliveryUrl(item.logoUrl);
  if (!poster && !background && !logo) return undefined;
  return {
    ...(poster ? { poster } : {}),
    ...(background ? { background } : {}),
    ...(logo ? { logo } : {}),
  };
}

function castReferences(
  item: StremioCatalogResult['items'][number],
  artworkDeliveryUrl?: ArtworkDeliveryUrl,
): readonly StremioPluginCastMember[] | undefined {
  if (!item.cast?.length) return undefined;
  const cast = item.cast.slice(0, 32).map((person) => ({
    name: person.name,
    ...(person.character ? { character: person.character } : {}),
    ...(person.imageUrl && artworkDeliveryUrl
      ? { image: artworkDeliveryUrl(person.imageUrl) }
      : {}),
  }));
  return cast.length > 0 ? cast : undefined;
}

function stremioCatalogItem(
  addonId: string,
  item: StremioCatalogResult['items'][number],
  artworkDeliveryUrl?: ArtworkDeliveryUrl,
): StremioPluginCatalogItem {
  const artwork = artworkReferences(item, artworkDeliveryUrl);
  const cast = castReferences(item, artworkDeliveryUrl);
  return {
    id: stremioItemId(addonId, item.type, item.id),
    type: item.type,
    title: item.title,
    genres: [...item.genres],
    ...(artwork ? { artwork } : {}),
    ...(cast ? { cast } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.releaseInfo ? { releaseInfo: item.releaseInfo } : {}),
    ...(item.released ? { released: item.released } : {}),
    ...(item.rating === undefined ? {} : { rating: item.rating }),
    ...(item.runtime ? { runtime: item.runtime } : {}),
  };
}

export function stremioCatalogResult(
  addonId: string,
  request: StremioPluginCatalogRequest,
  result: StremioCatalogResult,
  artworkDeliveryUrl?: ArtworkDeliveryUrl,
): StremioPluginCatalogResult {
  return {
    addonId,
    type: request.type,
    catalogId: request.catalogId,
    items: result.items.map((item) => stremioCatalogItem(addonId, item, artworkDeliveryUrl)),
  };
}

export function stremioMetaResult(
  addonId: string,
  result: StremioMetaResult,
  artworkDeliveryUrl?: ArtworkDeliveryUrl,
): StremioPluginMetaResult {
  return {
    addonId,
    item: result.item ? stremioCatalogItem(addonId, result.item, artworkDeliveryUrl) : null,
  };
}

function boundedErrorText(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  return text
    .replace(/https?:\/\/[^\s)\]}>,]+/gi, '[redacted URL]')
    .slice(0, maxLength);
}

export function serializeStremioPluginError(error: unknown): StremioPluginIpcError {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(String(record.code || ''))
    ? String(record.code)
    : 'STREMIO_PLUGIN_REQUEST_FAILED';
  const rawIssues = Array.isArray(record.issues) ? record.issues : [];
  const issues = rawIssues.slice(0, 16).flatMap((issue) => {
    if (!issue || typeof issue !== 'object') return [];
    const candidate = issue as Record<string, unknown>;
    return [{
      path: boundedErrorText(candidate.path, '$', 160),
      code: boundedErrorText(candidate.code, 'invalid', 80),
      message: boundedErrorText(candidate.message, 'The provider request was rejected.', 320),
    }];
  });
  return {
    code,
    message: boundedErrorText(record.message, 'The Stremio add-on request failed.', 500),
    retryable: record.retryable === true,
    ...(issues.length > 0 ? { issues } : {}),
  };
}
