import type { AppSettings } from './appContracts.ts';
import type { SettingsPayload } from '../shared/desktopProtocol.ts';

const RENDERER_SETTINGS_WRITE_KEYS = new Set<keyof SettingsPayload>([
  'omdbApiKey',
  'tmdbApiKey',
  'metadataApiKeys',
  'openSubtitlesUsername',
  'openSubtitlesPassword',
  'openSubtitlesLanguages',
  'openSubtitlesAutoDownload',
  'autoSyncIntervalHours',
  'playbackSkipBackSeconds',
  'playbackSkipForwardSeconds',
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
    openSubtitlesUsername: settings.openSubtitlesUsername,
    openSubtitlesPassword: settings.openSubtitlesPassword,
    openSubtitlesLanguages: settings.openSubtitlesLanguages,
    openSubtitlesAutoDownload: settings.openSubtitlesAutoDownload,
    autoSyncIntervalHours: settings.autoSyncIntervalHours,
    playbackSkipBackSeconds: settings.playbackSkipBackSeconds,
    playbackSkipForwardSeconds: settings.playbackSkipForwardSeconds,
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
  };
}

/**
 * Treat renderer input as untrusted at runtime even though the TypeScript API
 * is narrower. In particular, never let a spread operation overwrite LAN
 * identity, pairing hashes, or signing material with extra object keys.
 */
export function sanitizeRendererSettingsPatch(
  patch: Record<string, unknown>,
): Partial<SettingsPayload> {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => RENDERER_SETTINGS_WRITE_KEYS.has(key as keyof SettingsPayload)),
  ) as Partial<SettingsPayload>;
}
