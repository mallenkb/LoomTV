import type { Connection, LibraryPayload, SavedConnection } from './mobileDomain.ts';
import { mobileLibraryFromIndex } from './mobileDomain.ts';
import type { MobileLanClient } from './mobileLanClient.ts';
import {
  mobileLibraryIndexSchema,
  mobileLibrarySchema,
  readErrorResponse,
  readJsonResponse,
} from './mobileDecoders.ts';

export type MobileCatalogFetchResult =
  | { status: 'not-modified' }
  | { status: 'unauthorized' }
  | { status: 'profile-required' }
  | {
      status: 'ok';
      library: LibraryPayload;
      etag: string;
      revision?: number;
      transport: 'compact' | 'legacy';
    };

type FetchMobileCatalogOptions = {
  etag?: string;
  onLegacyFallback?: () => void;
};

function requiresProfile(payload: { error?: string; status?: string }): boolean {
  return payload.error === 'profile_required' || payload.status === 'profile_required';
}

export async function fetchMobileCatalog(
  client: MobileLanClient,
  connection: Connection,
  options: FetchMobileCatalogOptions = {},
): Promise<MobileCatalogFetchResult> {
  const { etag = '', onLegacyFallback } = options;
  const readLegacy = async (legacyEtag = ''): Promise<MobileCatalogFetchResult> => {
    const response = await client.getLibrary(connection.baseUrl, connection.deviceToken, legacyEtag);
    if (response.status === 304) return { status: 'not-modified' };
    if (response.status === 401) return { status: 'unauthorized' };
    if (response.status === 409 && requiresProfile(await readErrorResponse(response.clone(), 'Legacy library'))) {
      return { status: 'profile-required' };
    }
    if (!response.ok) throw new Error(`Desktop sharing is unavailable (${response.status}).`);
    return {
      status: 'ok',
      library: await readJsonResponse(response, mobileLibrarySchema, 'Legacy library'),
      etag: response.headers.get('ETag') || '',
      transport: 'legacy',
    };
  };

  if (connection.catalogTransport === 'legacy') return readLegacy(etag);

  const response = await client.getLibraryIndex(connection.baseUrl, connection.deviceToken, etag);
  if (response.status === 304) return { status: 'not-modified' };
  if (response.status === 401) return { status: 'unauthorized' };
  if (response.status === 409 && requiresProfile(await readErrorResponse(response.clone(), 'Library index'))) {
    return { status: 'profile-required' };
  }

  if (response.ok) {
    const index = await readJsonResponse(response, mobileLibraryIndexSchema, 'Library index');
    return {
      status: 'ok',
      library: mobileLibraryFromIndex(index),
      etag: response.headers.get('ETag') || '',
      revision: index.revision,
      transport: 'compact',
    };
  }

  if (![403, 404, 410, 501].includes(response.status)) {
    throw new Error(`Desktop sharing is unavailable (${response.status}).`);
  }

  onLegacyFallback?.();
  return readLegacy();
}

export type MobileCatalogSyncResult =
  | { status: 'profile-initialized' }
  | { status: 'not-modified'; connection: Connection }
  | { status: 'unauthorized' }
  | { status: 'profile-required'; connection: Connection }
  | { status: 'updated'; connection: Connection; catalog: Extract<MobileCatalogFetchResult, { status: 'ok' }> };

type MobileCatalogSyncDependencies = {
  connection: Connection;
  savedConnection: SavedConnection | null;
  isServerOffline: boolean;
  refreshCredentials: (connection: SavedConnection) => Promise<SavedConnection>;
  initializeProfiles: (connection: Connection) => Promise<boolean>;
  refreshProfiles: (connection: Connection) => Promise<void>;
  fetchCatalog: (connection: Connection, etag: string) => Promise<MobileCatalogFetchResult>;
  now?: number;
};

export async function synchronizeMobileCatalog({
  connection,
  savedConnection,
  isServerOffline,
  refreshCredentials,
  initializeProfiles,
  refreshProfiles,
  fetchCatalog,
  now = Date.now(),
}: MobileCatalogSyncDependencies): Promise<MobileCatalogSyncResult> {
  let activeConnection = connection;
  let activeSavedConnection = savedConnection;

  if (activeSavedConnection && connection.accessTokenExpiresAt <= now + 60_000) {
    const refreshed = await refreshCredentials(activeSavedConnection);
    activeSavedConnection = refreshed;
    activeConnection = { ...connection, ...refreshed };
  }

  if (isServerOffline && await initializeProfiles(activeConnection)) {
    return { status: 'profile-initialized' };
  }

  const [initialCatalog] = await Promise.all([
    fetchCatalog(activeConnection, activeConnection.libraryEtag),
    refreshProfiles(activeConnection),
  ]);
  let catalog = initialCatalog;
  if (catalog.status === 'unauthorized' && activeSavedConnection) {
    const refreshed = await refreshCredentials(activeSavedConnection);
    activeConnection = { ...activeConnection, ...refreshed };
    catalog = await fetchCatalog(activeConnection, activeConnection.libraryEtag);
  }

  if (catalog.status === 'unauthorized') return { status: 'unauthorized' };
  if (catalog.status === 'profile-required') return { status: 'profile-required', connection: activeConnection };
  if (catalog.status === 'not-modified') return { status: 'not-modified', connection: activeConnection };
  return { status: 'updated', connection: activeConnection, catalog };
}
