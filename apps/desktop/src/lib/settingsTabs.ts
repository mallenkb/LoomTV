export type SettingsSectionId = 'profiles' | 'library' | 'playback' | 'plugins' | 'live-tv' | 'network' | 'metadata' | 'theme' | 'about';

export function nextSettingsSection(current: SettingsSectionId, requested: SettingsSectionId): SettingsSectionId {
  return current === requested ? current : requested;
}

export function remoteLibraryRefreshIdentity(snapshot: {
  baseUrl?: string | null;
  deviceId?: string | null;
  deviceToken?: string | null;
} | null | undefined): string {
  if (!snapshot?.baseUrl || !snapshot.deviceToken) return '';
  return [snapshot.baseUrl, snapshot.deviceId || '', snapshot.deviceToken].join('\u0000');
}
