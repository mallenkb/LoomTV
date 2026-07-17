import type React from 'react';

export type MetadataProvider = {
  id: string;
  label: string;
  description: React.ReactNode;
  placeholder: string;
  badge?: string;
  required?: boolean;
};

type LocalNetworkPairedDevice = {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  lastAddress?: string;
};

export type LocalNetworkStatus = {
  sharingEnabled: boolean;
  token: string;
  deviceId?: string;
  deviceName?: string;
  networkName: string;
  port: number;
  addresses: string[];
  baseUrl: string | null;
  libraryUrl: string | null;
  pairedDevices?: LocalNetworkPairedDevice[];
};

export type LocalNetworkPeer = {
  deviceId: string;
  deviceName: string;
  host: string;
  port: number;
  addresses: string[];
  appVersion: string;
};

export type SharedLibrarySnapshot = {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  accessTokenExpiresAt?: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
  hostDeviceId?: string;
  hostDeviceName?: string;
  connectedAt: number;
  libraryEtag?: string;
  library: {
    movies?: { title?: string; year?: number }[];
    tvShows?: { title?: string; year?: number }[];
    animeShows?: { title?: string; year?: number }[];
  };
};

export type SharedLibrarySection = {
  title: string;
  items: { title?: string; year?: number }[];
};

export type LibraryFolderSection = {
  key: 'movies' | 'tvShows' | 'anime' | 'others';
  title: string;
  description: string;
  folders: string[];
};

export type LibraryFolderStatus = {
  path: string;
  kind: LibraryFolderSection['key'];
  state: 'available' | 'unavailable';
  isNetworkLike: boolean;
  checkedAt: number;
  message: string;
};
