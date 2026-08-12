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
  StremioPluginMetaResult,
  StremioPluginReview,
  StremioPluginSummary,
} from '../shared/desktopProtocol.ts';

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

export function stremioPluginSummary(record: StremioInstallRecord): StremioPluginSummary {
  return {
    addonId: record.addonId,
    name: record.manifest.name,
    version: record.manifest.version,
    description: record.manifest.description,
    manifestOrigin: record.manifestOrigin,
    manifestUrlRedacted: record.manifestUrlRedacted,
    state: record.state,
    trusted: record.trusted,
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
  };
}

export function stremioPluginReview(review: StremioManifestReview): StremioPluginReview {
  return {
    ...stremioPluginSummary(review),
    warnings: uniqueWarnings(review, review.reviewWarnings),
    reviewToken: review.reviewToken,
    approvalRequired: true,
  };
}

function stremioCatalogItem(item: StremioCatalogResult['items'][number]): StremioPluginCatalogItem {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    genres: [...item.genres],
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
): StremioPluginCatalogResult {
  return {
    addonId,
    type: request.type,
    catalogId: request.catalogId,
    items: result.items.map(stremioCatalogItem),
  };
}

export function stremioMetaResult(addonId: string, result: StremioMetaResult): StremioPluginMetaResult {
  return {
    addonId,
    item: result.item ? stremioCatalogItem(result.item) : null,
  };
}
