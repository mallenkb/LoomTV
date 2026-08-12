import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { app } from 'electron';
import { loadSettingsFromDatabase, saveSettingsToDatabase } from './database';
import { normalizeProviderId } from './metadataKeys';
import type { AppSettings, LanPairedDevice } from './appContracts.ts';
import type { SkipAnalysisSettings } from '../shared/desktopProtocol.ts';
import { z } from 'zod';

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const METADATA_KEY_ALIASES: Record<string, keyof Pick<AppSettings, 'omdbApiKey' | 'tmdbApiKey'>> = {
  omdb: 'omdbApiKey',
  tmdb: 'tmdbApiKey',
};

const skipAnalysisInputSchema = z.object({
  enabled: z.unknown().optional(),
  analyzeNewMedia: z.unknown().optional(),
  enabledTypes: z.record(z.string(), z.unknown()).optional(),
  promptTypes: z.record(z.string(), z.unknown()).optional(),
  durationLimits: z.record(z.string(), z.unknown()).optional(),
  suppressFirstEpisodeIntro: z.unknown().optional(),
  analyzeSpecials: z.unknown().optional(),
  exclusions: z.record(z.string(), z.unknown()).optional(),
  seasonOverrides: z.record(z.string(), z.unknown()).optional(),
});

const settingsInputSchema = z.looseObject({
  appLoaderStyle: z.unknown().optional(),
  appThemeColor: z.unknown().optional(),
  appThemeMode: z.unknown().optional(),
  autoSyncIntervalHours: z.unknown().optional(),
  localNetworkDeviceId: z.unknown().optional(),
  localNetworkDeviceName: z.unknown().optional(),
  localNetworkHmacSecret: z.unknown().optional(),
  localNetworkPairedDevices: z.unknown().optional(),
  localNetworkShareToken: z.unknown().optional(),
  localNetworkSharingEnabled: z.unknown().optional(),
  localSkipAnalysisEnabled: z.unknown().optional(),
  metadataApiKeys: z.unknown().optional(),
  mpvExecutablePath: z.unknown().optional(),
  omdbApiKey: z.unknown().optional(),
  openSubtitlesAutoDownload: z.unknown().optional(),
  openSubtitlesLanguages: z.unknown().optional(),
  openSubtitlesPassword: z.unknown().optional(),
  openSubtitlesUsername: z.unknown().optional(),
  playbackDisplaySleepTimeoutMinutes: z.unknown().optional(),
  playbackSkipBackSeconds: z.unknown().optional(),
  playbackSkipForwardSeconds: z.unknown().optional(),
  sidebarNavOrder: z.unknown().optional(),
  skipAnalysis: skipAnalysisInputSchema.optional(),
  tmdbApiKey: z.unknown().optional(),
});

type SettingsInput = z.output<typeof settingsInputSchema>;

export function createLanShareCode(): string {
  return String(randomInt(100000, 1000000));
}

function normalizePairedDevices(value: unknown): LanPairedDevice[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, LanPairedDevice>();

  for (const entry of value) {
    if (
      !entry
      || entry.securityEpoch !== 2
      || typeof entry.id !== 'string'
      || typeof entry.accessTokenHash !== 'string'
      || !/^[0-9a-f]{64}$/i.test(entry.accessTokenHash)
      || typeof entry.refreshTokenHash !== 'string'
      || !/^[0-9a-f]{64}$/i.test(entry.refreshTokenHash)
    ) continue;
    // LAN approvals are explicit device grants. Keep the refresh credential
    // durable so a paired phone reconnects after restarts until an owner
    // revokes it; the credential itself remains stored only as a hash.
    const device: LanPairedDevice = {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 80) : 'Unnamed device',
      accessTokenHash: entry.accessTokenHash,
      accessTokenExpiresAt: Number(entry.accessTokenExpiresAt) || 0,
      refreshTokenHash: entry.refreshTokenHash,
      refreshTokenExpiresAt: Number.isFinite(Number(entry.refreshTokenExpiresAt))
        && Number(entry.refreshTokenExpiresAt) > 0
        ? Number.MAX_SAFE_INTEGER
        : 0,
      scopes: ['catalog:read', 'media:stream', 'playback:write'],
      securityEpoch: 2,
      createdAt: Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : Date.now(),
      lastSeenAt: Number.isFinite(entry.lastSeenAt) ? Number(entry.lastSeenAt) : Date.now(),
      lastAddress: typeof entry.lastAddress === 'string' ? entry.lastAddress : undefined,
    };
    const current = unique.get(device.id);
    if (!current || device.lastSeenAt >= current.lastSeenAt) unique.set(device.id, device);
  }

  return [...unique.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 64);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
}

function stringList(value: unknown, max = 500): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry.trim().slice(0, 1024)] : []))].slice(0, max);
}

function normalizeSkipAnalysis(raw: SettingsInput): SkipAnalysisSettings {
  const value = raw.skipAnalysis && typeof raw.skipAnalysis === 'object' ? raw.skipAnalysis : undefined;
  const bool = (entry: unknown, fallback: boolean) => typeof entry === 'boolean' ? entry : fallback;
  const limit = (entry: unknown, fallbackMin: number, fallbackMax: number) => {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const minSeconds = boundedNumber(record.minSeconds, fallbackMin, 1, 900);
    const maxSeconds = Math.max(minSeconds, boundedNumber(record.maxSeconds, fallbackMax, minSeconds, 1800));
    return { minSeconds, maxSeconds };
  };
  const enabledTypes = value?.enabledTypes;
  const promptTypes = value?.promptTypes;
  const durationLimits = value?.durationLimits;
  const exclusions = value?.exclusions;
  const rawOverrides = value?.seasonOverrides && typeof value.seasonOverrides === 'object'
    ? value.seasonOverrides as Record<string, unknown>
    : {};
  const seasonOverrides: Record<string, SkipAnalysisSettings['seasonOverrides'][string]> = {};
  for (const [key, mode] of Object.entries(rawOverrides)) {
    if ((mode === 'full' || mode === 'chapter-only' || mode === 'providers-only') && key.length <= 240) {
      seasonOverrides[key] = mode;
    }
  }
  return {
    enabled: bool(value?.enabled, raw.localSkipAnalysisEnabled !== false),
    analyzeNewMedia: bool(value?.analyzeNewMedia, true),
    enabledTypes: {
      intro: bool(enabledTypes?.intro, true),
      recap: bool(enabledTypes?.recap, true),
      outro: bool(enabledTypes?.outro, true),
      credits: bool(enabledTypes?.credits, true),
      preview: bool(enabledTypes?.preview, true),
    },
    promptTypes: {
      intro: bool(promptTypes?.intro, true),
      recap: bool(promptTypes?.recap, true),
      outro: bool(promptTypes?.outro, true),
      credits: bool(promptTypes?.credits, true),
      preview: bool(promptTypes?.preview, true),
    },
    durationLimits: {
      intro: limit(durationLimits?.intro, 15, 180),
      recap: limit(durationLimits?.recap, 15, 120),
      outro: limit(durationLimits?.outro, 15, 300),
      credits: limit(durationLimits?.credits, 15, 300),
      preview: limit(durationLimits?.preview, 15, 120),
      movieCredits: limit(durationLimits?.movieCredits, 15, 900),
    },
    suppressFirstEpisodeIntro: bool(value?.suppressFirstEpisodeIntro, false),
    analyzeSpecials: bool(value?.analyzeSpecials, false),
    exclusions: {
      seriesIds: stringList(exclusions?.seriesIds),
      movieIds: stringList(exclusions?.movieIds),
      seasons: stringList(exclusions?.seasons),
      paths: stringList(exclusions?.paths),
    },
    seasonOverrides,
  };
}

function normalizeSettings(input: unknown): AppSettings {
  const result = settingsInputSchema.safeParse(input);
  const raw: SettingsInput = result.success ? result.data : {};
  const metadataApiKeys: Record<string, string> = {};
  const rawKeys = raw.metadataApiKeys && typeof raw.metadataApiKeys === 'object' && !Array.isArray(raw.metadataApiKeys)
    ? raw.metadataApiKeys
    : {};
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

  if (typeof raw.omdbApiKey === 'string' && raw.omdbApiKey.trim()) metadataApiKeys.omdb = raw.omdbApiKey.trim();
  if (typeof raw.tmdbApiKey === 'string' && raw.tmdbApiKey.trim()) metadataApiKeys.tmdb = raw.tmdbApiKey.trim();

  const skipAnalysis = normalizeSkipAnalysis(raw);
  const mpvExecutablePath = typeof raw.mpvExecutablePath === 'string' && raw.mpvExecutablePath.trim()
    ? path.resolve(raw.mpvExecutablePath.trim())
    : undefined;
  return {
    ...raw,
    mpvExecutablePath,
    omdbApiKey: metadataApiKeys.omdb || '',
    tmdbApiKey: metadataApiKeys.tmdb || '',
    metadataApiKeys,
    openSubtitlesUsername: typeof raw.openSubtitlesUsername === 'string'
      ? raw.openSubtitlesUsername.trim().slice(0, 120)
      : '',
    openSubtitlesPassword: typeof raw.openSubtitlesPassword === 'string'
      ? raw.openSubtitlesPassword.trim()
      : '',
    openSubtitlesLanguages: typeof raw.openSubtitlesLanguages === 'string' && raw.openSubtitlesLanguages.trim()
      ? raw.openSubtitlesLanguages.trim().toLowerCase()
      : 'en',
    openSubtitlesAutoDownload: Boolean(raw.openSubtitlesAutoDownload),
    autoSyncIntervalHours: Number.isFinite(autoSyncIntervalHours) && autoSyncIntervalHours > 0
      ? autoSyncIntervalHours
      : 12,
    playbackSkipBackSeconds: Number.isFinite(Number(raw.playbackSkipBackSeconds)) && Number(raw.playbackSkipBackSeconds) > 0
      ? Number(raw.playbackSkipBackSeconds)
      : 10,
    playbackSkipForwardSeconds: Number.isFinite(Number(raw.playbackSkipForwardSeconds)) && Number(raw.playbackSkipForwardSeconds) > 0
      ? Number(raw.playbackSkipForwardSeconds)
      : 15,
    playbackDisplaySleepTimeoutMinutes: Number.isFinite(Number(raw.playbackDisplaySleepTimeoutMinutes))
      ? Math.max(0, Math.min(480, Math.round(Number(raw.playbackDisplaySleepTimeoutMinutes))))
      : 0,
    localSkipAnalysisEnabled: skipAnalysis.enabled,
    skipAnalysis,
    sidebarNavOrder,
    appThemeMode: raw.appThemeMode === 'light' ? 'light' : 'dark',
    appThemeColor: raw.appThemeColor === 'yellow' || raw.appThemeColor === 'red' || raw.appThemeColor === 'blue' || raw.appThemeColor === 'orange' || raw.appThemeColor === 'twitch'
      ? raw.appThemeColor
      : 'yellow',
    appDarkTheme: 'black',
    appLoaderStyle: raw.appLoaderStyle === 'logo-mark' || raw.appLoaderStyle === 'horizontal-logo' || raw.appLoaderStyle === 'play-mark'
      ? raw.appLoaderStyle
      : 'play-mark',
    localNetworkSharingEnabled: Boolean(raw.localNetworkSharingEnabled),
    localNetworkShareToken: typeof raw.localNetworkShareToken === 'string' && /^\d{6}$/.test(raw.localNetworkShareToken)
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
    localNetworkPairedDevices: normalizePairedDevices(raw.localNetworkPairedDevices),
    localNetworkSecurityEpoch: 2,
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
  if (databaseSettings) {
    const normalized = normalizeSettings(databaseSettings);
    if (Number(databaseSettings.localNetworkSecurityEpoch) !== 2) {
      saveSettingsToDatabase({ ...normalized });
    }
    return normalized;
  }

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const settings = normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')));
      saveSettingsToDatabase({ ...settings });
      try {
        fs.rmSync(SETTINGS_FILE);
      } catch (error) {
        console.warn('[settings] Legacy settings were migrated but could not be removed:', error);
      }
      return settings;
    }
  } catch (error) {
    console.error('[settings] Failed to migrate legacy settings:', error);
  }
  const initialSettings = normalizeSettings({});
  saveSettingsToDatabase({ ...initialSettings });
  return initialSettings;
}

export function saveSettings(settings: AppSettings): void {
  saveSettingsToDatabase({ ...normalizeSettings(settings) });
}
