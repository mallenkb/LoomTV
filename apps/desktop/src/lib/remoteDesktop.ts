import type { RemoteLibraryConnection } from '../shared/desktopProtocol';

export type DesktopLibraryMode = 'host' | 'remote';

export type RemoteDesktopSession = RemoteLibraryConnection & {
  selectionRevision?: number;
  selectedProfileId?: string | null;
};

const DESKTOP_MODE_KEY = 'loomtv:desktop-library-mode.v1';
const REMOTE_SESSION_KEY = 'loomtv:shared-library';

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

export function getDesktopLibraryMode(): DesktopLibraryMode | null {
  if (!canUseStorage()) return null;
  const value = window.localStorage.getItem(DESKTOP_MODE_KEY);
  return value === 'host' || value === 'remote' ? value : null;
}

export function setDesktopLibraryMode(mode: DesktopLibraryMode): void {
  if (!canUseStorage()) return;
  window.localStorage.setItem(DESKTOP_MODE_KEY, mode);
  window.dispatchEvent(new CustomEvent('loomtv:desktop-library-mode-changed', { detail: mode }));
}

export function getRemoteDesktopSession(): RemoteDesktopSession | null {
  if (!canUseStorage()) return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REMOTE_SESSION_KEY) || 'null') as RemoteDesktopSession | null;
    if (!parsed?.baseUrl || !parsed.deviceToken || !parsed.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveRemoteDesktopSession(session: RemoteDesktopSession): void {
  if (!canUseStorage()) return;
  window.localStorage.setItem(REMOTE_SESSION_KEY, JSON.stringify(session));
  window.localStorage.setItem('loomtv:last-remote-library', JSON.stringify({
    baseUrl: session.baseUrl,
    connectedAt: Date.now(),
  }));
}

export function updateRemoteDesktopSession(patch: Partial<RemoteDesktopSession>): RemoteDesktopSession | null {
  const current = getRemoteDesktopSession();
  if (!current) return null;
  const next = { ...current, ...patch };
  saveRemoteDesktopSession(next);
  return next;
}

export function clearRemoteDesktopSession(): void {
  if (!canUseStorage()) return;
  window.localStorage.removeItem(REMOTE_SESSION_KEY);
  window.localStorage.removeItem('loomtv:last-remote-library');
}

export function isRemoteDesktopMode(): boolean {
  return getDesktopLibraryMode() === 'remote' && Boolean(getRemoteDesktopSession());
}

export function remoteResourceId(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.searchParams.get('resourceId') || parsed.searchParams.get('mediaId') || value;
  } catch {
    return value;
  }
}
