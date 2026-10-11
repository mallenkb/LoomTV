import { createHash } from 'node:crypto';
import type {
  StremioCatalogResult,
  StremioInstallRecord,
  StremioManifestReview,
  StremioMetaResult,
  StremioStreamResult,
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
  StremioPluginVideo,
  StremioStreamDescriptor,
  StremioStreamResult as ClientStremioStreamResult,
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
]);

const OFFICIAL_STREMIO_MANIFEST_URLS: Partial<Record<OfficialStremioAddon['id'], string>> = {
  cinemeta: 'https://v3-cinemeta.strem.io/manifest.json',
};

const OFFICIAL_STREMIO_ADDON_IDS: Partial<Record<OfficialStremioAddon['id'], OfficialStremioAddon['addonId']>> = {
  cinemeta: 'com.linvo.cinemeta',
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

/** Add-ons LoomTV embeds itself. A pasted manifest must not replace or duplicate them. */
export const EMBEDDED_STREMIO_ADDON_IDS: ReadonlySet<string> = new Set([
  'com.linvo.cinemeta',
  'org.stremio.opensubtitlesv3',
]);

/**
 * Accept the link forms Stremio shares: an HTTPS manifest URL, or the same
 * URL with the `stremio://` install scheme. Credentials in the path or query
 * are kept; the adapter validates and redacts the result.
 */
export function normalizeStremioManifestLink(value: string): string {
  const input = value.trim();
  const candidate = /^stremio:\/\//i.test(input) ? `https://${input.slice('stremio://'.length)}` : input;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new StremioManifestLinkError('This is not a valid add-on link. Paste the full manifest URL.');
  }
  if (url.protocol === 'http:') {
    throw new StremioManifestLinkError('This add-on link uses HTTP. LoomTV only installs add-ons served over HTTPS.');
  }
  if (url.protocol !== 'https:') {
    throw new StremioManifestLinkError('Paste an add-on manifest link that starts with https:// or stremio://.');
  }
  if (!/\/manifest\.json$/i.test(url.pathname)) {
    throw new StremioManifestLinkError('This link is not an add-on manifest. Manifest links end in /manifest.json.');
  }
  return url.toString();
}

export class StremioManifestLinkError extends Error {
  readonly code = 'STREMIO_PLUGIN_INVALID_MANIFEST_LINK';
  readonly retryable = false;
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

/**
 * Changes when the add-on is re-reviewed (a replaced manifest), re-approved,
 * or reconfigured. Results stamped with an older value must not be used.
 */
export function stremioSourceRevision(
  record: Pick<StremioInstallRecord, 'approvedAt' | 'reviewedAt' | 'reviewToken'>,
  configurationState?: Pick<StremioPluginConfigurationState, 'revision'>,
): string {
  // Each review issues a new token, so its digest separates two reviews that
  // share a timestamp. The digest cannot be used to approve anything.
  const review = createHash('sha256').update(record.reviewToken).digest('base64url').slice(0, 16);
  return `${review}:${record.approvedAt ?? 0}:${record.reviewedAt}:${configurationState?.revision ?? 0}`;
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
    revision: stremioSourceRevision(record, configurationState),
    resources: record.manifest.resources.map(({ name }) => name),
    types: [...record.manifest.types],
    // The adapter already applied the manifest-wide types/idPrefixes fallback.
    resourceDetails: record.manifest.resources.map(({ name, types, idPrefixes }) => ({
      name,
      types: [...types],
      idPrefixes: [...idPrefixes],
    })),
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

type StremioSourceCandidate = StremioStreamResult['sources'][number];

/** Registers a provider subtitle URL with the host and returns an opaque token for the renderer. */
export type StremioSubtitleTokenIssuer = (addonId: string, subtitle: { url: string; language: string }) => string;

export type StremioWireOptions = {
  /** `stremioSourceRevision` of the add-on when the request started. */
  sourceRevision?: string;
  subtitleToken?: StremioSubtitleTokenIssuer;
};

/** Keep each validated stream's structure so the renderer can pick the right action. */
export function stremioStreamDescriptor(source: StremioSourceCandidate, subtitleToken?: StremioSubtitleTokenIssuer): StremioStreamDescriptor {
  const transport: StremioStreamDescriptor['transport'] = source.playableByLoom && source.url
    ? source.sourceKind === 'hls' ? 'hls' : 'media'
    : source.sourceKind === 'youtube' && source.ytId ? 'youtube'
      : source.sourceKind === 'external' && source.externalUrl ? 'external'
        : source.sourceKind === 'torrent' || source.sourceKind === 'peer-to-peer' ? 'peer-to-peer'
          : 'unsupported';
  // Subtitle URLs can carry provider credentials, so only host tokens leave main.
  const subtitles = subtitleToken && (transport === 'media' || transport === 'hls')
    ? (source.subtitles || []).map(({ language, url }) => ({ language, token: subtitleToken(source.source.addonId, { url, language }) }))
    : [];
  return {
    id: source.id,
    transport,
    ...(source.name ? { name: source.name } : {}),
    ...(source.description ? { description: source.description } : {}),
    ...(transport === 'media' || transport === 'hls' ? { url: source.url } : {}),
    ...(transport === 'external' ? { externalUrl: source.externalUrl } : {}),
    ...(transport === 'youtube' ? { ytId: source.ytId } : {}),
    ...(transport === 'peer-to-peer' || transport === 'unsupported'
      ? { reason: source.reason || 'LoomTV cannot play this source type.' }
      : {}),
    ...(source.notWebReady ? { notWebReady: true } : {}),
    ...(source.requestHeadersRequired ? { requestHeadersRequired: true } : {}),
    ...(subtitles.length ? { subtitles } : {}),
  };
}

export function stremioStreamResult(result: StremioStreamResult, options: StremioWireOptions = {}): ClientStremioStreamResult {
  return {
    addonId: result.source.addonId,
    ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    streams: result.sources.map((source) => stremioStreamDescriptor(source, options.subtitleToken)),
    playableCount: result.playableCount,
    unsupportedPeerToPeerCount: result.unsupportedPeerToPeerCount,
    rejectedCount: result.rejectedCount,
  };
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * stremio-core plays `yt_id:CHANNEL_ID:VIDEO_ID` videos from the official
 * YouTube add-on with the YouTube player. Only a video listed by approved
 * metadata gets this, and only with a well-formed 11-character ID.
 */
function derivedYouTubeStreams(addonId: string, videoId: string): StremioStreamDescriptor[] | undefined {
  if (!videoId.startsWith('yt_id:')) return undefined;
  const ytId = videoId.split(':')[2];
  return ytId && YOUTUBE_VIDEO_ID.test(ytId) ? [{ id: `${addonId}:${videoId}:youtube`, transport: 'youtube', ytId }] : undefined;
}

function stremioVideos(
  addonId: string,
  item: StremioCatalogResult['items'][number],
  artworkDeliveryUrl?: ArtworkDeliveryUrl,
  subtitleToken?: StremioSubtitleTokenIssuer,
): StremioPluginVideo[] | undefined {
  if (!item.videos?.length) return undefined;
  return item.videos.map((video) => {
    const thumbnail = video.thumbnailUrl && artworkDeliveryUrl ? artworkDeliveryUrl(video.thumbnailUrl) : '';
    // Stremio semantics: a defined streams array, even an empty one, replaces
    // the stream request for this video. Absent means "ask stream add-ons".
    const streams = video.embeddedSources
      ? video.embeddedSources.map((source) => stremioStreamDescriptor(source, subtitleToken))
      : derivedYouTubeStreams(addonId, video.id);
    return {
      id: video.id,
      title: video.title,
      ...(video.available === undefined ? {} : { available: video.available }),
      ...(video.season === undefined ? {} : { season: video.season }),
      ...(video.episode === undefined ? {} : { episode: video.episode }),
      ...(video.released ? { released: video.released } : {}),
      ...(video.overview ? { overview: video.overview } : {}),
      ...(thumbnail ? { thumbnail } : {}),
      ...(streams ? { streams } : {}),
    };
  });
}

function stremioCatalogItem(
  addonId: string,
  item: StremioCatalogResult['items'][number],
  artworkDeliveryUrl?: ArtworkDeliveryUrl,
  options: StremioWireOptions = {},
): StremioPluginCatalogItem {
  const artwork = artworkReferences(item, artworkDeliveryUrl);
  const cast = castReferences(item, artworkDeliveryUrl);
  const format = item.type === 'movie' ? 'Movie' : item.type === 'series' ? 'TV' : undefined;
  const videos = stremioVideos(addonId, item, artworkDeliveryUrl, options.subtitleToken);
  return {
    id: stremioItemId(addonId, item.type, item.id),
    type: item.type,
    source: addonId,
    ...(format ? { format } : {}),
    title: item.title,
    providerId: item.id,
    ...(item.defaultVideoId ? { defaultVideoId: item.defaultVideoId } : {}),
    ...(videos ? { videos, metaSource: addonId, ...(options.sourceRevision ? { metaSourceRevision: options.sourceRevision } : {}) } : {}),
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
  options: StremioWireOptions = {},
): StremioPluginCatalogResult {
  return {
    addonId,
    type: request.type,
    catalogId: request.catalogId,
    items: result.items.map((item) => stremioCatalogItem(addonId, item, artworkDeliveryUrl, options)),
  };
}

export function stremioMetaResult(
  addonId: string,
  result: StremioMetaResult,
  artworkDeliveryUrl?: ArtworkDeliveryUrl,
  options: StremioWireOptions = {},
): StremioPluginMetaResult {
  return {
    addonId,
    ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    item: result.item ? stremioCatalogItem(addonId, result.item, artworkDeliveryUrl, options) : null,
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
