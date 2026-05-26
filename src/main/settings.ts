import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { app } from 'electron';
import { loadSettingsFromDatabase, saveSettingsToDatabase } from './database';
import { normalizeProviderId } from './metadataKeys';
import type { AppSettings, LanPairedDevice } from '../main';

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const METADATA_KEY_ALIASES: Record<string, keyof Pick<AppSettings, 'omdbApiKey' | 'tmdbApiKey'>> = {
  omdb: 'omdbApiKey',
  tmdb: 'tmdbApiKey',
};

export function createLanShareCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function normalizeSettings(raw: AppSettings): AppSettings {
  const metadataApiKeys: Record<string, string> = {};
  const rawKeys = raw.metadataApiKeys || {};
  const autoSyncIntervalHours = Number(raw.autoSyncIntervalHours);
  const defaultSidebarNavOrder = ['anime', 'tv', 'movies', 'others'];
  const rawSidebarNavOrder = Array.isArray(raw.sidebarNavOrder) ? raw.sidebarNavOrder : [];
  const sidebarNavOrder = [
    ...rawSidebarNavOrder.filter((item) => defaultSidebarNavOrder.includes(item)),
    ...defaultSidebarNavOrder.filter((item) => !rawSidebarNavOrder.includes(item)),
  ];

  for (const [provider, value] of Object.entries(rawKeys)) {
    const providerId = normalizeProviderId(provider);
    const apiKey = typeof value === 'string' ? value.trim() : '';
    if (providerId && apiKey) metadataApiKeys[providerId] = apiKey;
  }

  if (raw.omdbApiKey?.trim()) metadataApiKeys.omdb = raw.omdbApiKey.trim();
  if (raw.tmdbApiKey?.trim()) metadataApiKeys.tmdb = raw.tmdbApiKey.trim();

  return {
    ...raw,
    omdbApiKey: metadataApiKeys.omdb || '',
    tmdbApiKey: metadataApiKeys.tmdb || '',
    metadataApiKeys,
    autoSyncIntervalHours: Number.isFinite(autoSyncIntervalHours) && autoSyncIntervalHours > 0
      ? autoSyncIntervalHours
      : 12,
    playbackSkipBackSeconds: Number.isFinite(Number(raw.playbackSkipBackSeconds)) && Number(raw.playbackSkipBackSeconds) > 0
      ? Number(raw.playbackSkipBackSeconds)
      : 10,
    playbackSkipForwardSeconds: Number.isFinite(Number(raw.playbackSkipForwardSeconds)) && Number(raw.playbackSkipForwardSeconds) > 0
      ? Number(raw.playbackSkipForwardSeconds)
      : 15,
    sidebarNavOrder,
    appThemeMode: 'dark',
    appThemeColor: raw.appThemeColor === 'yellow' || raw.appThemeColor === 'red' || raw.appThemeColor === 'blue' || raw.appThemeColor === 'orange'
      ? raw.appThemeColor
      : 'yellow',
    appDarkTheme: raw.appDarkTheme === 'default' || raw.appDarkTheme === 'justwatch' || raw.appDarkTheme === 'black'
      ? raw.appDarkTheme
      : 'black',
    appLoaderStyle: raw.appLoaderStyle === 'logo-mark' || raw.appLoaderStyle === 'horizontal-logo' || raw.appLoaderStyle === 'play-mark'
      ? raw.appLoaderStyle
      : 'play-mark',
    localNetworkSharingEnabled: Boolean(raw.localNetworkSharingEnabled),
    localNetworkShareToken: raw.localNetworkShareToken && /^\d{6}$/.test(raw.localNetworkShareToken)
      ? raw.localNetworkShareToken
      : createLanShareCode(),
    localNetworkDeviceId: typeof raw.localNetworkDeviceId === 'string' && raw.localNetworkDeviceId.length >= 8
      ? raw.localNetworkDeviceId
      : randomUUID(),
    localNetworkDeviceName: typeof raw.localNetworkDeviceName === 'string' && raw.localNetworkDeviceName.trim()
      ? raw.localNetworkDeviceName.trim().slice(0, 80)
      : os.hostname(),
    localNetworkHmacSecret: typeof raw.localNetworkHmacSecret === 'string' && /^[0-9a-f]{32,}$/i.test(raw.localNetworkHmacSecret)
      ? raw.localNetworkHmacSecret
      : randomBytes(32).toString('hex'),
    localNetworkPairedDevices: Array.isArray(raw.localNetworkPairedDevices)
      ? raw.localNetworkPairedDevices
        .filter((entry): entry is LanPairedDevice =>
          !!entry
          && typeof entry.id === 'string'
          && typeof entry.token === 'string'
          && /^[0-9a-f]{32,}$/i.test(entry.token))
        .map((entry) => ({
          id: entry.id,
          name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 80) : 'Unnamed device',
          token: entry.token,
          createdAt: Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : Date.now(),
          lastSeenAt: Number.isFinite(entry.lastSeenAt) ? Number(entry.lastSeenAt) : Date.now(),
          lastAddress: typeof entry.lastAddress === 'string' ? entry.lastAddress : undefined,
        }))
      : [],
  };
}

export function getMetadataApiKey(settings: AppSettings, providerId: string): string | undefined {
  const normalized = normalizeSettings(settings);
  const id = normalizeProviderId(providerId);
  const directKey = normalized.metadataApiKeys?.[id]?.trim();
  if (directKey) return directKey;

  const legacyField = METADATA_KEY_ALIASES[id];
  return legacyField ? normalized[legacyField]?.trim() || undefined : undefined;
}

export function loadSettings(): AppSettings {
  const databaseSettings = loadSettingsFromDatabase();
  if (databaseSettings) return normalizeSettings(databaseSettings as AppSettings);

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const settings = normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as AppSettings);
      saveSettingsToDatabase(settings as unknown as Record<string, unknown>);
      return settings;
    }
  } catch {}
  return normalizeSettings({});
}

export function saveSettings(settings: AppSettings): void {
  try {
    saveSettingsToDatabase(normalizeSettings(settings) as unknown as Record<string, unknown>);
  } catch {}
}
