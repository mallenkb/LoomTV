import type { Session } from 'electron';

/**
 * Electron grants every permission request when a session has no handler, so
 * each session gets an explicit default-deny policy. LoomTV only needs
 * fullscreen (the player and framed video pages) and clipboard writes (copy
 * buttons in Settings). Camera, microphone, screen capture, geolocation,
 * notifications, MIDI, HID, USB, serial and the rest stay denied.
 */
const APP_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);
const EMBED_PERMISSIONS = new Set(['fullscreen']);

export interface PermissionPolicyOptions {
  isAppUrl: (url: string) => boolean;
  isEmbeddedVideoUrl: (url: string) => boolean;
}

export function isPermissionAllowed(permission: string, requestingUrl: string | undefined, options: PermissionPolicyOptions): boolean {
  if (!requestingUrl) return false;
  if (options.isAppUrl(requestingUrl)) return APP_PERMISSIONS.has(permission);
  if (options.isEmbeddedVideoUrl(requestingUrl)) return EMBED_PERMISSIONS.has(permission);
  return false;
}

export function installPermissionPolicy(target: Session, options: PermissionPolicyOptions): void {
  target.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl, options));
  });
  target.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => (
    isPermissionAllowed(permission, details.requestingUrl || requestingOrigin, options)
  ));
  target.setDevicePermissionHandler(() => false);
  target.setDisplayMediaRequestHandler((_request, callback) => { callback({}); });
}
