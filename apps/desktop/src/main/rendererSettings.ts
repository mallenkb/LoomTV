import type { AppSettings } from './appContracts.ts';
import type { SettingsPayload } from '../shared/desktopProtocol.ts';
import { z } from 'zod';

const RENDERER_SETTINGS_WRITE_KEYS: ReadonlySet<string> = new Set([
  'omdbApiKey',
  'tmdbApiKey',
  'metadataApiKeys',
  'metadataOfflineMode',
  'openSubtitlesUsername',
  'openSubtitlesPassword',
  'openSubtitlesLanguages',
  'openSubtitlesAutoDownload',
  'autoSyncIntervalHours',
  'playbackSkipBackSeconds',
  'playbackSkipForwardSeconds',
  'playbackDisplaySleepTimeoutMinutes',
  'localSkipAnalysisEnabled',
  'skipAnalysis',
  'sidebarNavOrder',
  'customFolderNames',
  'appThemeMode',
  'appThemeColor',
  'appDarkTheme',
  'appLoaderStyle',
  'localNetworkSharingEnabled',
]);

const segmentTypes = ['intro', 'recap', 'outro', 'credits', 'preview'] as const;
const durationLimitSchema = z.object({
  minSeconds: z.number().finite().positive(),
  maxSeconds: z.number().finite().positive(),
});
const segmentBooleanRecordSchema = z.object(Object.fromEntries(
  segmentTypes.map((type) => [type, z.boolean()]),
) as Record<(typeof segmentTypes)[number], z.ZodBoolean>);
const durationLimitsSchema = z.object({
  intro: durationLimitSchema,
  recap: durationLimitSchema,
  outro: durationLimitSchema,
  credits: durationLimitSchema,
  preview: durationLimitSchema,
  movieCredits: durationLimitSchema,
});
const skipAnalysisSettingsSchema = z.object({
  enabled: z.boolean(),
  analyzeNewMedia: z.boolean(),
  enabledTypes: segmentBooleanRecordSchema,
  promptTypes: segmentBooleanRecordSchema,
  durationLimits: durationLimitsSchema,
  suppressFirstEpisodeIntro: z.boolean(),
  analyzeSpecials: z.boolean(),
  exclusions: z.object({
    seriesIds: z.array(z.string()),
    movieIds: z.array(z.string()),
    seasons: z.array(z.string()),
    paths: z.array(z.string()),
  }),
  seasonOverrides: z.record(z.string(), z.enum(['full', 'chapter-only', 'providers-only'])),
});

export const rendererSettingsPatchSchema: z.ZodType<SettingsPayload> = z.object({
  omdbApiKey: z.string().optional(),
  tmdbApiKey: z.string().optional(),
  metadataApiKeys: z.record(z.string(), z.string()).optional(),
  metadataOfflineMode: z.boolean().optional(),
  openSubtitlesUsername: z.string().optional(),
  openSubtitlesPassword: z.string().optional(),
  openSubtitlesLanguages: z.string().optional(),
  openSubtitlesAutoDownload: z.boolean().optional(),
  autoSyncIntervalHours: z.number().finite().positive().optional(),
  playbackSkipBackSeconds: z.number().finite().positive().optional(),
  playbackSkipForwardSeconds: z.number().finite().positive().optional(),
  playbackDisplaySleepTimeoutMinutes: z.number().finite().nonnegative().max(480).optional(),
  localSkipAnalysisEnabled: z.boolean().optional(),
  skipAnalysis: skipAnalysisSettingsSchema.optional(),
  sidebarNavOrder: z.array(z.string()).optional(),
  customFolderNames: z.record(z.string(), z.string()).optional(),
  appThemeMode: z.enum(['dark', 'light']).optional(),
  appThemeColor: z.enum(['orange', 'yellow', 'red', 'blue', 'twitch']).optional(),
  appDarkTheme: z.literal('black').optional(),
  appLoaderStyle: z.enum(['play-mark', 'logo-mark', 'horizontal-logo']).optional(),
  localNetworkSharingEnabled: z.boolean().optional(),
  localNetworkShareToken: z.string().optional(),
});

/**
 * Project persisted settings onto the renderer contract. Server-only device
 * identifiers, bearer-token hashes, and HMAC material must never cross IPC or
 * the loopback HTTP compatibility boundary.
 */
export function settingsForRenderer(settings: AppSettings): SettingsPayload {
  return {
    omdbApiKey: settings.omdbApiKey,
    tmdbApiKey: settings.tmdbApiKey,
    metadataApiKeys: settings.metadataApiKeys,
    metadataOfflineMode: settings.metadataOfflineMode,
    openSubtitlesUsername: settings.openSubtitlesUsername,
    openSubtitlesPassword: settings.openSubtitlesPassword,
    openSubtitlesLanguages: settings.openSubtitlesLanguages,
    openSubtitlesAutoDownload: settings.openSubtitlesAutoDownload,
    autoSyncIntervalHours: settings.autoSyncIntervalHours,
    playbackSkipBackSeconds: settings.playbackSkipBackSeconds,
    playbackSkipForwardSeconds: settings.playbackSkipForwardSeconds,
    playbackDisplaySleepTimeoutMinutes: settings.playbackDisplaySleepTimeoutMinutes,
    localSkipAnalysisEnabled: settings.localSkipAnalysisEnabled,
    skipAnalysis: settings.skipAnalysis,
    sidebarNavOrder: settings.sidebarNavOrder,
    customFolderNames: settings.customFolderNames,
    appThemeMode: settings.appThemeMode,
    appThemeColor: settings.appThemeColor,
    appDarkTheme: settings.appDarkTheme,
    appLoaderStyle: settings.appLoaderStyle,
    localNetworkSharingEnabled: settings.localNetworkSharingEnabled,
  };
}

export function settingsPreferencesForRenderer(settings: AppSettings): SettingsPayload {
  return {
    appThemeMode: settings.appThemeMode,
    appThemeColor: settings.appThemeColor,
    appDarkTheme: settings.appDarkTheme,
    appLoaderStyle: settings.appLoaderStyle,
    playbackSkipBackSeconds: settings.playbackSkipBackSeconds,
    playbackSkipForwardSeconds: settings.playbackSkipForwardSeconds,
    playbackDisplaySleepTimeoutMinutes: settings.playbackDisplaySleepTimeoutMinutes,
  };
}

/**
 * Treat renderer input as untrusted at runtime even though the TypeScript API
 * is narrower. In particular, never let a spread operation overwrite LAN
 * identity, pairing hashes, or signing material with extra object keys.
 */
export function sanitizeRendererSettingsPatch(
  patch: unknown,
): Partial<SettingsPayload> {
  const parsed = rendererSettingsPatchSchema.parse(patch);
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => RENDERER_SETTINGS_WRITE_KEYS.has(key)),
  );
}
