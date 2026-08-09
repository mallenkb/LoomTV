import type { MediaItem } from './metadata/types.ts';
import type { ScanFolderKind } from './libraryScanner.ts';
import type {
  LibraryFolderGroups as WireLibraryFolderGroups,
  LibraryFolderKind as WireLibraryFolderKind,
  LibraryFolderStatus as WireLibraryFolderStatus,
  LibraryScanMode as WireLibraryScanMode,
  SettingsPayload,
} from '../shared/desktopProtocol.ts';

export type LibraryFolderKind = WireLibraryFolderKind;
export type ScanCacheFolderKind = ScanFolderKind | 'auto';
export type LibraryScanMode = WireLibraryScanMode;

export type LibraryFolderGroups = WireLibraryFolderGroups;

export type LibraryFolderStatus = WireLibraryFolderStatus;

export interface ScanCacheEntry {
  version?: number;
  folderKind: ScanCacheFolderKind;
  signature: string;
  subtitleProfile?: string;
  fileCount: number;
  itemCount: number;
  scannedAt: number;
  ratingsRefreshedAt?: number;
}

export type LibraryScanCache = Record<string, ScanCacheEntry>;

export interface LibraryData {
  movies: MediaItem[];
  tvShows: MediaItem[];
  animeShows: MediaItem[];
  libraryFolders: string[];
  libraryFolderGroups?: LibraryFolderGroups;
  libraryFolderStatuses?: LibraryFolderStatus[];
  scanCache?: LibraryScanCache;
}

export type LibraryScanProgress = LibraryData & {
  isComplete: boolean;
  scannedFolders: number;
  totalFolders: number;
};

export type LanPairedDevice = {
  id: string;
  name: string;
  accessTokenHash: string;
  accessTokenExpiresAt: number;
  refreshTokenHash: string;
  refreshTokenExpiresAt: number;
  scopes: Array<'catalog:read' | 'media:stream' | 'playback:write'>;
  securityEpoch: 2;
  createdAt: number;
  lastSeenAt: number;
  lastAddress?: string;
};

export interface AppSettings extends SettingsPayload {
  /** Main-process-only optional external mpv path; never accepted from generic renderer settings writes. */
  mpvExecutablePath?: string;
  localNetworkDeviceId?: string;
  localNetworkDeviceName?: string;
  localNetworkHmacSecret?: string;
  localNetworkPairedDevices?: LanPairedDevice[];
  localNetworkSecurityEpoch?: number;
}
