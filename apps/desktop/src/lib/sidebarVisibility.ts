import { getDesktopLibraryMode, getRemoteDesktopSession } from '@/lib/remoteDesktop';

function storageKey(profileId?: string): string {
  const host = getDesktopLibraryMode() === 'remote' ? getRemoteDesktopSession()?.baseUrl || 'remote' : 'local';
  return `loomtv:sidebar-visibility:v1:${JSON.stringify([host, profileId || ''])}`;
}

function normalize(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string')
    .map(id => id.trim()).filter(id => Boolean(id) && id.length <= 8192 && id !== 'home' && id !== 'settings'))].slice(0, 256);
}

export function readSidebarVisibility(profileId?: string, persisted?: readonly string[]): string[] {
  if (persisted !== undefined) return normalize(persisted);
  if (!profileId) return [];
  try { return normalize(JSON.parse(window.localStorage.getItem(storageKey(profileId)) || '[]')); }
  catch { return []; }
}

/** Older running hosts can omit this new preference from their response. */
export function rememberSidebarVisibility(profileId: string | undefined, hidden: readonly string[], saved?: readonly string[]): void {
  const expected = normalize(hidden);
  if (saved !== undefined) {
    const actual = normalize(saved);
    if (actual.length !== expected.length || expected.some(id => !actual.includes(id))) {
      throw new Error('Sidebar visibility could not be saved. Try again.');
    }
  }
  if (!profileId) throw new Error('Choose a profile before changing sidebar visibility.');
  try { window.localStorage.setItem(storageKey(profileId), JSON.stringify(expected)); }
  catch {
    if (saved === undefined) throw new Error('Restart LoomTV to save sidebar visibility with the updated host.');
  }
}
