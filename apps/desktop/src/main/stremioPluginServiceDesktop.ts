import type { StremioFetchImplementation } from '@loom-media-server/plugin-protocol';
import {
  getProfile,
  getStremioAddonConfiguration,
  getStremioAddonConfigurationState,
  isStremioAddonConfigured,
  listStremioPluginAudit,
  hasProfileStremioAccess,
  listProfileStremioAccess,
  loadStremioAddonState,
  saveStremioAddonState,
  saveStremioAddonConfiguration,
  recordStremioPluginAudit,
  setProfileStremioAccess,
} from './database.ts';
import {
  getDesktopActiveProfileState,
  requireDesktopProfileId,
  requireOwner,
} from './profileService.ts';
import { safeFetch } from './safeFetch.ts';
import {
  createStremioPluginService,
  StremioPluginServiceError,
  type StremioPluginService,
} from './stremioPluginService.ts';

const OUTER_PROVIDER_RESPONSE_LIMIT = 4 * 1024 * 1024;

const desktopSafeFetch: StremioFetchImplementation = async (url, init) => {
  const requestInit = init && typeof init === 'object' ? init as RequestInit : {};
  const requestUrl = new URL(url);
  const isOfficialCinemetaCatalog = requestUrl.hostname === 'v3-cinemeta.strem.io'
    && requestUrl.pathname.startsWith('/catalog/');
  return safeFetch(url, requestInit, {
    timeoutMs: 30_000,
    maxBytes: OUTER_PROVIDER_RESPONSE_LIMIT,
    retries: 0,
    // Official Cinemeta catalogs currently use one HTTPS redirect. safeFetch
    // validates the destination before following it; every other provider
    // resource remains redirect-free until an origin-specific policy exists.
    maxRedirects: isOfficialCinemetaCatalog ? 1 : 0,
  });
};

export type DesktopStremioPluginServiceOptions = {
  fetchImpl?: StremioFetchImplementation;
  maxConcurrentProviderRequests?: number;
  maxQueuedProviderRequests?: number;
};

export function createDesktopStremioPluginService(
  options: DesktopStremioPluginServiceOptions = {},
): StremioPluginService {
  return createStremioPluginService({
    loadState: loadStremioAddonState,
    saveState: saveStremioAddonState,
    getProfile,
    listProfileAccess: listProfileStremioAccess,
    hasProfileAccess: hasProfileStremioAccess,
    setProfileAccess: setProfileStremioAccess,
    authorizeManagement: requireOwner,
    captureProfileAuthorization: (profileId) => {
      requireDesktopProfileId(profileId);
      return getDesktopActiveProfileState().selectionRevision;
    },
    validateProfileAuthorization: (profileId, selectionRevision) => {
      const active = getDesktopActiveProfileState();
      if (active.profileId !== profileId || active.selectionRevision !== selectionRevision) {
        throw new StremioPluginServiceError(
          'STREMIO_PLUGIN_RESULT_STALE',
          'The active profile changed while this add-on request was running.',
          true,
        );
      }
    },
    isAddonConfigured: (record) => {
      const fields = record.manifest.config || [];
      if (record.manifest.behaviorHints.configurationRequired && fields.length === 0) return false;
      return isStremioAddonConfigured(record.addonId, fields.filter((field) => field.required).map((field) => field.key));
    },
    getAddonConfiguration: getStremioAddonConfiguration,
    getAddonConfigurationState: getStremioAddonConfigurationState,
    saveAddonConfiguration: saveStremioAddonConfiguration,
    recordAudit: recordStremioPluginAudit,
    listAudit: listStremioPluginAudit,
    fetchImpl: options.fetchImpl || desktopSafeFetch,
    maxConcurrentProviderRequests: options.maxConcurrentProviderRequests,
    maxQueuedProviderRequests: options.maxQueuedProviderRequests,
  });
}
